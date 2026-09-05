import { supabase } from '../../lib/supabaseClient.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { getMonthRange, getExpensesBetween, buildCategoryBreakdown, detectRecurringSubscriptions, getLifetimeCashPosition } from '../../lib/expenses.js';
import { computeNetByPerson } from '../../lib/debts.js';
import { getInvoicesList, getInvoiceDetail } from '../../lib/invoices.js';
import { MONTH_NAMES, CATEGORY_EMOJI, SUBSCRIPTION_PRICE_EGP, INSTAPAY_LINK } from '../../lib/config.js';
import { hasActiveSubscription, getSubscriptionExpiry, isInTrial, getTrialDaysLeft } from '../../lib/users.js';
import { getActiveDays } from '../../lib/activeDays.js';
import { getPortfolio, getPortfolioDigest } from '../../lib/investments.js';

function sumByCurrency(rows = []) {
  return rows.reduce((acc, row) => {
    const code = String(row.currency_code || 'EGP').toUpperCase();
    acc[code] = (acc[code] || 0) + Number(row.amount || 0);
    return acc;
  }, {});
}

// ============ GET /api/dashboard-data ============
// بيرجّع بيانات حقيقية بس (صفر mock data): مصاريف النهاردة، مصاريف الشهر بالتصنيفات، والديون.
// Header: Authorization: Bearer <supabase access token>
//
// ملحوظة: الدخل بيتحسب من جدول financial_events (event_type='income') + السلف المستلَفة
// من جدول debts (direction='borrowed') — راجع month.incomeTotal و month.incomeItems تحت.
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
    const dashboardUser = await getDashboardUserFromRequest(req);
    if (!dashboardUser) {
      return res.status(401).json({ error: 'نورت من تاني! جلستك خلصت، سجّل دخولك تاني عشان نكمل سوا.' });
    }

    const { dataUserId, telegramUserId, linked } = dashboardUser;
    console.log(
      `dashboard-data: ${linked ? 'linked to telegram_user_id' : 'standalone auth user'}:`,
      linked ? telegramUserId : dashboardUser.authUserId
    );

    // ---- الأيام النشطة: طلب واحد من RPC، والـ fallback لا يعطل الداشبورد ----
    const activeDays = await getActiveDays(dataUserId);

    // ---- كل الفواتير / تفاصيل فاتورة واحدة (GET /api/dashboard-data?invoices=1 أو ?invoiceId=123) ----
    // اتحطوا هنا بدل ملف API منفصل عشان نفضل تحت حد Vercel Hobby (12 function كحد أقصى)،
    // بنفس فكرة تجميع الميزات في api/assistant.js.
    if (req.query.invoiceId) {
      const invoice = await getInvoiceDetail(dataUserId, Number(req.query.invoiceId));
      if (!invoice) return res.status(404).json({ error: 'الفاتورة دي مش موجودة.' });
      return res.status(200).json({ linked, telegramUserId: linked ? telegramUserId : null, invoice });
    }
    if (req.query.invoices) {
      const invoices = await getInvoicesList(dataUserId);
      return res.status(200).json({ linked, telegramUserId: linked ? telegramUserId : null, invoices });
    }


    // ---- حساب كل نطاقات التاريخ الأول (عمليات JS بحتة، بدون أي استعلام) ----
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const daysSinceSaturday = (todayStart.getDay() - 6 + 7) % 7;
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - daysSinceSaturday);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const previousWeekStart = new Date(weekStart);
    previousWeekStart.setDate(previousWeekStart.getDate() - 7);

    const { start, end, label } = getMonthRange(0);
    const prevRange = getMonthRange(-1);
    const historyOffsets = [-1, -2, -3, -4].map((offset) => ({ offset, range: getMonthRange(offset) }));

    const DISCRETIONARY_CATEGORIES = ['تسوق', 'ترفيه', 'اشتراكات', 'هدايا وتبرعات', 'شخصي وعناية'];
    const AR_DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    // بتاخد المصاريف جاهزة (expenses) بدل ما تجيبها بنفسها من قاعدة البيانات، عشان "الأسبوعي"
    // و"الشهري" يعيدوا استخدام نفس المصاريف اللي اتجابت أصلاً فوق (نفس النطاق بالظبط)، من غير استعلام إضافي.
    function computeWrapped(expenses, unit, extraFields = {}) {
      if (!expenses || expenses.length === 0) return null;
      const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
      const breakdown = buildCategoryBreakdown(expenses);
      const discretionaryTotal = breakdown
        .filter((c) => DISCRETIONARY_CATEGORIES.includes(c.name))
        .reduce((sum, c) => sum + Number(c.amount), 0);
      const savedEstimate = Math.round((discretionaryTotal * 0.2) / 10) * 10;

      const buckets = {};
      for (const e of expenses) {
        const d = new Date(e.created_at);
        let key, bucketLabel;
        if (unit === 'day') {
          key = d.toDateString();
          bucketLabel = AR_DAY_NAMES[d.getDay()];
        } else if (unit === 'week') {
          const weekIndex = Math.floor((d.getDate() - 1) / 7) + 1;
          key = `w${weekIndex}`;
          bucketLabel = `الأسبوع ${weekIndex}`;
        } else {
          key = d.getMonth();
          bucketLabel = MONTH_NAMES[d.getMonth()];
        }
        if (!buckets[key]) buckets[key] = { label: bucketLabel, total: 0 };
        buckets[key].total += Number(e.amount);
      }
      const bucketList = Object.values(buckets);
      const bestBucket = bucketList.length > 0
        ? bucketList.reduce((a, b) => (a.total < b.total ? a : b))
        : null;

      return {
        total,
        count: expenses.length,
        topCategory: breakdown[0] || null,
        byCategory: breakdown.slice(0, 5).map((b) => ({ name: b.name, amount: b.amount, currency_code: b.currency_code || 'EGP', percent: Number(b.percent) })),
        savedEstimate,
        bestMonthLabel: bestBucket ? bestBucket.label : null,
        bestMonthTotal: bestBucket ? bestBucket.total : null,
        ...extraFields,
      };
    }

    const wrappedWeekEnd = new Date(weekStart);
    wrappedWeekEnd.setDate(wrappedWeekEnd.getDate() + 7); // = weekEnd بالظبط، محتفظين بالاسم القديم للتوضيح
    const yearStart = new Date(start.getFullYear(), 0, 1);
    const yearEnd = new Date(start.getFullYear() + 1, 0, 1);

    // ============ الحمل الكبير: كل استعلامات قاعدة البيانات المستقلة عن بعضها بتتبعت مرة واحدة بالتوازي ============
    // ده أهم تعديل لسرعة الشاشة: كانت كل استعلامات الداشبورد (~20 استعلام) بتتنفذ واحد ورا التاني (await
    // متتابع)، فلو كل استعلام ياخد حتى 150-300 مللي ثانية، المجموع كان بيوصل لثواني معدودة قبل ما أي حاجة
    // تظهر للمستخدم. دلوقتي كلهم بيتبعتوا مع بعض ويستنوا مع بعض، فالوقت الكلي = أبطأ استعلام واحد بس
    // (وكمان بطّلنا نجيب مصاريف "الشهر الحالي" و"الأسبوع الحالي" مرتين لحساب الـ Wrapped، بنعيد استخدام
    // نفس النتيجة اللي جايالنا فوق).
    const [
      todayExpenses,
      weekExpenses,
      previousWeekExpenses,
      monthExpenses,
      { data: monthFinancialEvents, error: eventsError },
      prevExpenses,
      { data: prevFinancialEvents },
      { data: prevBorrowedDebts },
      historyExpensesList,
      { data: goalRows, error: goalError },
      portfolio,
      portfolioDigest,
      netByPerson,
      lifetimeCash,
      recurringSubscriptions,
      { data: monthBorrowedDebts },
      { data: todayFlowData },
      yearExpenses,
      subActive,
      subExpiresAt,
    ] = await Promise.all([
      getExpensesBetween(dataUserId, startOfDay, endOfDay),
      getExpensesBetween(dataUserId, weekStart, weekEnd),
      getExpensesBetween(dataUserId, previousWeekStart, weekStart),
      getExpensesBetween(dataUserId, start, end),
      supabase
        .from('financial_events')
        .select('id, event_type, amount, currency_code, category, description, raw_text, direction, created_at')
        .eq('telegram_user_id', dataUserId)
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString())
        .order('created_at', { ascending: false }),
      getExpensesBetween(dataUserId, prevRange.start, prevRange.end),
      supabase
        .from('financial_events')
        .select('event_type, amount, currency_code')
        .eq('telegram_user_id', dataUserId)
        .eq('event_type', 'income')
        .gte('created_at', prevRange.start.toISOString())
        .lt('created_at', prevRange.end.toISOString()),
      supabase
        .from('debts')
        .select('amount, currency_code')
        .eq('telegram_user_id', dataUserId)
        .eq('direction', 'borrowed')
        .eq('is_repayment', false)
        .gte('created_at', prevRange.start.toISOString())
        .lt('created_at', prevRange.end.toISOString()),
      Promise.all(historyOffsets.map(({ range }) => getExpensesBetween(dataUserId, range.start, range.end))),
      supabase
        .from('goals')
        .select('*')
        .eq('telegram_user_id', dataUserId)
        .eq('is_active', true)
        .order('created_at', { ascending: true }),
      getPortfolio(dataUserId),
      getPortfolioDigest(dataUserId, 3).catch((error) => {
        console.error('getPortfolioDigest error:', error);
        return null;
      }),
      computeNetByPerson(dataUserId),
      getLifetimeCashPosition(dataUserId),
      detectRecurringSubscriptions(dataUserId),
      supabase
        .from('debts')
        .select('id, person_name, amount, currency_code, note, created_at')
        .eq('telegram_user_id', dataUserId)
        .eq('direction', 'borrowed')
        .eq('is_repayment', false)
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString())
        .order('created_at', { ascending: false }),
      supabase
        .from('debts')
        .select('amount, direction')
        .eq('telegram_user_id', dataUserId)
        .gte('created_at', startOfDay.toISOString())
        .lt('created_at', endOfDay.toISOString()),
      getExpensesBetween(dataUserId, yearStart, yearEnd),
      hasActiveSubscription(dataUserId),
      getSubscriptionExpiry(dataUserId),
    ]);

    // ---- الاشتراك/التجربة: subInTrial محتاج نتيجة subActive الأول، فبيفضل استعلام إضافي واحد بس لو لازم ----
    const subInTrial = !subActive && (await isInTrial(dataUserId));
    const subTrialDaysLeft = subInTrial ? await getTrialDaysLeft(dataUserId) : 0;

    // ---- Financial Wrapped: بإعادة استخدام المصاريف اللي جابتها الدفعة فوق، من غير أي استعلام إضافي ----
    const weekWrapped = computeWrapped(weekExpenses, 'day', { periodLabel: `${weekStart.getDate()}/${weekStart.getMonth() + 1} - ${new Date(wrappedWeekEnd.getTime() - 86400000).getDate()}/${new Date(wrappedWeekEnd.getTime() - 86400000).getMonth() + 1}` });
    const monthWrapped = computeWrapped(monthExpenses, 'week', { periodLabel: MONTH_NAMES[start.getMonth()] });
    const yearWrapped = computeWrapped(yearExpenses, 'month', { year: start.getFullYear() });
    const wrapped = (weekWrapped || monthWrapped || yearWrapped)
      ? { week: weekWrapped, month: monthWrapped, year: yearWrapped }
      : null;

    // ---- مصاريف النهاردة ----
    const todayByCurrency = sumByCurrency(todayExpenses);
    const todayTotal = todayByCurrency.EGP || 0;

    // ---- توزيع صرف "الأسبوع الحالي" حسب الأيام (سبت -> جمعة)، مش الشهر كله ----
    const weekByCategory = buildCategoryBreakdown(weekExpenses).map(({ name, amount, percent }) => ({ name, amount: Number(amount), percent: Number(percent) }));
    const previousWeekByCategory = buildCategoryBreakdown(previousWeekExpenses).map(({ name, amount, percent }) => ({ name, amount: Number(amount), percent: Number(percent) }));

    const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
    const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
    const weekdayCategoryTotals = [{}, {}, {}, {}, {}, {}, {}];
    for (const e of weekExpenses) {
      const dayIdx = Math.floor((new Date(e.created_at) - weekStart) / (24 * 60 * 60 * 1000));
      if (dayIdx < 0 || dayIdx > 6) continue;
      weekdayTotals[dayIdx] += Number(e.amount);
      weekdayCounts[dayIdx] += 1;
      const cat = e.category || 'مصروف عام';
      weekdayCategoryTotals[dayIdx][cat] = (weekdayCategoryTotals[dayIdx][cat] || 0) + Number(e.amount);
    }

    const weekDates = [];
    const weekdayIsFuture = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      weekDates.push(`${d.getDate()}/${d.getMonth() + 1}`);
      weekdayIsFuture.push(d.getTime() > todayStart.getTime());
    }

    const byWeekday = weekdayTotals.map((total, i) => (weekdayIsFuture[i] ? null : Math.round(total)));
    const byWeekdayCount = weekdayCounts.map((count, i) => (weekdayIsFuture[i] ? null : count));
    const byWeekdayTopCategory = weekdayCategoryTotals.map((catTotals, i) => {
      if (weekdayIsFuture[i]) return null;
      const catEntries = Object.entries(catTotals);
      if (catEntries.length === 0) return null;
      const [name, amount] = catEntries.sort((a, b) => b[1] - a[1])[0];
      return { name, amount: Math.round(amount) };
    });
    const weekTotal = weekdayTotals.reduce((sum, v) => sum + v, 0);

    // ---- مصاريف الشهر الحالي ----
    const monthByCurrency = sumByCurrency(monthExpenses);
    const monthTotal = monthByCurrency.EGP || 0;
    if (eventsError) console.error('dashboard-data financial_events lookup error:', JSON.stringify(eventsError));
    const financialEvents = monthFinancialEvents || [];
    const incomeEvents = financialEvents.filter((event) => event.event_type === 'income');
    const incomeByCurrency = sumByCurrency(incomeEvents);
    const breakdown = buildCategoryBreakdown(monthExpenses);

    const daysPassedThisMonth = Math.max(
      1,
      Math.ceil((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000))
    );
    const avgPerDayThisMonth = Math.round(monthTotal / daysPassedThisMonth);
    const activeSpendingDaysThisMonth = new Set(
      monthExpenses.map((e) => new Date(e.created_at).toDateString())
    ).size;
    const avgPerActiveDay = Math.round(
      monthTotal / Math.max(1, activeSpendingDaysThisMonth)
    );

    // ---- الشهر اللي فات (للمقارنة) ----
    const prevTotal = prevExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const prevIncomeTotal = (prevFinancialEvents || []).reduce((sum, e) => (e.currency_code || 'EGP') === 'EGP' ? sum + Number(e.amount) : sum, 0);
    const prevBorrowedTotal = (prevBorrowedDebts || []).reduce((sum, d) => (d.currency_code || 'EGP') === 'EGP' ? sum + Number(d.amount) : sum, 0);
    const prevIncomeGrandTotal = prevIncomeTotal + prevBorrowedTotal;

    // ---- أرشيف آخر 4 شهور فاتت ----
    const history = [];
    historyOffsets.forEach(({ offset, range }, idx) => {
      const rangeExpenses = historyExpensesList[idx];
      if (!rangeExpenses || rangeExpenses.length === 0) return;
      const rangeTotal = rangeExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
      const rangeBreakdown = buildCategoryBreakdown(rangeExpenses);
      history.push({
        label: range.label,
        year: range.start.getFullYear(),
        total: rangeTotal,
        count: rangeExpenses.length,
        topCategoryName: rangeBreakdown[0]?.name || null,
        monthOffset: offset,
      });
    });

    // ---- الأهداف المالية النشطة (لحد 3) ----
    if (goalError) console.error('dashboard-data goal lookup error:', JSON.stringify(goalError));
    const goals = (goalRows || []).map((goalRow) => ({
      id: goalRow.id,
      title: goalRow.title,
      targetAmount: Number(goalRow.target_amount),
      savedAmount: Number(goalRow.saved_amount),
      targetDate: goalRow.target_date,
      percent: Math.min(100, Math.round((Number(goalRow.saved_amount) / Number(goalRow.target_amount)) * 100)),
    }));
    const goal = goals[0] || null;

    // ---- توقّع نهاية الشهر + اقتراح ذكي ----
    const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    const projectedTotal = Math.round(avgPerDayThisMonth * daysInMonth);
    const projectedDayLabel = MONTH_NAMES[start.getMonth()];

    let potentialSaving = 0;
    if (prevTotal > 0 && projectedTotal < prevTotal) {
      potentialSaving = Math.round(((prevTotal - projectedTotal) / 10)) * 10;
    }

    const smart = {
      projectedTotal,
      daysInMonth,
      daysPassed: daysPassedThisMonth,
      projectedLabel: projectedDayLabel,
      potentialSaving,
    };

    // ---- الديون ----
    const entries = Object.values(netByPerson).filter((v) => v.net !== 0);
    const owedToYou = entries.filter((v) => v.net > 0).sort((a, b) => b.net - a.net);
    const youOwe = entries.filter((v) => v.net < 0).sort((a, b) => a.net - b.net);
    const owedToYouTotal = owedToYou.reduce((sum, v) => sum + v.net, 0);
    const youOweTotal = youOwe.reduce((sum, v) => sum + Math.abs(v.net), 0);

    // ---- صافي الثروة ----
    const netWorth = lifetimeCash.cash + (owedToYouTotal - youOweTotal);

    // ---- سلف مستلَفة الشهر ده ----
    const borrowedThisMonth = (monthBorrowedDebts || []).map((d) => ({
      desc: `استلفت من ${d.person_name || 'حد'}${d.note ? ` — ${d.note}` : ''}`,
      amount: Number(d.amount),
      currency_code: d.currency_code || 'EGP',
      date: d.created_at,
      isDebt: true,
    }));
    const borrowedThisMonthTotal = borrowedThisMonth.reduce((sum, d) => sum + d.amount, 0);

    // ---- حركة السيولة اليومية (واصل من / واصل لـ) ----
    const flowIn = (todayFlowData || [])
      .filter(d => d.direction === 'borrowed')
      .reduce((sum, d) => sum + Number(d.amount), 0);
    const flowOut = (todayFlowData || [])
      .filter(d => d.direction === 'lent')
      .reduce((sum, d) => sum + Number(d.amount), 0);

    return res.status(200).json({
      linked,
      telegramUserId: linked ? telegramUserId : null,
      generatedAt: new Date().toISOString(),
      subscription: {
        active: subActive,
        expiresAt: subExpiresAt ? subExpiresAt.toISOString() : null,
        inTrial: subInTrial,
        trialDaysLeft: subTrialDaysLeft,
        priceEgp: SUBSCRIPTION_PRICE_EGP,
        instapayNumber: INSTAPAY_LINK,
      },
      activeDays,
      today: {
        total: todayTotal,
        count: todayExpenses.length,
        avgPerDayThisMonth,
        avgPerActiveDay,
          byCurrency: todayByCurrency,
          items: todayExpenses.map((e) => ({
          id: e.id,
          amount: Number(e.amount),
          currency_code: e.currency_code || 'EGP',
          category: e.category,
          description: e.description,
          created_at: e.created_at,
          source: e.source || null,
          source_bank_label: e.source_bank_label || null,
        })),
      },
      month: {
        label,
        total: monthTotal,
        byCurrency: monthByCurrency,
        incomeByCurrency,
        incomeTotal: (incomeByCurrency.EGP || 0) + borrowedThisMonthTotal,
        prevIncomeTotal: prevIncomeGrandTotal,
        incomeItems: [
          ...incomeEvents.map((e) => ({ desc: e.description || e.category || 'دخل', amount: Number(e.amount), currency_code: e.currency_code || 'EGP', date: e.created_at, isDebt: false })),
          ...borrowedThisMonth,
        ].sort((a, b) => new Date(b.date) - new Date(a.date)),
        financialEvents: financialEvents.map((event) => ({ ...event, amount: Number(event.amount), currency_code: event.currency_code || 'EGP' })),
        count: monthExpenses.length,
        prevTotal,
        prevLabel: MONTH_NAMES[prevRange.start.getMonth()],
        byCategory: breakdown.map((b) => ({ name: b.name, amount: b.amount, currency_code: b.currency_code || 'EGP', percent: Number(b.percent), items: b.items })),
        topCategory: breakdown[0] || null,
        byWeekday,
        byWeekdayCount,
        byWeekdayTopCategory,
        weekDates,
        weekTotal,
        weekByCategory,
        previousWeekByCategory,
        activeSpendingDaysThisMonth,
        avgPerActiveDay,
      },
      debts: {
        net: owedToYouTotal - youOweTotal,
        owedToYouTotal,
        youOweTotal,
        owedToYou: owedToYou.map((v) => ({ name: v.displayName, amount: v.net })),
        youOwe: youOwe.map((v) => ({ name: v.displayName, amount: Math.abs(v.net) })),
      },
      netWorth: {
        total: netWorth,
        cash: lifetimeCash.cash,
        owedToYouTotal,
        youOweTotal,
      },
      recurringSubscriptions,
      flow: {
        in: flowIn,
        out: flowOut,
        net: flowIn - flowOut
      },
      history,
      goal,
      goals,
      portfolio,
      portfolioDigest,
      smart,
      wrapped,
    });
  } catch (err) {
    console.error('dashboard-data error:', err);
    return res.status(500).json({ error: 'حصل خطأ في جلب البيانات، جرب تاني.' });
  }
}
