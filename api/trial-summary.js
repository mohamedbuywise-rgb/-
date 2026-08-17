import { verifyTrialSummaryToken } from '../lib/trialToken.js';
import { getTrialSummaryData } from '../lib/trialSummary.js';

// ============ GET /api/trial-summary?t=<token> ============
// بترجّع بيانات حقيقية 100% من جدول expenses بتاع المستخدم (مفيش أي رقم وهمي) عشان صفحة
// public/app/dabbar-trial-summary.html تعرضها. التوكن بيتحقق منه في lib/trialToken.js
// (موقّع بـ HMAC، مش محتاج جلسة تسجيل دخول لأن المستخدم في اللحظة دي غالبًا لسه معندوش حساب موقع).
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = String(req.query?.t || '');
    const telegramUserId = verifyTrialSummaryToken(token);

    if (!telegramUserId) {
      return res.status(401).json({ error: 'الرابط ده منتهي أو غير صحيح. ارجع افتح البوت على تليجرام واطلب لينك جديد.' });
    }

    const data = await getTrialSummaryData(telegramUserId);
    return res.status(200).json({ ok: true, telegramUserId, ...data });
  } catch (err) {
    console.error('trial-summary error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرب تاني.' });
  }
}
