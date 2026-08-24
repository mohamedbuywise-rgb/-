import { supabase } from '../lib/supabaseClient.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { getExpensesBetween, sendMonthlyReport, sendWeeklyReport, sendReportPdf } from '../lib/expenses.js';
import { getOldUnsettledDebtsSummary, recordDebtReminders } from '../lib/debts.js';
import { generateFriendlyReminderIntro } from '../lib/groq.js';
import { getAllUsers } from '../lib/users.js';
import { claimCronSlot } from '../lib/cronRuns.js';
import { CATEGORY_EMOJI, CRON_SECRET, ADMIN_TELEGRAM_ID, isModelsCheckOverdue } from '../lib/config.js';
import { claimPushRun, getNotificationPreferences, hasActivePushSubscription, sendPushToUser } from '../lib/webPush.js';

// عدد المستخدمين اللي بيتعالجوا بالتوازي في نفس الوقت، بدل ما نلف عليهم واحد واحد.
// بيوازن بين السرعة (منعديش الـ maxDuration بتاعة الفنكشن) وبين إننا منضربش Telegram/Supabase بـ rate limit.
const CONCURRENCY = 10;

// ============ تقرير آخر اليوم اللي فات (الكرون بيشتغل بعد نص الليل بشوية، فـ"اليوم" لسه بادئ من ثانية) ============
async function sendDailyReport(userId, chatId) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const { data: expenses } = await supabase
    .from('expenses')
    .select('amount, category, description')
    .eq('telegram_user_id', userId)
    .gte('created_at', startOfYesterday.toISOString())
    .lt('created_at', startOfToday.toISOString());

  // لو معملش أي حركة امبارح، متبعتش تقرير فاضي
  if (!expenses || expenses.length === 0) return;

  // حجز الفترة دي قبل الإرسال، عشان لو الكرون اشتغل مرتين بالغلط لنفس اليوم منبعتش نفس التقرير مرتين
  const periodKey = startOfYesterday.toISOString().slice(0, 10); // YYYY-MM-DD
  const claimed = await claimCronSlot(userId, 'daily', periodKey);
  if (!claimed) return;

  await sendReportPdf({
    chatId,
    title: 'ملخص اليوم',
    periodLabel: startOfYesterday.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
    expenses,
    filename: 'ملخص-اليوم.pdf',
  });
}

// ============ تذكير بالديون القديمة لمستخدم واحد (بكولداون 7 أيام لكل شخص، متحسوب جوه debts.js) ============
async function sendOldDebtsReminder(userId, chatId) {
  const oldOnes = await getOldUnsettledDebtsSummary(userId);
  if (!oldOnes) return;

  // --- جملة افتتاحية متنوعة بدل نص ثابت كل مرة (اختيارية: لو Groq فشل، بنرجع للعنوان الثابت المعتاد) ---
  const friendlyIntro = await generateFriendlyReminderIntro().catch(() => '');
  let msg = friendlyIntro
    ? `⏰ ${friendlyIntro}\n━━━━━━━━━━━━━━━\n\n`
    : `⏰ <b>تذكير بديون قديمة</b>\n━━━━━━━━━━━━━━━\n\n`;
  msg += `الديون دي عدّى عليها فترة من غير تسوية:\n\n`;
  for (const d of oldOnes) {
    const who = d.net > 0 ? `إنت ليك عند ${d.displayName} ${d.net} جنيه` : `إنت عليك لـ ${d.displayName} ${Math.abs(d.net)} جنيه`;
    msg += `• ${who} (من ${d.daysOld} يوم)\n`;
  }
  msg += `\nلو خلصتوا الحساب، ابعت "خلصت مع [الاسم]" عشان يتصفّر.`;

  await sendTelegramMessage(chatId, msg, 'HTML');

  // نسجّل إن التذكير اتبعت دلوقتي، عشان منكررهوش لنفس الأشخاص دول قبل ما تعدي 7 أيام
  await recordDebtReminders(userId, oldOnes.map((d) => d.displayName));
}

