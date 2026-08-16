import { createClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/config.js';

// عميل بالـ anon key، مستخدم بس عشان نحوّل magic-link (اللي بنولّده بالـ service role) لجلسة
// فعلية (access_token/refresh_token). لازم يكون عميل منفصل عن `supabase` (اللي بيستخدم service
// role key) لأن verifyOtp بيتصرف كأنه "طلب من المتصفح" مش عملية إدارية.
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============ POST /api/auth-by-code ============
// الخطوة الوحيدة المطلوبة من المستخدم في شاشة "اربط حسابك بـ دبّر" الجديدة:
// يفتح البوت، ياخد كود الربط من 6 أرقام، ويكتبه هنا. الـ endpoint ده بيعمل 3 حاجات مرة واحدة:
//   1) لو أول مرة: بيعمل حساب Supabase Auth تلقائي (إيميل صناعي مبني على الـ telegram_user_id،
//      مفيش باسورد يدوي خالص) + صف في profiles باسمه من تليجرام.
//   2) لو حساب موجود قبل كده لنفس telegram_user_id: بيستخدمه هو بالظبط (مفيش تكرار حسابات).
//   3) بيربط (أو يعيد تأكيد الربط في) جدول user_links، ويرجّع session جاهزة للمتصفح
//      (access_token/refresh_token) عشان الداشبورد يشتغل على طول من غير أي خطوة تسجيل دخول تانية.
//
// Body: { code: "123456" }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'اكتب الكود المكوّن من 6 أرقام اللي وصلك من دبّر على تليجرام.' });
    }

    // ---- 1) نتحقق من الكود ----
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
      return res.status(400).json({ error: 'الكود ده منتهي. افتح دبّر على تليجرام تاني وابعتله /link عشان تاخد كود جديد.' });
    }

    const telegramUserId = linkCode.telegram_user_id;
    const firstName = linkCode.telegram_first_name || null;
    // إيميل صناعي ثابت لكل telegram_user_id — المستخدم مش شايفه ومش بيدخله بنفسه أبدًا،
    // هو بس معرّف داخلي فريد يربط حساب Supabase Auth بحساب تليجرام بتاعه.
    const syntheticEmail = `tg${telegramUserId}@dabbar-users.app`;

    // ---- 2) هل حساب تليجرام ده مربوط قبل كده بحساب موقع؟ لو أيوه، بنستخدمه هو بالظبط ----
    const { data: existingLink } = await supabase
      .from('user_links')
      .select('auth_user_id')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();

    let authUserId = existingLink?.auth_user_id || null;

    if (!authUserId) {
      // ---- 3) أول مرة: نعمل حساب Supabase Auth جديد تلقائي (من غير باسورد يدوي) ----
      const { data: created, error: createError } = await supabase.auth.admin.createUser({
        email: syntheticEmail,
        email_confirm: true,
        user_metadata: {
          full_name: firstName || 'مستخدم دبّر',
          telegram_user_id: telegramUserId,
          auth_source: 'telegram',
        },
      });

      if (createError || !created?.user) {
        console.error('auth-by-code createUser error:', createError);
        return res.status(500).json({ error: 'حصل خطأ في عمل الحساب، جرب تاني.' });
      }
      authUserId = created.user.id;

      // بيتسجل صف في جدول profiles (شغّل sql/profiles.sql على Supabase عشان الجدول ده يتعمل)
      await supabase.from('profiles').upsert({
        id: authUserId,
        full_name: firstName || 'مستخدم دبّر',
        email: syntheticEmail,
      });
    }

    // ---- 4) نربط (أو نأكد ربط) حساب الموقع بحساب تليجرام ----
    // بنشيل أي ربط قديم لنفس الحسابين الاتنين الأول عشان نضمن كل حساب موقع = حساب تليجرام واحد بس.
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

    await supabase.from('link_codes').update({ used: true }).eq('code', code);

    // ---- 5) نولّد جلسة فعلية (access_token/refresh_token) للحساب ده من غير باسورد ----
    // بنستخدم generateLink (بالـ service role) لعمل magic-link، وبعدين نحوّله لجلسة حقيقية
    // بـ verifyOtp (بالـ anon key). المستخدم مش بيشوف أي إيميل ولا لينك — كله بيحصل في السيرفر.
    const { data: linkData, error: genError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: syntheticEmail,
    });

    if (genError || !linkData?.properties?.hashed_token) {
      console.error('auth-by-code generateLink error:', genError);
      return res.status(500).json({ error: 'اتربط حسابك بنجاح بس حصلت مشكلة في فتح الجلسة، جرب تدخل تاني.' });
    }

    const { data: verifyData, error: verifyError } = await supabaseAnon.auth.verifyOtp({
      type: 'magiclink',
      token_hash: linkData.properties.hashed_token,
    });

    if (verifyError || !verifyData?.session) {
      console.error('auth-by-code verifyOtp error:', verifyError);
      return res.status(500).json({ error: 'اتربط حسابك بنجاح بس حصلت مشكلة في فتح الجلسة، جرب تدخل تاني.' });
    }

    return res.status(200).json({
      ok: true,
      session: {
        access_token: verifyData.session.access_token,
        refresh_token: verifyData.session.refresh_token,
      },
    });
  } catch (err) {
    console.error('auth-by-code error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرب تاني.' });
  }
}
