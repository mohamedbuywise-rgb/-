import { supabase } from '../../lib/supabaseClient.js';
import { standaloneDataUserId } from '../../lib/dashboardAuth.js';
import { getNotificationPreferences } from '../../lib/webPush.js';

// ملخص خفيف للويدجت (أندرويد Widget / آيفون Scriptable). بيقبل نفس توكن ربط الحساب (sms webhook token).
// بيرجّع أرقام الشهر (بالجنيه) وأرقام النهاردة بس — من غير أي تفاصيل حساسة.
async function resolveDataUserId(profileId) {
  const { data: link } = await supabase.from('user_links').select('telegram_user_id').eq('auth_user_id', profileId).maybeSingle();
  return link?.telegram_user_id || standaloneDataUserId(profileId);
}
function dateKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const sum = (rows) => (rows || []).reduce((total, r) => ((r.currency_code || 'EGP') === 'EGP' ? total + Number(r.amount || 0) : total), 0);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = String(req.body?.token || req.query?.token || '').trim();
  if (!token || token.length < 16) return res.status(401).json({ ok: false, error: 'توكن غير صالح.' });

  try {
    const { data: profile } = await supabase.from('profiles').select('id').eq('sms_webhook_token', token).maybeSingle();
    if (!profile) return res.status(401).json({ ok: false, error: 'توكن غير صالح.' });
    const userId = await resolveDataUserId(profile.id);
    const prefs = await getNotificationPreferences(userId).catch(() => null);
    const timeZone = prefs?.timezone || 'Africa/Cairo';

    const now = new Date();
    const today = dateKey(now, timeZone);
    const monthPrefix = today.slice(0, 7);
    // نجيب من قبل بداية الشهر بيوم (فرق التوقيت) ونفلتر بالتاريخ المحلي بعد كده
    const from = new Date(now.getTime() - 33 * 86400000).toISOString();
    const [{ data: expenses }, { data: incomes }] = await Promise.all([
      supabase.from('expenses').select('amount, currency_code, created_at').eq('telegram_user_id', userId).gte('created_at', from),
      supabase.from('financial_events').select('amount, currency_code, created_at').eq('telegram_user_id', userId).eq('event_type', 'income').gte('created_at', from),
    ]);
    const inMonth = (r) => dateKey(new Date(r.created_at), timeZone).startsWith(monthPrefix);
    const monthExpenses = (expenses || []).filter(inMonth);
    const monthIncomes = (incomes || []).filter(inMonth);
    const todayExpenses = monthExpenses.filter((r) => dateKey(new Date(r.created_at), timeZone) === today);
    const expense = Math.round(sum(monthExpenses));
    const income = Math.round(sum(monthIncomes));

    return res.status(200).json({
      ok: true,
      currency: 'EGP',
      month: {
        label: new Intl.DateTimeFormat('ar-EG', { timeZone, month: 'long', year: 'numeric' }).format(now),
        expense,
        income,
        balance: income - expense,
      },
      today: { expense: Math.round(sum(todayExpenses)), count: todayExpenses.length },
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    console.error('widget-summary error:', error);
    return res.status(500).json({ ok: false, error: 'تعذر تحميل الملخص.' });
  }
}
