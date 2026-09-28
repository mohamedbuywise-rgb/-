// backend/api-handlers/support-message.js
// بيستقبل رسالة دعم مبعوتة من الموقع (مثلاً كارت "لسه مش شغال" في صفحة البنوك والمحافظ)
// وبيحوّلها فورًا لتليجرام الأدمن (ADMIN_TELEGRAM_ID)، مع أي سياق مفيد (المستخدم، والمصدر).
//
// POST ?route=support-message   Body: { message, source }
// محتاج تسجيل دخول (Bearer token بتاع Supabase)، نفس أسلوب bank-accounts.js.

import { supabase } from '../../lib/supabaseClient.js';
import { sendTelegramMessage } from '../../lib/telegram.js';
import { ADMIN_TELEGRAM_ID } from '../../lib/config.js';

async function requireAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return null;
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user) return null;
  return data.user;
}

// مصادر مسموح بيها فقط (عشان محدش يستخدم الـ endpoint ده كوسيلة بعت رسائل حرة لغير سياقها)
const ALLOWED_SOURCES = {
  'bank-accounts-troubleshoot': '🏦 مشكلة في ربط البنوك والمحافظ (SMS)',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const user = await requireAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'محتاج تسجيل دخول.' });

  const { message, source } = req.body || {};
  const cleanMessage = String(message || '').trim().slice(0, 1000);
  const sourceLabel = ALLOWED_SOURCES[source] || '💬 رسالة دعم من الموقع';

  if (!cleanMessage) {
    return res.status(400).json({ ok: false, error: 'اكتب رسالتك الأول.' });
  }

  if (!ADMIN_TELEGRAM_ID) {
    console.error('support-message: ADMIN_TELEGRAM_ID غير مضبوط في Environment Variables');
    return res.status(500).json({ ok: false, error: 'الخدمة مش مظبوطة صح دلوقتي، جرب تاني بعدين.' });
  }

  // بنجيب حساب تليجرام المرتبط (لو موجود) عشان الأدمن يعرف يرد عليه مباشرة من هناك
  const { data: link } = await supabase
    .from('user_links')
    .select('telegram_user_id')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  const identityLine = link?.telegram_user_id
    ? `🆔 تليجرام: <code>${link.telegram_user_id}</code>`
    : `📧 إيميل: ${user.email || 'غير معروف'}`;

  const caption =
    `${sourceLabel}\n\n` +
    `${identityLine}\n\n` +
    `✉️ الرسالة:\n${cleanMessage}`;

  try {
    await sendTelegramMessage(ADMIN_TELEGRAM_ID, caption, 'HTML');
  } catch (err) {
    console.error('support-message: failed to send to admin', err);
    return res.status(500).json({ ok: false, error: 'حصل خطأ في إرسال الرسالة، جرب تاني.' });
  }

  return res.status(200).json({ ok: true });
}
