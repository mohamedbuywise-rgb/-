import { verifyTrialSummaryToken } from '../lib/trialToken.js';
import { sendTelegramPhotoBuffer, sendTelegramMessage } from '../lib/telegram.js';
import { ADMIN_TELEGRAM_ID } from '../lib/config.js';

// ============ POST /api/trial-summary-proof ============
// بيستقبل إثبات دفع (صورة + اسم) مرفوع من صفحة الويب public/app/dabbar-trial-summary.html
// (بديل لرفعه يدوي على تليجرام)، وبيحوّله فورًا للأدمن بنفس شكل وأسلوب الفلو الحالي في
// api/telegram-webhook.js عشان الأدمن يقدر يفعّل الاشتراك بنفس أمر "فعل <id>" المعتاد.
// Body: { token, imageBase64 (data URL كامل أو base64 خام), senderName }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token, imageBase64, senderName } = req.body || {};
    const telegramUserId = verifyTrialSummaryToken(token);

    if (!telegramUserId) {
      return res.status(401).json({ error: 'الرابط ده منتهي أو غير صحيح. ارجع افتح البوت على تليجرام واطلب لينك جديد.' });
    }

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'ارفع صورة إيصال التحويل الأول.' });
    }

    const cleanName = String(senderName || '').trim().slice(0, 120);

    // بنشيل الـ data URL prefix لو موجود (data:image/png;base64,....)
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch {
      return res.status(400).json({ error: 'الصورة اللي رفعتها فيها مشكلة، جرب صورة تانية.' });
    }
    if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: 'حجم الصورة غير مناسب (لازم تكون أقل من 8 ميجا).' });
    }

    if (!ADMIN_TELEGRAM_ID) {
      console.error('trial-summary-proof: ADMIN_TELEGRAM_ID غير مضبوط في Environment Variables');
      return res.status(500).json({ error: 'الخدمة مش مظبوطة صح دلوقتي، جرب تبعت الإيصال على تليجرام مباشرة.' });
    }

    const caption = cleanName
      ? `👆 سكرين شوت تحويل (مبعوت من صفحة ملخص التجربة على الموقع).\n👤 الاسم اللي بعته: <b>${cleanName}</b>\n\nقارن الاسم ده باللي ظهرلك في إنستا باي، ولو تمام ابعت:\n<code>فعل ${telegramUserId}</code>`
      : `👆 سكرين شوت تحويل (من صفحة ملخص التجربة، من غير اسم).\nلو اتأكدت، فعّله بـ:\n<code>فعل ${telegramUserId}</code>`;

    await sendTelegramPhotoBuffer(ADMIN_TELEGRAM_ID, buffer, 'trial-proof.jpg', caption, 'HTML');

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('trial-summary-proof error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرب تاني أو ابعت الإيصال على تليجرام مباشرة.' });
  }
}
