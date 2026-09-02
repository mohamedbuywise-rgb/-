// backend/api-handlers/bank-accounts.js
// إدارة ربط "البنوك والمحافظ" (ميزة استيراد SMS تلقائي). بيتستخدم من تبويب "حسابي".
//
// GET  ?route=bank-accounts             -> يرجع التوكن الخاص بالمستخدم + حالة التفعيل + قايمة البنوك المدعومة
// POST ?route=bank-accounts action=toggle -> يفعّل/يوقف الاستقبال التلقائي

import { supabase } from '../../lib/supabaseClient.js';
import { EGYPT_BANK_WALLET_SENDERS } from '../../lib/bank-senders.js';

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
    const { data, error } = await supabase
      .from('profiles')
      .select('sms_webhook_token, sms_webhook_enabled')
      .eq('id', user.id)
      .maybeSingle();
    if (error || !data) return res.status(500).json({ ok: false, error: 'تعذر جلب البيانات.' });

    const baseUrl = process.env.PUBLIC_BASE_URL || 'https://www.dabbar.online';
    return res.status(200).json({
      ok: true,
      token: data.sms_webhook_token,
      enabled: data.sms_webhook_enabled,
      banks: EGYPT_BANK_WALLET_SENDERS.map((b) => ({ key: b.key, label: b.label })),
      webhookUrl: `${baseUrl}/api/sms-webhook`,
      // ============ تطبيق دبّر SMS Helper (APK) — حل MacroDroid ============
      // apkDownloadUrl: ملف الـ APK الموقّع، بيتحدّث تلقائي مع كل إصدار جديد (شوف
      // android-helper/.github/workflows/build-apk.yml — بيبني وينشر النسخة الأحدث
      // على GitHub Releases، ولازم يتحدّث الرابط هنا لو غيّرت اسم المستودع/التاجات).
      apkDownloadUrl: process.env.SMS_HELPER_APK_URL || 'https://github.com/dabbar-app/dabbar/releases/latest/download/dabbar-sms-helper.apk',
      // deepLink: التوكن مدموج فيه عشان التطبيق يملأه أوتوماتيك أول ما يتفتح من الرابط ده
      deepLink: `dabbar://setup?token=${data.sms_webhook_token}`,
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
