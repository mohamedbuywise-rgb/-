import {
  DEFAULT_PREFERENCES,
  getDashboardUserFromToken,
  getNotificationPreferences,
  getPushSubscriptionStatus,
  isPushConfigured,
  removePushSubscription,
  saveNotificationPreferences,
  savePushSubscription,
  sendTestPush,
} from '../../lib/webPush.js';

function tokenFromRequest(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export default async function handler(req, res) {
  noStore(res);
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await getDashboardUserFromToken(tokenFromRequest(req));
    if (!user) return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });

    if (req.method === 'GET') {
      const preferences = await getNotificationPreferences(user.dataUserId);
      // لو الجهاز بعت endpoint بتاعه، بنرجّع حالة اشتراكه على الخادم (مسجّل؟ فعّال؟ آخر خطأ؟) عشان الداشبورد يصلّحه تلقائيًا لو ناقص.
      const endpoint = String(req.query?.endpoint || '').trim();
      const server = await getPushSubscriptionStatus(user.dataUserId, endpoint);
      return res.status(200).json({
        configured: isPushConfigured(),
        publicKey: process.env.VAPID_PUBLIC_KEY || '',
        preferences,
        server,
      });
    }

    if (req.method === 'POST' && req.body?.action === 'test') {
      // إشعار تجريبي فوري + تفاصيل النتيجة (عدد اللي وصل، أو سبب الفشل) لتشخيص أي مشكلة توصيل.
      const result = await sendTestPush(user.dataUserId);
      const server = await getPushSubscriptionStatus(user.dataUserId, String(req.body?.endpoint || '').trim());
      return res.status(200).json({ ok: true, result, server });
    }

    if (req.method === 'POST') {
      const subscription = req.body?.subscription;
      const saved = await savePushSubscription({
        authUserId: user.authUserId,
        telegramUserId: user.dataUserId,
        subscription,
        userAgent: req.headers['user-agent'] || '',
      });
      return res.status(200).json({ ok: true, subscription: saved });
    }

    if (req.method === 'PUT') {
      const preferences = await saveNotificationPreferences({
        authUserId: user.authUserId,
        telegramUserId: user.dataUserId,
        preferences: { ...DEFAULT_PREFERENCES, ...(req.body?.preferences || {}) },
      });
      return res.status(200).json({ ok: true, preferences });
    }

    await removePushSubscription({ authUserId: user.authUserId, endpoint: req.body?.endpoint });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('push endpoint error:', JSON.stringify(error));
    return res.status(500).json({ error: error?.message || 'حصل خطأ في إعداد الإشعارات.' });
  }
}
