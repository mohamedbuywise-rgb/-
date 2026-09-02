import { supabase } from '../../lib/supabaseClient.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { getMonthRange, getExpensesBetween, buildCategoryBreakdown } from '../../lib/expenses.js';
import { computeNetByPerson } from '../../lib/debts.js';
import { getInvoicesList, getInvoiceDetail } from '../../lib/invoices.js';
import { MONTH_NAMES, CATEGORY_EMOJI, SUBSCRIPTION_PRICE_EGP, INSTAPAY_LINK } from '../../lib/config.js';
import { hasActiveSubscription, getSubscriptionExpiry, isInTrial, getTrialDaysLeft } from '../../lib/users.js';
import { getActiveDays } from '../../lib/activeDays.js';

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
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
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


    // ---- مصاريف النهاردة ----
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    const todayExpenses = await getExpensesBetween(dataUserId, startOfDay, endOfDay);
    const todayByCurrency = sumByCurrency(todayExpenses);
    // يظل today.total متوافقًا مع الواجهة القديمة (جنيه مصري)، بينما تعرض today.byCurrency كل العملات بدقة.
    const todayTotal = todayByCurrency.EGP || 0;

    // ---- توزيع صرف "الأسبوع الحالي" حسب الأيام (سبت -> جمعة)، مش الشهر كله ----
    // كل أسبوع بيتحدث لوحده (مش تراكمي)، والأيام اللي لسه ما جتش (بعد النهاردة) بترجع null
    // عشان الواجهة تعرضها فاضية بدل ما تفهم غلط إنها "صفر صرف".
    const WEEKDAY_NAMES_AR = ['السبت', 'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    // getDay(): 0=أحد ... 6=سبت. بنحسب كام يوم فاتوا من آخر سبت (لو النهاردة سبت نفسه، فرق=0)
    const daysSinceSaturday = (todayStart.getDay() - 6 + 7) % 7;
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - daysSinceSaturday);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const weekExpenses = await getExpensesBetween(dataUserId, weekStart, weekEnd);
    const previousWeekStart = new Date(weekStart);
    previousWeekStart.setDate(previousWeekStart.getDate() - 7);
    const previousWeekExpenses = await getExpensesBetween(dataUserId, previousWeekStart, weekStart);
    const weekByCategory = buildCategoryBreakdown(weekExpenses).map(({ name, amount, percent }) => ({ name, amount: Number(amount), percent: Number(percent) }));
    const previousWeekByCategory = buildCategoryBreakdown(previousWeekExpenses).map(({ name, amount, percent }) => ({ name, amount: Number(amount), percent: Number(percent) }));

    const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
    const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
    const weekdayCategoryTotals = [{}, {}, {}, {}, {}, {}, {}]; // { [category]: totalAmount } لكل يوم
    for (const e of weekExpenses) {
      const dayIdx = Math.floor((new Date(e.created_at) - weekStart) / (24 * 60 * 60 * 1000));
      if (dayIdx < 0 || dayIdx > 6) continue; // أمان زيادة، مش المفروض يحصل
      weekdayTotals[dayIdx] += Number(e.amount);
      weekdayCounts[dayIdx] += 1;
      const cat = e.category || 'مصروف عام';
      weekdayCategoryTotals[dayIdx][cat] = (weekdayCategoryTotals[dayIdx][cat] || 0) + Number(e.amount);
    }

    const weekDates = []; // تاريخ كل يوم في الأسبوع، بصيغة يوم/شهر مثلاً "16/8"
    const weekdayIsFuture = []; // true لو اليوم ده لسه ما جاش
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      weekDates.push(`${d.getDate()}/${d.getMonth() + 1}`);
      weekdayIsFuture.push(d.getTime() > todayStart.getTime());
    }

    // اليوم اللي فيه لسه ما خلصش (النهاردة) بيتعرض برقمه الحالي (مش فاضي)، وبعده بس بيبقى فاضي
    const byWeekday = weekdayTotals.map((total, i) => (weekdayIsFuture[i] ? null : Math.round(total)));
    const byWeekdayCount = weekdayCounts.map((count, i) => (weekdayIsFuture[i] ? null : count));
    // أكتر فئة صرف فيها في كل يوم من أيام الأسبوع الحالي (بيانات حقيقية، من نفس مصاريف الأسبوع فوق)
    const byWeekdayTopCategory = weekdayCategoryTotals.map((catTotals, i) => {
      if (weekdayIsFuture[i]) return null;
      const entries = Object.entries(catTotals);
      if (entries.length === 0) return null;
      const [name, amount] = entries.sort((a, b) => b[1] - a[1])[0];
      return { name, amount: Math.round(amount) };
    });
    const weekTotal = weekdayTotals.reduce((sum, v) => sum + v, 0);

    // ---- مصاريف الشهر الحالي ----
    const { start, end, label } = getMonthRange(0);
    const monthExpenses = await getExpensesBetween(dataUserId, start, end);
    const monthByCurrency = sumByCurrency(monthExpenses);
    const monthTotal = monthByCurrency.EGP || 0;
    const { data: monthFinancialEvents, error: eventsError } = await supabase
      .from('financial_events')
      .select('id, event_type, amount, currency_code, category, description, raw_text, direction, created_at')
      .eq('telegram_user_id', dataUserId)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: false });
    if (eventsError) console.error('dashboard-data financial_events lookup error:', JSON.stringify(eventsError));
    const financialEvents = monthFinancialEvents || [];
    const incomeEvents = financialEvents.filter((event) => event.event_type === 'income');
    const incomeByCurrency = sumByCurrency(incomeEvents);
    const breakdown = buildCategoryBreakdown(monthExpenses); // [{name, amount, percent, items}]

    const daysPassedThisMonth = Math.max(
      1,
      Math.ceil((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000))
    );
    // avgPerDayThisMonth (بالتقويم) بيتستخدم للتوقّع بتاع آخر الشهر فقط، لأنه محتاج
    // كل أيام الشهر اللي عدت حتى اللي مفيهاش صرف، عشان يعمل extrapolation صحيح.
    const avgPerDayThisMonth = Math.round(monthTotal / daysPassedThisMonth);

    // متوسط الصرف "الحقيقي" اللي بيتعرض للمستخدم لازم يتقسم على أيام الصرف الفعلية
    // (مش كل أيام الشهر اللي عدت)، عشان أول يوم في الشهر ميبقاش المتوسط = إجمالي الشهر.
    const activeSpendingDaysThisMonth = new Set(
      monthExpenses.map((e) => new Date(e.created_at).toDateString())
    ).size;
    const avgPerActiveDay = Math.round(
      monthTotal / Math.max(1, activeSpendingDaysThisMonth)
    );



    // ---- الشهر اللي فات (للمقارنة) ----
    const prevRange = getMonthRange(-1);
    const prevExpenses = await getExpensesBetween(dataUserId, prevRange.start, prevRange.end);
    const prevTotal = prevExpenses.reduce((sum, e) => sum + Number(e.amount), 0);

    // ---- دخل الشهر السابق (نفس منطق الشهر الحالي: event + سلف مستلَفة) عشان نقارن ----
    const { data: prevFinancialEvents } = await supabase
      .from('financial_events')
      .select('event_type, amount, currency_code')
      .eq('telegram_user_id', dataUserId)
      .eq('event_type', 'income')
      .gte('created_at', prevRange.start.toISOString())
      .lt('created_at', prevRange.end.toISOString());
    const prevIncomeTotal = (prevFinancialEvents || []).reduce((sum, e) => (e.currency_code || 'EGP') === 'EGP' ? sum + Number(e.amount) : sum, 0);
    const { data: prevBorrowedDebts } = await supabase
      .from('debts')
      .select('amount, currency_code')
      .eq('telegram_user_id', dataUserId)
      .eq('direction', 'borrowed')
      .eq('is_repayment', false)
      .gte('created_at', prevRange.start.toISOString())
      .lt('created_at', prevRange.end.toISOString());
    const prevBorrowedTotal = (prevBorrowedDebts || []).reduce((sum, d) => (d.currency_code || 'EGP') === 'EGP' ? sum + Number(d.amount) : sum, 0);
    const prevIncomeGrandTotal = prevIncomeTotal + prevBorrowedTotal;

    // ---- أرشيف آخر 4 شهور فاتت (بيانات حقيقية من جدول expenses، مش تلخيص محفوظ منفصل) ----
    const history = [];
    for (let offset = -1; offset >= -4; offset--) {
      const range = getMonthRange(offset);
      const rangeExpenses = await getExpensesBetween(dataUserId, range.start, range.end);
      if (rangeExpenses.length === 0) continue;
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
    }

    // ---- الهدف المالي النشط (لو موجود) — نفس جدول goals اللي البوت بيستخدمه ----
    const { data: goalRow, error: goalError } = await supabase
      .from('goals')
      .select('*')
      .eq('telegram_user_id', dataUserId)
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
    const netByPerson = await computeNetByPerson(dataUserId);
    const entries = Object.values(netByPerson).filter((v) => v.net !== 0);
    const owedToYou = entries.filter((v) => v.net > 0).sort((a, b) => b.net - a.net);
    const youOwe = entries.filter((v) => v.net < 0).sort((a, b) => a.net - b.net);
    const owedToYouTotal = owedToYou.reduce((sum, v) => sum + v.net, 0);
    const youOweTotal = youOwe.reduce((sum, v) => sum + Math.abs(v.net), 0);

    // ---- سلف مستلَفة الشهر ده — بتتحسب ضمن "الدخل" برضو لأن فلوس دخلت إيدك فعليًا، حتى لو دين ----
    const { data: monthBorrowedDebts } = await supabase
      .from('debts')
      .select('id, person_name, amount, currency_code, note, created_at')
      .eq('telegram_user_id', dataUserId)
      .eq('direction', 'borrowed')
      .eq('is_repayment', false)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: false });
    const borrowedThisMonth = (monthBorrowedDebts || []).map((d) => ({
      desc: `استلفت من ${d.person_name || 'حد'}${d.note ? ` — ${d.note}` : ''}`,
      amount: Number(d.amount),
      currency_code: d.currency_code || 'EGP',
      date: d.created_at,
      isDebt: true,
    }));
    const borrowedThisMonthTotal = borrowedThisMonth.reduce((sum, d) => sum + d.amount, 0);

    // ---- حركة السيولة اليومية (واصل من / واصل لـ) ----
    const { data: todayFlowData } = await supabase
      .from('debts')
      .select('amount, direction')
      .eq('telegram_user_id', dataUserId)
      .gte('created_at', startOfDay.toISOString())
      .lt('created_at', endOfDay.toISOString());

    const flowIn = (todayFlowData || [])
      .filter(d => d.direction === 'borrowed')
      .reduce((sum, d) => sum + Number(d.amount), 0);
    const flowOut = (todayFlowData || [])
      .filter(d => d.direction === 'lent')
      .reduce((sum, d) => sum + Number(d.amount), 0);

    // ---- "Financial Wrapped" — أسبوعي/شهري/سنوي، كل واحد باستعلام واحد بس عشان يفضل خفيف ----
    const DISCRETIONARY_CATEGORIES = ['تسوق', 'ترفيه', 'اشتراكات', 'هدايا وتبرعات', 'شخصي وعناية'];

    const AR_DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    // unit بيحدد إزاي نقسم الفترة لوحدات فرعية عشان نلاقي "أحسن" وحدة ماليًا جواها:
    // أسبوعي -> نقسم بالأيام، شهري -> نقسم بالأسابيع، سنوي -> نقسم بالشهور
    async function computeWrapped(periodStart, periodEnd, unit, extraFields = {}) {
      const expenses = await getExpensesBetween(dataUserId, periodStart, periodEnd);
      if (expenses.length === 0) return null;

      const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
      const breakdown = buildCategoryBreakdown(expenses);
      const discretionaryTotal = breakdown
        .filter((c) => DISCRETIONARY_CATEGORIES.includes(c.name))
        .reduce((sum, c) => sum + Number(c.amount), 0);
      const savedEstimate = Math.round((discretionaryTotal * 0.2) / 10) * 10;

      const buckets = {};
      for (const e of expenses) {
        const d = new Date(e.created_at);
        let key, label;
        if (unit === 'day') {
          key = d.toDateString();
          label = AR_DAY_NAMES[d.getDay()];
        } else if (unit === 'week') {
          const weekIndex = Math.floor((d.getDate() - 1) / 7) + 1;
          key = `w${weekIndex}`;
          label = `الأسبوع ${weekIndex}`;
        } else {
          key = d.getMonth();
          label = MONTH_NAMES[d.getMonth()];
        }
        if (!buckets[key]) buckets[key] = { label, total: 0 };
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

    // الأسبوع الحالي (بنعيد استخدام weekStart/weekEnd المحسوبين فوق، متسقين مع باقي التطبيق)
    const wrappedWeekEnd = new Date(weekStart);
    wrappedWeekEnd.setDate(wrappedWeekEnd.getDate() + 7);

    const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
    const monthEnd = new Date(start.getFullYear(), start.getMonth() + 1, 1);

    const yearStart = new Date(start.getFullYear(), 0, 1);
    const yearEnd = new Date(start.getFullYear() + 1, 0, 1);

    const [weekWrapped, monthWrapped, yearWrapped] = await Promise.all([
      computeWrapped(weekStart, wrappedWeekEnd, 'day', { periodLabel: `${weekStart.getDate()}/${weekStart.getMonth() + 1} - ${new Date(wrappedWeekEnd.getTime() - 86400000).getDate()}/${new Date(wrappedWeekEnd.getTime() - 86400000).getMonth() + 1}` }),
      computeWrapped(monthStart, monthEnd, 'week', { periodLabel: MONTH_NAMES[monthStart.getMonth()] }),
      computeWrapped(yearStart, yearEnd, 'month', { year: start.getFullYear() }),
    ]);

    const wrapped = (weekWrapped || monthWrapped || yearWrapped)
      ? { week: weekWrapped, month: monthWrapped, year: yearWrapped }
      : null;

    // ---- حالة الاشتراك/التجربة ----
    const subActive = await hasActiveSubscription(dataUserId);
    const subExpiresAt = await getSubscriptionExpiry(dataUserId);
    const subInTrial = !subActive && (await isInTrial(dataUserId));
    const subTrialDaysLeft = subInTrial ? await getTrialDaysLeft(dataUserId) : 0;

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
