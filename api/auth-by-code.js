import { supabase } from '../lib/supabaseClient.js';

// ============ POST /api/auth-by-code ============
// دلوقتي التسجيل بقى بإيميل/باسورد عادي (شوف dabbar-onboarding.html)، والـ endpoint ده
// بقى شغله الوحيد إنه "يربط" حساب الموقع بتاع المستخدم (اللي هو مسجل دخول فيه فعلاً)
// بحساب تليجرام بتاعه، عن طريق كود الـ 6 أرقام اللي بيجيله من البوت.
//
// لازم Header: Authorization: Bearer <supabase access token> (جلسة المستخدم بعد ما يسجل دخول
// بالإيميل/الباسورد من صفحة الأونبوردنج). من غيره منعرفش نربط الكود بحساب مين.
//
// Body: { code: "123456" }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ---- 0) نتأكد إن فيه مستخدم مسجل دخول فعلاً (بالإيميل/الباسورد) قبل أي حاجة تانية ----
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'لازم تسجل دخول بالإيميل والباسورد الأول.' });
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    }
    const authUserId = userData.user.id;

    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'اكتب الكود المكوّن من 6 أرقام اللي وصلك من دبّر على تليجرام.' });
    }

    // ---- 0.5) التثبيت الإجباري: على كل الأجهزة من غير استثناء، لازم الصفحة تكون فعليًا
    // standalone (يعني اتفتحت من الأيقونة بعد تثبيت حقيقي على الشاشة الرئيسية)، مش بس
    // تصميميًا في الفرونت إند — عشان محدش يقدر يلف على الشرط ده من الـ DevTools أو بتعديل
    // الكود في المتصفح.
    const isStandalone = req.body?.standalone === true;
    if (!isStandalone) {
      return res.status(400).json({
        error: 'لازم تثبّت "دبّر" على شاشتك الرئيسية وتفتحه من الأيقونة عشان تقدر تكمل الربط.',
      });
    }

    // ---- 1) نحجز الكود فورًا (atomic claim) قبل أي حاجة تانية ----
    // ده بيمنع الـ race condition اللي ممكن تحصل لو طلبين وصلوا بنفس الكود في نفس اللحظة
    // (double-submit من تاتش مزدوج على الموبايل مثلًا): أول طلب بيوصل هو اللي بياخد الصف الفعلي
    // من الـ update ده (شرط used=false)، وأي طلب تاني بنفس الكود هيلاقي 0 صفوف اتأثرت ويترفض
    // على طول من غير ما يعمل أي ربط.
    const { data: claimedRows, error: claimError } = await supabase
      .from('link_codes')
      .update({ used: true })
      .eq('code', code)
      .eq('used', false)
      .select('*');

    if (claimError) {
      console.error('auth-by-code claim error:', claimError);
      return res.status(500).json({ error: 'حصل خطأ، جرب تاني.' });
    }
    if (!claimedRows || claimedRows.length === 0) {
      return res.status(400).json({ error: 'الكود غلط أو اتستخدم قبل كده.' });
    }
    const linkCode = claimedRows[0];

    if (new Date(linkCode.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'الكود ده منتهي. افتح دبّر على تليجرام تاني وابعتله /link عشان تاخد كود جديد.' });
    }

    const telegramUserId = linkCode.telegram_user_id;

    // ---- 2) نربط (أو نأكد ربط) حساب الموقع (auth_user_id بتاع المستخدم المسجل دخول دلوقتي)
    // بحساب تليجرام ده. بنشيل أي ربط قديم لنفس الحسابين الاتنين الأول عشان نضمن كل حساب
    // موقع = حساب تليجرام واحد بس، والعكس (كل حساب تليجرام مربوط بحساب موقع واحد بس) ----
    await supabase.from('user_links').delete().eq('auth_user_id', authUserId);
    await supabase.from('user_links').delete().eq('telegram_user_id', telegramUserId);

    const { error: linkError } = await supabase.from('user_links').insert({
      auth_user_id: authUserId,
      telegram_user_id: telegramUserId,
    });

    if (linkError) {
      console.error('auth-by-code link insert error:', linkError);
      return res.status(500).json({ error: 'حصل خطأ في الربط، جرب تاني.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('auth-by-code error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرب تاني.' });
  }
}
