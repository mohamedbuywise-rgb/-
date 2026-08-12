import { supabase } from '../lib/supabaseClient.js';
import { sendTelegramMessage, sendTelegramPhoto } from '../lib/telegram.js';
import { getChatIdByUserId } from '../lib/users.js';
import { ADMIN_TELEGRAM_ID } from '../lib/config.js';

// ============ POST /api/subscription-proof ============
// بيتنادى من تاب "حسابي" في الداشبورد لما المستخدم يرفع صورة إيصال تحويل الاشتراك.
// بيرفع الصورة على Supabase Storage، يبعتها للأدمن على تليجرام (نفس تدفق سكرين شوت
// البوت بالظبط، بأمر "فعل <id>" جاهز)، وبيأكّد للمستخدم إن الإثبات وصل.
//
// Body: { imageBase64: "data:image/jpeg;base64,....", senderName?: "اسم اللي حوّل بيه" }
// Header: Authorization: Bearer <supabase access token بتاع الجلسة الحالية>
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB - حد معقول لصورة سكرين شوت

export default async function handler(req, res) {
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

    // ---- إبلاغ الأدمن على تليجرام، بنفس صيغة سكرين شوت البوت العادي (أمر "فعل" جاهز) ----
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

    // ---- تأكيد للمستخدم نفسه على تليجرام (لو عندنا chat_id بتاعه) ----
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
