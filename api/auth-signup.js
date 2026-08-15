import { supabase } from '../lib/supabaseClient.js';

// ============ POST /api/auth-signup ============
// تسجيل مباشر بإيميل + كلمة سر — من غير تليجرام خالص.
// الحساب بيتعمل هنا بالـ service role مع email_confirm: true عشان يتفعّل على طول
// من غير ما نحتاج نبعت إيميل تأكيد فعلي (نفس فلسفة "دخول سهل" اللي كانت متبعة مع تليجرام).
//
// الفرونت إند بعد الرد ده بيعمل sb.auth.signInWithPassword بنفس الإيميل والباسورد
// عشان ياخد جلسة فعلية (access_token/refresh_token) — مفيش داعي نولّدها هنا.
//
// ملحوظة مهمة عن telegram_user_id:
// كل جداول البيانات (expenses/debts/...) متبنية على telegram_user_id مش auth_user_id،
// وكمان زرار "سجّل مصروفك" بالصوت/اليد في الداشبورد (api/record-expense-voice.js) بيرفض
// يشتغل من غير صف في user_links. عشان كده، بدل ما نسيب المستخدم بمعرّف تليجرام حقيقي،
// بنولّدله معرّف "وهمي" (رقم سالب — أرقام تليجرام الحقيقية دايمًا موجبة فمفيش تعارض أبدًا)
// ونربطه بيه في user_links على طول، فيقدر يسجّل مصاريفه من الداشبورد مباشرة من غير أي
// حاجة تانية. لو ربط تليجرام حقيقي بعدين (ميزة قادمة)، بيتم استبدال الربط ده بالحقيقي.
//
// Body: { name, email, password }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'اكتب إيميل صحيح.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'كلمة السر لازم تكون 6 حروف/أرقام على الأقل.' });
    }

    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: name || 'مستخدم دبّر',
        auth_source: 'direct',
      },
    });

    if (createError) {
      const msg = String(createError.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        return res.status(409).json({ error: 'الإيميل ده مسجل قبل كده. جرب تسجّل دخول بدل ما تعمل حساب جديد.' });
      }
      console.error('auth-signup createUser error:', createError);
      return res.status(500).json({ error: 'حصل خطأ في عمل الحساب، جرب تاني.' });
    }

    if (!created?.user) {
      return res.status(500).json({ error: 'حصل خطأ في عمل الحساب، جرب تاني.' });
    }

    // صف في profiles (شغّل sql/profiles.sql على Supabase لو الجدول لسه مش موجود)
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: created.user.id,
      full_name: name || 'مستخدم دبّر',
      email,
    });
    if (profileError) {
      // مش بنفشّل التسجيل بسببها — الحساب في Auth اتعمل صح، ده بس تفصيل ثانوي
      console.error('auth-signup profiles upsert error:', profileError);
    }

    // ---- معرّف تليجرام وهمي (سالب) + ربطه بالحساب، عشان تسجيل المصاريف يشتغل على طول ----
    const syntheticTelegramId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));

    const { error: usersError } = await supabase.from('users').upsert(
      {
        telegram_user_id: syntheticTelegramId,
        chat_id: 0, // 0 = مفيش تليجرام حقيقي؛ أي كود بيبعت رسائل تليجرام بيتخطى القيمة دي أصلًا (falsy)
        last_seen_at: new Date().toISOString(),
        is_active: true,
      },
      { onConflict: 'telegram_user_id' }
    );
    if (usersError) console.error('auth-signup users upsert error:', usersError);

    const { error: linkInsertError } = await supabase.from('user_links').insert({
      auth_user_id: created.user.id,
      telegram_user_id: syntheticTelegramId,
    });
    if (linkInsertError) {
      // مش هنفشّل التسجيل بسببها، بس هنسجّلها — الحساب اتعمل والمستخدم يقدر يدخل ويسجّل دخول،
      // لو حصلت المشكلة دي هيشوف داشبورد فاضي ومنعرضش عليه زرار تسجيل المصروف لحد ما يترابط.
      console.error('auth-signup user_links insert error:', linkInsertError);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('auth-signup error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرب تاني.' });
  }
}
