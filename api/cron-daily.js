import { supabase } from '../lib/supabaseClient.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { sendMonthlyReport, sendWeeklyReport, sendReportPdf } from '../lib/expensesReports.js';
import { getOldUnsettledDebtsSummary, recordDebtReminders } from '../lib/debts.js';
import { getAllUsers } from '../lib/users.js';
import { claimCronSlot } from '../lib/cronRuns.js';
import { cleanupOldPendingConfirmations } from '../lib/confirmations.js';
import { CRON_SECRET } from '../lib/config.js';

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

  let msg = `⏰ <b>تذكير بديون قديمة</b>\n━━━━━━━━━━━━━━━\n\n`;
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

// ============ كل التقارير/التذكيرات المطلوبة لمستخدم واحد ============
async function processUser(user, { isFriday, isLastDayOfMonth, monthKey }) {
  const { telegram_user_id: userId, chat_id: chatId, subscription_expires_at } = user;

  // نتجاهل المستخدمين اللي اشتراكهم مش فعّال — من غير اشتراك، مفيش تقارير ولا تذكيرات تتبعت
  const expiresAt = subscription_expires_at ? new Date(subscription_expires_at) : null;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    return { ok: true, skipped: 'not subscribed' };
  }

  try {
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

// ============ نقطة الدخول: بتتشغّل مرة كل يوم عن طريق Vercel Cron ============
export default async function handler(req, res) {
  // تأمين الـ endpoint: لو ضفت CRON_SECRET في Vercel، بيتفعّل التحقق تلقائيًا
  if (CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  // تنضيف أي تأكيد مبلغ معلّق من غير رد لأكتر من يوم (شوف lib/confirmations.js) — منفصل تمامًا
  // عن تقارير المستخدمين تحت، فبنسيبه يشتغل حتى لو فشل بشكل مستقل ومايوقفش باقي الكرون.
  cleanupOldPendingConfirmations().catch((e) => console.error('cleanupOldPendingConfirmations failed:', e));

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

  return res.status(200).json({ ok: true, total: users.length, processed, failed, isFriday, isLastDayOfMonth });
}
