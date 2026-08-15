import { createClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient.js';
import { sendTelegramMessage, sendTelegramPhoto, setBotCommands, setBotMenuButton } from '../lib/telegram.js';
import { getChatIdByUserId } from '../lib/users.js';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  ADMIN_TELEGRAM_ID,
  SUBSCRIPTION_PRICE_EGP,
  GUIDE_URL,
} from '../lib/config.js';

// ============================================================================
// api/misc.js — دمج 7 endpoints بسيطة في Serverless Function واحدة بس
// ============================================================================
// السبب: خطة Vercel Hobby بتسمح بـ 12 Serverless Function كحد أقصى، وكان عندنا
// 14 ملف في api/. الملف ده بيجمع الـ endpoints الخفيفة (مفيهاش استخدام تقيل زي
// PDF أو صوت) في مكان واحد ويفرّق بينهم بـ query parameter اسمه action:
//
//   POST /api/misc?action=auth-signup        (كان api/auth-signup.js)
//   POST /api/misc?action=auth-by-code        (كان api/auth-by-code.js)
//   POST /api/misc?action=link-account        (كان api/link-account.js - deprecated)
//   GET  /api/misc?action=setup               (كان api/setup.js)
//   GET  /api/misc?action=link-status         (كان api/link-status.js)
//   GET  /api/misc?action=admin-stats         (كان api/admin-stats.js)
//   POST /api/misc?action=subscription-proof  (كان api/subscription-proof.js)
//
// كل هاندلر اتنسخ زي ما هو من غير تغيير في المنطق — بس اتلف في دالة منفصلة
// وبقى بيتنده حسب قيمة action.
// ============================================================================

// عميل بالـ anon key لعمليات auth-by-code (تحويل magic-link لجلسة فعلية)
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------------
// POST ?action=auth-signup — تسجيل مباشر بإيميل + كلمة سر
// ---------------------------------------------------------------------------
async function handleAuthSignup(req, res) {
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

    const { error: profileError } = await supabase.from('profiles').upsert({
      id: created.user.id,
      full_name: name || 'مستخدم دبّر',
      email,
    });
    if (profileError) {
      console.error('auth-signup profiles upsert error:', profileError);
    }

    const syntheticTelegramId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));

    const { error: usersError } = await supabase.from('users').upsert(
      {
        telegram_user_id: syntheticTelegramId,
        chat_id: 0,
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
      console.error('auth-signup user_links insert error:', linkInsertError);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('auth-signup error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرب تاني.' });
  }
}

// ---------------------------------------------------------------------------
// POST ?action=auth-by-code — ربط بكود تليجرام + إنشاء/استخدام حساب تلقائي
// ---------------------------------------------------------------------------
async function handleAuthByCode(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'اكتب الكود المكوّن من 6 أرقام اللي وصلك من دبّر على تليجرام.' });
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
      return res.status(400).json({ error: 'الكود ده منتهي. افتح دبّر على تليجرام تاني وابعتله /link عشان تاخد كود جديد.' });
    }

    const telegramUserId = linkCode.telegram_user_id;
    const firstName = linkCode.telegram_first_name || null;
    const syntheticEmail = `tg${telegramUserId}@dabbar-users.app`;

    const { data: existingLink } = await supabase
      .from('user_links')
      .select('auth_user_id')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();

    let authUserId = existingLink?.auth_user_id || null;

    if (!authUserId) {
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

      await supabase.from('profiles').upsert({
        id: authUserId,
        full_name: firstName || 'مستخدم دبّر',
        email: syntheticEmail,
      });
    }

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

// ---------------------------------------------------------------------------
// POST ?action=link-account (DEPRECATED) — ربط حساب موجود بكود من البوت
// ---------------------------------------------------------------------------
async function handleLinkAccount(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });
    }

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

// ---------------------------------------------------------------------------
// GET ?action=setup — إعداد أوامر البوت وزرار الدليل (مرة واحدة بعد كل ديبلوي)
// ---------------------------------------------------------------------------
async function handleSetup(req, res) {
  try {
    const commandsResult = await setBotCommands();
    const menuButtonResult = await setBotMenuButton(GUIDE_URL);

    const ok = commandsResult.ok && menuButtonResult.ok;

    return res.status(ok ? 200 : 500).json({
      ok,
      message: ok
        ? '✅ اتظبطت قايمة الأوامر وزرار الدليل. افتح البوت في تليجرام وشوف.'
        : '⚠️ حصلت مشكلة في جزء من الإعداد، شوف التفاصيل تحت.',
      commands: commandsResult,
      menuButton: menuButtonResult,
      guideUrlUsed: GUIDE_URL || '(مفيش GUIDE_URL متظبط — الزرار هيرجع للقايمة الافتراضية ☰)',
    });
  } catch (err) {
    console.error('Setup error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// GET ?action=link-status — هل حساب الموقع مربوط بتليجرام؟
// ---------------------------------------------------------------------------
async function handleLinkStatus(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    }

    const { data } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();

    return res.status(200).json({ linked: Boolean(data) });
  } catch (err) {
    console.error('link-status error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع.' });
  }
}

