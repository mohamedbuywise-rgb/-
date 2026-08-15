import { supabase } from '../lib/supabaseClient.js';
import { getPersonDebtDetail } from '../lib/debts.js';

// ============ GET /api/debt-person-detail?name=محمد ============
// بيرجّع كل عمليات شخص معيّن (مش الصافي بس) عشان الموقع يوريها لما المستخدم يدوس على اسم
// الشخص في تبويب "الديون" — نفس منطق "ديون محمد" في البوت، بس كـ JSON للموقع.
// Header: Authorization: Bearer <supabase access token>
export default async function handler(req, res) {
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

    const { data: link, error: linkError } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();
    if (linkError) console.error('debt-person-detail user_links error:', JSON.stringify(linkError));

    if (!link) {
      return res.status(400).json({ error: 'لازم تربط حسابك بالبوت الأول.' });
    }

    const personName = String(req.query?.name || '').trim();
    if (!personName) {
      return res.status(400).json({ error: 'اسم الشخص مطلوب.' });
    }

    const detail = await getPersonDebtDetail(link.telegram_user_id, personName);
    if (!detail) {
      return res.status(404).json({ error: `معندكش أي عمليات مسجلة مع "${personName}"` });
    }

    return res.status(200).json({
      personName: detail.actualName,
      net: detail.net,
      relevantNet: detail.relevantNet,
      lastSettlement: detail.lastSettlement,
      transactions: detail.transactions
        .slice()
        .reverse() // الأحدث الأول، أسهل للقراءة على الموقع
        .map((t) => ({
          amount: t.amount,
          direction: t.direction,
          isRepayment: t.isRepayment,
          note: t.note,
          createdAt: t.createdAt,
        })),
    });
  } catch (err) {
    console.error('debt-person-detail error:', err);
    return res.status(500).json({ error: 'حصل خطأ، جرب تاني.' });
  }
}
