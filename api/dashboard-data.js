import { supabase } from '../lib/supabaseClient.js';
import { getMonthRange, getExpensesBetween, buildCategoryBreakdown } from '../lib/expenses.js';
import { computeNetByPerson } from '../lib/debts.js';
import { MONTH_NAMES } from '../lib/config.js';

// ============ GET /api/dashboard-data ============
// بيرجّع بيانات حقيقية بس (صفر mock data): مصاريف النهاردة، مصاريف الشهر بالتصنيفات، والديون.
// Header: Authorization: Bearer <supabase access token>
//
// ملحوظة مهمة: مفيش أي مفهوم "دخل" أو "توفير" في قاعدة بيانات البوت — البوت بيسجل مصاريف
// وديون بس، مفيش جدول income. فالـ response ده ملوش أي رقم "دخل" أو "نسبة توفير"، عشان
// معندناش مصدر بيانات حقيقي لهم. لو عايز الميزة دي، محتاجين أول جدول income + طريقة تسجيله
// (يدوي من الداشبورد، أو رسالة زي "قبضت 8000 جنيه" في البوت).
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

    const { data: link } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();

    if (!link) {
      return res.status(200).json({ linked: false });
    }

    const telegramUserId = link.telegram_user_id;

    // ---- مصاريف النهاردة ----
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    const todayExpenses = await getExpensesBetween(telegramUserId, startOfDay, endOfDay);
    const todayTotal = todayExpenses.reduce((sum, e) => sum + Number(e.amount), 0);

    // ---- مصاريف الشهر الحالي ----
    const { start, end, label } = getMonthRange(0);
    const monthExpenses = await getExpensesBetween(telegramUserId, start, end);
    const monthTotal = monthExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const breakdown = buildCategoryBreakdown(monthExpenses); // [{name, amount, percent, items}]

    const daysPassedThisMonth = Math.max(
      1,
      Math.ceil((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000))
    );
    const avgPerDayThisMonth = Math.round(monthTotal / daysPassedThisMonth);

    // ---- الشهر اللي فات (للمقارنة) ----
    const prevRange = getMonthRange(-1);
    const prevExpenses = await getExpensesBetween(telegramUserId, prevRange.start, prevRange.end);
    const prevTotal = prevExpenses.reduce((sum, e) => sum + Number(e.amount), 0);

    // ---- أرشيف آخر 4 شهور فاتت (بيانات حقيقية من جدول expenses، مش تلخيص محفوظ منفصل) ----
    const history = [];
    for (let offset = -1; offset >= -4; offset--) {
      const range = getMonthRange(offset);
      const rangeExpenses = await getExpensesBetween(telegramUserId, range.start, range.end);
      if (rangeExpenses.length === 0) continue;
      const rangeTotal = rangeExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
      const rangeBreakdown = buildCategoryBreakdown(rangeExpenses);
      history.push({
        label: range.label,
        year: range.start.getFullYear(),
        total: rangeTotal,
        count: rangeExpenses.length,
        topCategoryName: rangeBreakdown[0]?.name || null,
      });
    }

    // ---- الديون ----
    const netByPerson = await computeNetByPerson(telegramUserId);
    const entries = Object.values(netByPerson).filter((v) => v.net !== 0);
    const owedToYou = entries.filter((v) => v.net > 0).sort((a, b) => b.net - a.net);
    const youOwe = entries.filter((v) => v.net < 0).sort((a, b) => a.net - b.net);
    const owedToYouTotal = owedToYou.reduce((sum, v) => sum + v.net, 0);
    const youOweTotal = youOwe.reduce((sum, v) => sum + Math.abs(v.net), 0);

    return res.status(200).json({
      linked: true,
      telegramUserId,
      generatedAt: new Date().toISOString(),
      today: {
        total: todayTotal,
        count: todayExpenses.length,
        avgPerDayThisMonth,
        items: todayExpenses.map((e) => ({
          amount: Number(e.amount),
          category: e.category,
          description: e.description,
          created_at: e.created_at,
        })),
      },
      month: {
        label,
        total: monthTotal,
        count: monthExpenses.length,
        prevTotal,
        prevLabel: MONTH_NAMES[prevRange.start.getMonth()],
        byCategory: breakdown.map((b) => ({ name: b.name, amount: b.amount, percent: Number(b.percent) })),
        topCategory: breakdown[0] || null,
      },
      debts: {
        net: owedToYouTotal - youOweTotal,
        owedToYouTotal,
        youOweTotal,
        owedToYou: owedToYou.map((v) => ({ name: v.displayName, amount: v.net })),
        youOwe: youOwe.map((v) => ({ name: v.displayName, amount: Math.abs(v.net) })),
      },
      history,
    });
  } catch (err) {
    console.error('dashboard-data error:', err);
    return res.status(500).json({ error: 'حصل خطأ في جلب البيانات، جرب تاني.' });
  }
}
