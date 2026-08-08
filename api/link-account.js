import { supabase } from '../lib/supabaseClient.js';

// ============ POST /api/link-account ============
// بيتنادى من صفحة الداشبورد بعد ما المستخدم يكتب الكود اللي وصله من البوت (/link).
// Body: { code: "123456" }
// Header: Authorization: Bearer <supabase access token بتاع الجلسة الحالية>
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });
    }

    // بنتحقق من الـ JWT بتاع Supabase Auth عشان نعرف مين المستخدم فعلاً
    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    }
    const authUserId = userData.user.id;

    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'اكتب الكود المكوّن من 6 أرقام اللي وصلك من البوت.' });
    }

    const { data: linkCode, error: codeError } = await supabase
      .from('link_codes')
      .select('*')
      .eq('code', code)
      .eq('used', false)
      .maybeSingle();

    if (codeError || !linkCode) {
      return res.status(400).json({ error: 'الكود غلط أو اتستخدم قبل كده.' });
    }
    if (new Date(linkCode.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'الكود ده منتهي. ابعت /link في البوت تاني عشان تاخد كود جديد.' });
    }

    // لو حساب الموقع ده كان مربوط بحساب تليجرام تاني قبل كده، أو حساب التليجرام ده كان مربوط
    // بحساب موقع تاني، بنشيل الربط القديم عشان نضمن كل حساب موقع = حساب تليجرام واحد بس.
    await supabase.from('user_links').delete().eq('auth_user_id', authUserId);
    await supabase.from('user_links').delete().eq('telegram_user_id', linkCode.telegram_user_id);

    const { error: linkError } = await supabase.from('user_links').insert({
      auth_user_id: authUserId,
      telegram_user_id: linkCode.telegram_user_id,
    });

    if (linkError) {
      console.error('link insert error:', linkError);
      return res.status(500).json({ error: 'حصل خطأ في الربط، جرب تاني.' });
    }

    await supabase.from('link_codes').update({ used: true }).eq('code', code);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('link-account error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرب تاني.' });
  }
}
