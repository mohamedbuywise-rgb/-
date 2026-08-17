import { supabase } from '../lib/supabaseClient.js';
import { getMonthRange, getExpensesBetween, buildCategoryBreakdown } from '../lib/expenses.js';
import { computeNetByPerson } from '../lib/debts.js';
import { getInvoicesList, getInvoiceDetail } from '../lib/invoices.js';
import { MONTH_NAMES, CATEGORY_EMOJI, SUBSCRIPTION_PRICE_EGP, INSTAPAY_LINK } from '../lib/config.js';
import { hasActiveSubscription, getSubscriptionExpiry, isInTrial, getTrialDaysLeft } from '../lib/users.js';

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

  // مهم جدًا: من غير الهيدرز دي، المتصفح أو أي CDN بينفّذ caching على الـ GET ده
  // ولو حصل ده، بعد أي عملية ربط جديدة (auth-by-code) هيفضل يرجّع نفس الرد القديم
  // (زي linked:false) من غير ما يبعت الطلب فعليًا للسيرفر تاني — وده كان سبب اللفة اللي كانت بتحصل.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

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

    if (linkError) {
      console.error('dashboard-data user_links lookup error:', JSON.stringify(linkError), 'auth_user_id:', userData.user.id);
    }

    if (!link) {
      console.log('dashboard-data: no link found for auth_user_id:', userData.user.id);
      return res.status(200).json({ linked: false });
    }

    console.log('dashboard-data: linked to telegram_user_id:', link.telegram_user_id);

    const telegramUserId = link.telegram_user_id;

    // ---- كل الفواتير / تفاصيل فاتورة واحدة (GET /api/dashboard-data?invoices=1 أو ?invoiceId=123) ----
    // اتحطوا هنا بدل ملف API منفصل عشان نفضل تحت حد Vercel Hobby (12 function كحد أقصى)،
    // بنفس فكرة تجميع الميزات في api/assistant.js.
    if (req.query.invoiceId) {
      const invoice = await getInvoiceDetail(telegramUserId, Number(req.query.invoiceId));
      if (!invoice) return res.status(404).json({ error: 'الفاتورة دي مش موجودة.' });
      return res.status(200).json({ linked: true, invoice });
    }
    if (req.query.invoices) {
      const invoices = await getInvoicesList(telegramUserId);
      return res.status(200).json({ linked: true, invoices });
    }


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

    // ---- الهدف المالي النشط (لو موجود) — نفس جدول goals اللي البوت بيستخدمه ----
    const { data: goalRow, error: goalError } = await supabase
      .from('goals')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (goalError) console.error('dashboard-data goal lookup error:', JSON.stringify(goalError));

    const goal = goalRow
      ? {
          id: goalRow.id,
          title: goalRow.title,
          targetAmount: Number(goalRow.target_amount),
          savedAmount: Number(goalRow.saved_amount),
          targetDate: goalRow.target_date,
          percent: Math.min(100, Math.round((Number(goalRow.saved_amount) / Number(goalRow.target_amount)) * 100)),
        }
      : null;

    // ---- توقّع نهاية الشهر + اقتراح ذكي (كله محسوب من أرقام حقيقية فوق، صفر أرقام مختلقة) ----
    const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    const projectedTotal = Math.round(avgPerDayThisMonth * daysInMonth);
    const projectedDayLabel = MONTH_NAMES[start.getMonth()];

    let potentialSaving = 0;
    if (prevTotal > 0 && projectedTotal < prevTotal) {
      potentialSaving = Math.round(((prevTotal - projectedTotal) / 10)) * 10; // تقريب لأقرب 10 جنيه
    }

    const smart = {
      projectedTotal,
      daysInMonth,
      daysPassed: daysPassedThisMonth,
      projectedLabel: projectedDayLabel,
      potentialSaving,
    };

    // ---- الديون ----
    const netByPerson = await computeNetByPerson(telegramUserId);
    const entries = Object.values(netByPerson).filter((v) => v.net !== 0);
    const owedToYou = entries.filter((v) => v.net > 0).sort((a, b) => b.net - a.net);
    const youOwe = entries.filter((v) => v.net < 0).sort((a, b) => a.net - b.net);
    const owedToYouTotal = owedToYou.reduce((sum, v) => sum + v.net, 0);
    const youOweTotal = youOwe.reduce((sum, v) => sum + Math.abs(v.net), 0);

    // ---- حركة السيولة اليومية (واصل من / واصل لـ) ----
    const { data: todayFlowData } = await supabase
      .from('debts')
      .select('amount, direction')
      .eq('telegram_user_id', telegramUserId)
      .gte('created_at', startOfDay.toISOString())
      .lt('created_at', endOfDay.toISOString());

    const flowIn = (todayFlowData || [])
      .filter(d => d.direction === 'borrowed')
      .reduce((sum, d) => sum + Number(d.amount), 0);
    const flowOut = (todayFlowData || [])
      .filter(d => d.direction === 'lent')
      .reduce((sum, d) => sum + Number(d.amount), 0);

    // ---- "Financial Wrapped" السنة الحالية — استعلام واحد بس لكل السنة (مش شهر شهر) عشان يفضل خفيف ----
    const DISCRETIONARY_CATEGORIES = ['تسوق', 'ترفيه', 'اشتراكات', 'هدايا وتبرعات', 'شخصي وعناية'];
    const yearStart = new Date(start.getFullYear(), 0, 1);
    const yearEnd = new Date(start.getFullYear() + 1, 0, 1);
    const yearExpenses = await getExpensesBetween(telegramUserId, yearStart, yearEnd);

    let wrapped = null;
    if (yearExpenses.length > 0) {
      const yearTotal = yearExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
      const yearBreakdown = buildCategoryBreakdown(yearExpenses);
      const discretionaryTotal = yearBreakdown
        .filter((c) => DISCRETIONARY_CATEGORIES.includes(c.name))
        .reduce((sum, c) => sum + Number(c.amount), 0);
      const savedEstimate = Math.round((discretionaryTotal * 0.2) / 10) * 10;

      const perMonth = {};
      for (const e of yearExpenses) {
        const m = new Date(e.created_at).getMonth();
        perMonth[m] = (perMonth[m] || 0) + Number(e.amount);
      }
      const monthEntries = Object.entries(perMonth).map(([m, total]) => ({ month: Number(m), total }));
      const bestMonth = monthEntries.length > 0
        ? monthEntries.reduce((a, b) => (a.total < b.total ? a : b))
        : null;

      wrapped = {
        year: start.getFullYear(),
        total: yearTotal,
        count: yearExpenses.length,
        topCategory: yearBreakdown[0] || null,
        byCategory: yearBreakdown.slice(0, 5).map((b) => ({ name: b.name, amount: b.amount, percent: Number(b.percent) })),
        savedEstimate,
        bestMonthLabel: bestMonth ? MONTH_NAMES[bestMonth.month] : null,
        bestMonthTotal: bestMonth ? bestMonth.total : null,
      };
    }

    // ---- حالة الاشتراك/التجربة ----
    const subActive = await hasActiveSubscription(telegramUserId);
    const subExpiresAt = await getSubscriptionExpiry(telegramUserId);
    const subInTrial = !subActive && (await isInTrial(telegramUserId));
    const subTrialDaysLeft = subInTrial ? await getTrialDaysLeft(telegramUserId) : 0;

    return res.status(200).json({
      linked: true,
      telegramUserId,
      generatedAt: new Date().toISOString(),
      subscription: {
        active: subActive,
        expiresAt: subExpiresAt ? subExpiresAt.toISOString() : null,
        inTrial: subInTrial,
        trialDaysLeft: subTrialDaysLeft,
        priceEgp: SUBSCRIPTION_PRICE_EGP,
        instapayNumber: INSTAPAY_LINK,
      },
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
      flow: {
        in: flowIn,
        out: flowOut,
        net: flowIn - flowOut
      },
      history,
      goal,
      smart,
      wrapped,
    });
  } catch (err) {
    console.error('dashboard-data error:', err);
    return res.status(500).json({ error: 'حصل خطأ في جلب البيانات، جرب تاني.' });
  }
}
