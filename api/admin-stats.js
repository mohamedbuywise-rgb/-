import { supabase } from '../lib/supabaseClient.js';
import { ADMIN_TELEGRAM_ID, SUBSCRIPTION_PRICE_EGP } from '../lib/config.js';

// ============ GET /api/admin-stats ============
// صفحة إحصائيات خاصة بالأدمن بس (مالك المشروع). بتتأمّن بطريقتين مع بعض:
// 1. لازم تيجي بتوكن Supabase Auth صحيح (بعد تسجيل الدخول).
// 2. الحساب المرتبط بالتوكن ده لازم يكون telegram_user_id بتاعه == ADMIN_TELEGRAM_ID
//    اللي انت حاططه في Environment Variables على Vercel.
// أي حد تاني (حتى لو عنده حساب عادي مسجل ومشترك) هياخد 403.
export default async function handler(req, res) {
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
      console.warn('admin-stats: subscription_proofs lookup skipped:', e?.message);
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
  } catch (err) {
    console.error('admin-stats error:', err);
    return res.status(500).json({ error: 'حصل خطأ في جلب البيانات، جرب تاني.' });
  }
}
