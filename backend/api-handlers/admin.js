import { supabase } from '../../lib/supabaseClient.js';
import { sendTelegramMessage, sendTelegramPhoto } from '../../lib/telegram.js';
import { getChatIdByUserId } from '../../lib/users.js';
import { ADMIN_TELEGRAM_ID, ADMIN_PASSWORD, SUBSCRIPTION_PRICE_EGP } from '../../lib/config.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';

// ============ GET /api/admin  (كان /api/admin-stats) ============
// صفحة إحصائيات خاصة بالأدمن بس (مالك المشروع). مفيش حساب Supabase/تليجرام هنا خالص —
// بس باسورد واحد ثابت (ADMIN_PASSWORD في Environment Variables على Vercel)، والصفحة
// بتبعته في الـ Authorization header زي: `Bearer <الباسورد>`.
async function handleStats(req, res) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      error: 'لازم تضيف ADMIN_PASSWORD في Environment Variables على Vercel الأول.',
    });
  }

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'الصفحة دي للأدمن بس.' });
  }

  // ---- إجمالي المستخدمين ----
  const { count: totalUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });

  const nowIso = new Date().toISOString();

  // ---- مشتركين نشطين دلوقتي ----
  const { count: activeSubscribers } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .gt('subscription_expires_at', nowIso);

  // ---- في فترة تجربة (مفيش subscription_expires_at لسه، وحساباتهم لسه شغالة) ----
  const { count: activeUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  // ---- إثباتات الدفع (لو الجدول موجود) ----
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
    // الجدول أو عمود status ممكن يكون لسه مش موجود أو باسم مختلف — نتجاهل من غير ما نكسر الباقي
    console.warn('admin(stats): subscription_proofs lookup skipped:', e?.message);
  }

  // ---- تسجيلات جديدة آخر 7 أيام ----
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
}

// ============ POST /api/admin  (كان /api/subscription-proof) ============
// بيتنادى من تاب "حسابي" في الداشبورد لما المستخدم يرفع صورة إيصال تحويل الاشتراك.
// بيرفع الصورة على Supabase Storage، يبعتها للأدمن على تليجرام (نفس تدفق سكرين شوت
// البوت بالظبط، بأمر "فعل <id>" جاهز)، وبيأكّد للمستخدم إن الإثبات وصل.
//
// Body: { imageBase64: "data:image/jpeg;base64,....", senderName?: "اسم اللي حوّل بيه" }
// Header: Authorization: Bearer <supabase access token بتاع الجلسة الحالية>
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB - حد معقول لصورة سكرين شوت

async function handleSubscriptionProof(req, res) {
  const user = await getDashboardUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
  }
  const authUserId = user.authUserId;
  const telegramUserId = user.dataUserId;
  const isTelegramLinked = user.linked;

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
    console.error('admin(subscription-proof) upload error:', uploadError);
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

  // ---- إبلاغ الأدمن على تليجرام، بنفس صيغة سكرين شوت البوت العادي (أمر "فعل" جاهز) ----
  if (ADMIN_TELEGRAM_ID && imageUrl) {
    const sourceLabel = isTelegramLinked ? 'الحساب مربوط بتيليجرام' : 'حساب مستقل — غير مربوط بتيليجرام';
    const caption = senderName
      ? `👆 إيصال تحويل من الداشبورد (مش تليجرام).\n🔗 ${sourceLabel}\n👤 الاسم اللي بعته: <b>${senderName}</b>\n\nقارن الاسم ده باللي ظهرلك في إنستا باي، ولو تمام ابعت:\n<code>فعل ${telegramUserId}</code>`
      : `👆 إيصال تحويل من الداشبورد (مش تليجرام) — من غير اسم.\n🔗 ${sourceLabel}\nلو اتأكدت، فعّله بـ:\n<code>فعل ${telegramUserId}</code>`;

    try {
      await sendTelegramPhoto(ADMIN_TELEGRAM_ID, imageUrl, caption, 'HTML');
    } catch (e) {
      console.error('admin(subscription-proof): failed to notify admin', e);
    }
  }

  // ---- تأكيد للمستخدم نفسه على تيليجرام فقط لو الحساب مربوط فعلًا ----
  if (isTelegramLinked) {
    const chatId = await getChatIdByUserId(telegramUserId);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        '✅ وصلنا إيصال تحويلك من الداشبورد، هنتأكد ونفعّل اشتراكك خلال دقايق قليلة.'
      );
    }
  }

  return res.status(200).json({ ok: true });
}

// ============ Router: /api/admin ============
// GET  → إحصائيات الأدمن (كان /api/admin-stats)
// POST → رفع إيصال اشتراك (كان /api/subscription-proof)
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return await handleStats(req, res);
    }
    if (req.method === 'POST') {
      return await handleSubscriptionProof(req, res);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('admin error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرب تاني.' });
  }
}
