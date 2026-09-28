import { SUBSCRIPTION_SMS_WEBHOOK_TOKEN } from '../../lib/config.js';
import { ingestOwnerSubscriptionSms, isSubscriptionSmsAuthorized } from '../../lib/subscriptionPayments.js';

function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = String(req.body || '');
  try { return JSON.parse(raw); } catch { return {}; }
}

// POST /api/subscription-sms-webhook
// يُستخدم فقط من هاتف صاحب الحساب المستقبِل، بتوكن منفصل عن توكنات المستخدمين.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = readBody(req);
  const token = String(body.token || req.headers['x-subscription-sms-token'] || '');
  const sender = String(body.sender || body.from || body.bank || '').trim();
  const text = String(body.text || body.message || '').trim();
  if (!SUBSCRIPTION_SMS_WEBHOOK_TOKEN || !isSubscriptionSmsAuthorized({ token, sender, text })) {
    return res.status(401).json({ ok: false, error: 'غير مصرح.' });
  }
  if (!text) return res.status(400).json({ ok: false, error: 'نص الرسالة مطلوب.' });
  try {
    const result = await ingestOwnerSubscriptionSms({ sender, text });
    return res.status(result.accepted ? 200 : 422).json({ ok: result.accepted, ...result });
  } catch (error) {
    console.error('subscription-sms-webhook error:', error);
    return res.status(500).json({ ok: false, error: 'تعذر معالجة رسالة البنك.' });
  }
}