// ---------------------------------------------------------------------------
// GET ?action=admin-stats — إحصائيات للأدمن بس
// ---------------------------------------------------------------------------
async function handleAdminStats(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!ADMIN_TELEGRAM_ID) {
    return res.status(500).json({
      error: 'لازم تضيف ADMIN_TELEGRAM_ID في Environment Variables على Vercel الأول.',
    });
  }

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    }

    const { data: link } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();

    if (!link || Number(link.telegram_user_id) !== Number(ADMIN_TELEGRAM_ID)) {
      return res.status(403).json({ error: 'الصفحة دي للأدمن بس.' });
    }

    const { count: totalUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    const nowIso = new Date().toISOString();

    const { count: activeSubscribers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .gt('subscription_expires_at', nowIso);

    const { count: activeUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    let approvedPayments = 0;
    let pendingPayments = 0;
    try {
      const { count: approvedCount } = await supabase
        .from('subscription_proofs')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'approved');
      const { count: pendingCount } = await supabase
        .from('subscription_proofs')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');
      approvedPayments = approvedCount || 0;
      pendingPayments = pendingCount || 0;
    } catch (e) {
      console.warn('admin-stats: subscription_proofs lookup skipped:', e?.message);
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count: newLast7Days } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo);

    const price = Number(SUBSCRIPTION_PRICE_EGP);

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      priceEgp: price,
      users: {
        total: totalUsers || 0,
        activeAccounts: activeUsers || 0,
        activeSubscribers: activeSubscribers || 0,
        newLast7Days: newLast7Days || 0,
      },
      revenue: {
        currentActiveSubscribersEgp: (activeSubscribers || 0) * price,
        approvedPaymentsCount: approvedPayments,
        approvedPaymentsEgp: approvedPayments * price,
        pendingPaymentsCount: pendingPayments,
      },
    });
  } catch (err) {
    console.error('admin-stats error:', err);
    return res.status(500).json({ error: 'حصل خطأ في جلب البيانات، جرب تاني.' });
  }
}

// ---------------------------------------------------------------------------
// POST ?action=subscription-proof — رفع إيصال اشتراك من الداشبورد
// ---------------------------------------------------------------------------
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

async function handleSubscriptionProof(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    }
    const authUserId = userData.user.id;

    const { data: link } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (!link) {
      return res.status(400).json({ error: 'لازم تربط حسابك بتليجرام الأول (من تاب حسابي).' });
    }
    const telegramUserId = link.telegram_user_id;

    const imageBase64 = String(req.body?.imageBase64 || '');
    const senderName = String(req.body?.senderName || '').trim().slice(0, 100);

    const match = imageBase64.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'صورة غير صالحة، جرب ترفعها تاني.' });
    }
    const mimeType = match[1];
    const rawBase64 = match[2];
    const buffer = Buffer.from(rawBase64, 'base64');

    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: 'حجم الصورة كبير أوي، جرب صورة أصغر.' });
    }

    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const fileName = `${telegramUserId}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('payment-proofs')
      .upload(fileName, buffer, { contentType: mimeType, upsert: false });

    if (uploadError) {
      console.error('subscription-proof upload error:', uploadError);
      return res.status(500).json({ error: 'حصل خطأ في رفع الصورة، جرب تاني.' });
    }

    const { data: publicUrlData } = supabase.storage.from('payment-proofs').getPublicUrl(fileName);
    const imageUrl = publicUrlData?.publicUrl;

    await supabase.from('subscription_proofs').insert({
      telegram_user_id: telegramUserId,
      auth_user_id: authUserId,
      image_url: imageUrl,
      sender_name: senderName || null,
    });

    if (ADMIN_TELEGRAM_ID && imageUrl) {
      const caption = senderName
        ? `👆 إيصال تحويل من الداشبورد (مش تليجرام).\n👤 الاسم اللي بعته: <b>${senderName}</b>\n\nقارن الاسم ده باللي ظهرلك في إنستا باي، ولو تمام ابعت:\n<code>فعل ${telegramUserId}</code>`
        : `👆 إيصال تحويل من الداشبورد (مش تليجرام) — من غير اسم.\nلو اتأكدت، فعّله بـ:\n<code>فعل ${telegramUserId}</code>`;

      try {
        await sendTelegramPhoto(ADMIN_TELEGRAM_ID, imageUrl, caption, 'HTML');
      } catch (e) {
        console.error('subscription-proof: failed to notify admin', e);
      }
    }

    const chatId = await getChatIdByUserId(telegramUserId);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        '✅ وصلنا إيصال تحويلك من الداشبورد، هنتأكد ونفعّل اشتراكك خلال دقايق قليلة.'
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('subscription-proof error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرب تاني.' });
  }
}

// ---------------------------------------------------------------------------
// Router رئيسي — بيوجّه حسب ?action=
// ---------------------------------------------------------------------------
const ACTIONS = {
  'auth-signup': handleAuthSignup,
  'auth-by-code': handleAuthByCode,
  'link-account': handleLinkAccount,
  setup: handleSetup,
  'link-status': handleLinkStatus,
  'admin-stats': handleAdminStats,
  'subscription-proof': handleSubscriptionProof,
};

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim();
  const fn = ACTIONS[action];

  if (!fn) {
    return res.status(400).json({
      error: `action غير معروف: "${action}". القيم المتاحة: ${Object.keys(ACTIONS).join(', ')}`,
    });
  }

  return fn(req, res);
}
