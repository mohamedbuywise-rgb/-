import { supabase } from '../../lib/supabaseClient.js';
import { migrateStandaloneData } from '../../lib/dashboardAuth.js';

// POST /api/auth-by-code { code, standalone? }
// يربط جلسة Supabase Auth الحالية بحساب Telegram صاحب كود /link.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return res.status(401).json({ ok: false, error: 'لازم تسجل دخول الأول.' });
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ ok: false, error: 'نورت من تاني! جلستك خلصت، سجّل دخولك تاني عشان نكمل سوا.' });
    }

    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ ok: false, error: 'اكتب كود الربط المكوّن من 6 أرقام.' });
    }

    const { data: linkCode, error: codeError } = await supabase
      .from('link_codes')
      .select('code, telegram_user_id, expires_at, used')
      .eq('code', code)
      .maybeSingle();

    if (codeError) {
      console.error('auth-by-code lookup error:', JSON.stringify(codeError));
      return res.status(500).json({ ok: false, error: 'حصل خطأ وإحنا بنراجع كود الربط.' });
    }

    if (!linkCode || linkCode.used || new Date(linkCode.expires_at).getTime() <= Date.now()) {
      return res.status(400).json({ ok: false, error: 'كود الربط غير صحيح أو انتهت صلاحيته. اطلب كود جديد من البوت.' });
    }

    const authUserId = userData.user.id;
    const telegramUserId = linkCode.telegram_user_id;

    const { data: existingAuthLink, error: existingAuthError } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (existingAuthError) throw existingAuthError;
    if (existingAuthLink && String(existingAuthLink.telegram_user_id) !== String(telegramUserId)) {
      return res.status(409).json({ ok: false, error: 'الحساب ده مربوط بحساب تليجرام مختلف بالفعل.' });
    }

    const { data: existingTelegramLink, error: existingTelegramError } = await supabase
      .from('user_links')
      .select('auth_user_id')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();
    if (existingTelegramError) throw existingTelegramError;
    if (existingTelegramLink && existingTelegramLink.auth_user_id !== authUserId) {
      // امتلاك كود /link من Telegram يثبت أن المستخدم يملك الحساب؛ لذلك نسمح
      // بنقل الربط إلى حساب الموقع الحالي. بيانات المصاريف/الديون مرتبطة بـTelegram
      // وستظل محفوظة، بينما الحساب القديم يفقد الوصول للوحة حتى لا يبقى الربط مزدوجًا.
      const { error: transferError } = await supabase
        .from('user_links')
        .delete()
        .eq('auth_user_id', existingTelegramLink.auth_user_id)
        .eq('telegram_user_id', telegramUserId);
      if (transferError) throw transferError;
    }

    const { error: linkError } = await supabase
      .from('user_links')
      .upsert(
        { auth_user_id: authUserId, telegram_user_id: telegramUserId, linked_at: new Date().toISOString() },
        { onConflict: 'auth_user_id' }
      );
        if (linkError) {
      console.error('auth-by-code link insert error:', JSON.stringify(linkError));
      return res.status(500).json({ ok: false, error: 'حصل خطأ وإحنا بنربط الحساب. جرب تاني.' });
    }

    // لو الحساب استخدم الداش قبل الربط، ننقل سجلاته القديمة للمعرف الجديد
    // حتى يفضل كل شيء ظاهرًا بعد الربط بدل ما يبدأ العميل من شاشة فاضية.
    await migrateStandaloneData(authUserId, telegramUserId);

    // تحديث مشروط يمنع استخدام نفس الكود مرتين في سباق طلبين متزامنين.
    const { data: markedRows, error: markError } = await supabase
      .from('link_codes')
      .update({ used: true })
      .eq('code', code)
      .eq('used', false)
      .select('code');
    if (markError) throw markError;
    if (!markedRows?.length) {
      // الربط تم، لكن الطلب المتزامن سبقنا؛ نرجع نجاحًا idempotent للمستخدم الصحيح.
      return res.status(200).json({ ok: true, alreadyLinked: true });
    }

    return res.status(200).json({ ok: true, relinked: Boolean(existingTelegramLink && existingTelegramLink.auth_user_id !== authUserId) });
  } catch (err) {
    console.error('auth-by-code error:', err);
    return res.status(500).json({ ok: false, error: 'حصل خطأ في السيرفر. جرب تاني.' });
  }
}