// ============ تشغيل مصفوفة من الدوال بالتوازي، بس بحد أقصى "limit" في نفس الوقت ============
async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      try {
        results[currentIndex] = await worker(items[currentIndex]);
      } catch (err) {
        results[currentIndex] = { error: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatPushAmount(amount) {
  return Number(amount || 0).toLocaleString('ar-EG', { maximumFractionDigits: 0 });
}

async function sendPushDailyReminder(userId, preferences, now) {
  if (!preferences.dailyReminderEnabled || now.getHours() !== preferences.dailyReminderHour) return;
  if (!(await hasActivePushSubscription(userId))) return;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);
  const todayExpenses = await getExpensesBetween(userId, startOfToday, endOfToday);
  if (todayExpenses.length > 0) return;

  const periodKey = localDateKey(startOfToday);
  if (!(await claimPushRun(userId, 'daily-reminder', periodKey))) return;
  await sendPushToUser(userId, {
    title: 'دبّر — فاكر مصاريفك؟',
    body: 'لسه مفيش مصروفات مسجلة النهارده. سجّل أول عملية في ثواني.',
    tag: 'daily-reminder',
    url: './dabbar-dashboard-full.html',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
  });
}

async function sendPushDailySummary(userId, preferences, now) {
  if (!preferences.dailySummaryEnabled || now.getHours() !== 0) return;
  if (!(await hasActivePushSubscription(userId))) return;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const expenses = await getExpensesBetween(userId, startOfYesterday, startOfToday);
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const byCategory = new Map();
  for (const expense of expenses) {
    const category = String(expense.category || 'مصروف عام');
    byCategory.set(category, (byCategory.get(category) || 0) + Number(expense.amount || 0));
  }
  const topCategory = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  const dayKey = localDateKey(startOfYesterday);
  if (!(await claimPushRun(userId, 'daily-summary', dayKey))) return;

  const dateLabel = startOfYesterday.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
  const operationLines = expenses.map((expense, index) => {
    const emoji = CATEGORY_EMOJI[expense.category] || '💸';
    const label = String(expense.description || expense.category || 'مصروف').trim().slice(0, 60);
    return `${index + 1}. ${emoji} ${label} — ${formatPushAmount(expense.amount)} جنيه`;
  });
  const body = expenses.length
    ? [`${dateLabel}`, `عدد العمليات: ${expenses.length}`, `الإجمالي: ${formatPushAmount(total)} جنيه`, `أكثر فئة: ${topCategory[0]} — ${formatPushAmount(topCategory[1])} جنيه`, '', ...operationLines].join('\n')
    : `${dateLabel}\nمفيش عمليات مسجلة امبارح. إجمالي الصرف: 0 جنيه.`;

  await sendPushToUser(userId, {
    title: 'دبّر — ملخص نهاية اليوم',
    body,
    tag: 'daily-summary',
    url: './dabbar-dashboard-full.html',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { type: 'daily-summary', date: dayKey, total, count: expenses.length, topCategory: topCategory?.[0] || null },
  });
}

async function sendPushWeeklySummary(userId, preferences, isFriday, now) {
  if (!preferences.weeklySummaryEnabled || !isFriday || now.getHours() !== preferences.dailyReminderHour) return;
  if (!(await hasActivePushSubscription(userId))) return;

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);
  const expenses = await getExpensesBetween(userId, weekStart, todayStart);
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const weekKey = `${localDateKey(weekStart)}:${localDateKey(todayStart)}`;
  if (!(await claimPushRun(userId, 'weekly-summary', weekKey))) return;
  await sendPushToUser(userId, {
    title: 'دبّر — ملخص أسبوعك',
    body: expenses.length ? `سجلت ${expenses.length} عملية بإجمالي ${formatPushAmount(total)} جنيه الأسبوع اللي فات.` : 'الأسبوع اللي فات مفيهوش مصروفات مسجلة.',
    tag: 'weekly-summary',
    url: './dabbar-dashboard-full.html',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
  });
}

