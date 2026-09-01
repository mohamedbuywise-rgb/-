// backend/api-handlers/bank-accounts.js
// إدارة ربط "البنوك والمحافظ" (ميزة استيراد SMS تلقائي). بيتستخدم من تبويب "حسابي".
//
// GET  ?route=bank-accounts             -> يرجع التوكن الخاص بالمستخدم + حالة التفعيل + قايمة البنوك المدعومة
// POST ?route=bank-accounts action=toggle -> يفعّل/يوقف الاستقبال التلقائي

import { supabase } from '../../lib/supabaseClient.js';
import { EGYPT_BANK_WALLET_SENDERS } from '../../lib/bank-senders.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MACRO_TEMPLATE_PATH = path.join(__dirname, '../../assets/dabbar-sms-macro-template.macro');

async function requireAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return null;
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user) return null;
  return data.user;
}

export default async function handler(req, res) {
  const user = await requireAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'محتاج تسجيل دخول.' });

  // بنضمن وجود صف profile (لو أول مرة) عشان يتولد التوكن تلقائي بالـ default
  await supabase.from('profiles').upsert({ id: user.id }, { onConflict: 'id', ignoreDuplicates: true });

  if (req.method === 'GET') {
    const wantsMacroFile = String(req.query?.action || '') === 'macro-file';

    const { data, error } = await supabase
      .from('profiles')
      .select('sms_webhook_token, sms_webhook_enabled')
      .eq('id', user.id)
      .maybeSingle();
    if (error || !data) return res.status(500).json({ ok: false, error: 'تعذر جلب البيانات.' });

    if (wantsMacroFile) {
      // بنولّد ملف .macro جاهز للاستيراد المباشر في MacroDroid، بالتوكن الحقيقي بتاع المستخدم
      // مكان "PASTE_YOUR_TOKEN_HERE" في القالب اللي اتعمل واتاختبر يدويًا.
      let template;
      try {
        template = readFileSync(MACRO_TEMPLATE_PATH, 'utf8');
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'قالب الـ Macro مش موجود على السيرفر.' });
      }
      const personalized = template.replaceAll('PASTE_YOUR_TOKEN_HERE', data.sms_webhook_token);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="dabbar-sms-import.macro"');
      return res.status(200).send(personalized);
    }

    return res.status(200).json({
      ok: true,
      token: data.sms_webhook_token,
      enabled: data.sms_webhook_enabled,
      banks: EGYPT_BANK_WALLET_SENDERS.map((b) => ({ key: b.key, label: b.label })),
      webhookUrl: `${process.env.PUBLIC_BASE_URL || 'https://www.dabbar.online'}/api/sms-webhook`,
    });
  }

  if (req.method === 'POST') {
    const { enabled } = req.body || {};
    const { error } = await supabase
      .from('profiles')
      .update({ sms_webhook_enabled: Boolean(enabled) })
      .eq('id', user.id);
    if (error) return res.status(500).json({ ok: false, error: 'تعذر تحديث الحالة.' });
    return res.status(200).json({ ok: true, enabled: Boolean(enabled) });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