// ============ كل التقارير/التذكيرات المطلوبة لمستخدم واحد ============
async function processUser(user, { isFriday, isLastDayOfMonth, monthKey }) {
  const { telegram_user_id: userId, chat_id: chatId, subscription_expires_at } = user;

  // نتجاهل المستخدمين اللي اشتراكهم مش فعّال — من غير اشتراك، مفيش تقارير ولا تذكيرات تتبعت
  const expiresAt = subscription_expires_at ? new Date(subscription_expires_at) : null;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    return { ok: true, skipped: 'not subscribed' };
  }

  try {
    const pushPreferences = await getNotificationPreferences(userId);
    const now = new Date();
    await sendPushDailyReminder(userId, pushPreferences, now).catch((error) => console.error(`Daily push failed for user ${userId}:`, error));
    await sendPushDailySummary(userId, pushPreferences, now).catch((error) => console.error(`Daily summary push failed for user ${userId}:`, error));
    await sendPushWeeklySummary(userId, pushPreferences, isFriday, now).catch((error) => console.error(`Weekly push failed for user ${userId}:`, error));

    // تذكير قبل انتهاء الاشتراك بـ 3 أيام أو أقل (مرة واحدة يوميًا لحد ما يجدد)
    const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (daysLeft <= 3) {
      const claimedRenewal = await claimCronSlot(userId, 'renewal_reminder', expiresAt.toISOString().slice(0, 10));
      if (claimedRenewal) {
        await sendTelegramMessage(
          chatId,
          `⏳ اشتراكك في دبّر هيخلص خلال ${daysLeft} يوم.\nابعت "اشتراكي" عشان تشوف تفاصيل التجديد.`
        );
      }
    }

    await sendDailyReport(userId, chatId);
    await sendOldDebtsReminder(userId, chatId);

    if (isFriday) {
      const claimed = await claimCronSlot(userId, 'weekly', new Date().toISOString().slice(0, 10));
      if (claimed) await sendWeeklyReport(userId, chatId);
    }

    if (isLastDayOfMonth) {
      const claimed = await claimCronSlot(userId, 'monthly', monthKey);
      // offset -1 عشان "الشهر الحالي" (offset 0) بقى الشهر الجديد اللي لسه بادئ
      if (claimed) await sendMonthlyReport(userId, chatId, -1);
    }

    return { ok: true };
  } catch (err) {
    console.error(`Cron failed for user ${userId}:`, err);
    return { ok: false, error: String(err) };
  }
}

// ============ نقطة الدخول: بتتشغّل مرة يوميًا عن طريق Vercel Cron ============
export default async function handler(req, res) {
  // تأمين الـ endpoint: لو ضفت CRON_SECRET في Vercel، بيتفعّل التحقق تلقائيًا
  if (CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const users = await getAllUsers();

  // الكرون بيشتغل بعد نص الليل بشوية، يعني "النهاردة" فعليًا هو اليوم الجديد.
  // فلما نيجي نحدد "هل امبارح كان جمعة" أو "هل امبارح كان آخر يوم في الشهر"، لازم نرجع يوم لورا.
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const isFriday = yesterday.getDay() === 5; // امبارح كان يوم جمعة (نهاية الأسبوع في مصر)
  const isLastDayOfMonth = today.getDate() === 1; // النهاردة أول يوم في الشهر، يعني امبارح كان آخر يوم في اللي فات
  // مفتاح الشهر اللي بنلخّصه (شهر "امبارح")، مستخدم في حجز الـ idempotency
  const monthKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}`;

  const results = await runWithConcurrencyLimit(users, CONCURRENCY, (user) =>
    processUser(user, { isFriday, isLastDayOfMonth, monthKey })
  );

  const processed = results.filter((r) => r && r.ok).length;
  const failed = results.length - processed;

  // ⚠️ تنبيه واحد يوميًا للأدمن (لو فعّل ADMIN_TELEGRAM_ID) لو عدّى 60 يوم من غير ما حد يتأكد
  // إن موديلات Groq (النص والفيجن) لسه شغالة ومفيش deprecation جديدة عليها. الكرون ده بيشتغل مرة يوميًا،
  // وclaimCronSlot بيضمن عدم التكرار لو حصل retry.
  if (ADMIN_TELEGRAM_ID && isModelsCheckOverdue()) {
    const periodKey = today.toISOString().slice(0, 10);
    const claimed = await claimCronSlot(ADMIN_TELEGRAM_ID, 'models-check-reminder', periodKey);
    if (claimed) {
      await sendTelegramMessage(
        ADMIN_TELEGRAM_ID,
        '⚠️ فاتت 60 يوم من غير ما تتأكد إن موديلات Groq (النص/الفيجن) لسه شغالة.\n' +
        'راجع: https://console.groq.com/docs/deprecations\n' +
        'وحدّث MODELS_LAST_VERIFIED في lib/config.js.'
      );
    }
  }

  return res.status(200).json({ ok: true, total: users.length, processed, failed, isFriday, isLastDayOfMonth });
}
