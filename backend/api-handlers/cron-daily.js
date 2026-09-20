import { supabase } from '../../lib/supabaseClient.js';
import { sendTelegramMessage } from '../../lib/telegram.js';
import { sendMonthlyReport, sendWeeklyReport, sendReportPdf } from '../../lib/expenses.js';
import { getOldUnsettledDebtsSummary, recordDebtReminders } from '../../lib/debts.js';
import { getRemindersNeedingNotification, markReminderNotified, buildReminderMessage } from '../../lib/reminders.js';
import { generateFriendlyReminderIntro } from '../../lib/groq.js';
import { getAllUsers } from '../../lib/users.js';
import { claimCronSlot } from '../../lib/cronRuns.js';
import { refreshPortfolioMarketPrices, savePortfolioSnapshot, getPortfolioDigest, buildPortfolioDigestMessage, checkPortfolioPriceAlerts, buildPortfolioAlertTelegramMessage, buildPortfolioAlertPushPayload } from '../../lib/investments.js';
import { CATEGORY_EMOJI, CRON_SECRET, ADMIN_TELEGRAM_ID, isModelsCheckOverdue } from '../../lib/config.js';
import { hasActivePushSubscription, sendPushToUser } from '../../lib/webPush.js';
import { runPushSchedule } from '../../lib/pushSchedule.js';
import { getUsersNeedingTrialReminder, getSubscriptionState, formatTrialReminder, markTrialReminderSent } from '../../lib/subscriptionAccess.js';

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

// ============ تسجيل صورة يومية من المحفظة الاستثمارية (لكل المستخدمين، بيانات فقط ومفيش رسالة) ============
async function saveDailyPortfolioSnapshot(userId) {
  const claimed = await claimCronSlot(userId, 'portfolio_snapshot', new Date().toISOString().slice(0, 10));
  if (!claimed) return;
  await savePortfolioSnapshot(userId).catch((error) => console.error(`Portfolio snapshot failed for user ${userId}:`, error));
}

// ============ تنبيهات حركة سعر أصل استثماري (يوميًا) — Push لكل المستخدمين، وتليجرام للمرتبطين المشتركين بس ============
async function sendPortfolioPriceAlerts(userId, chatId, telegramLinked, isSubscribed) {
  const claimed = await claimCronSlot(userId, 'portfolio_price_alerts', new Date().toISOString().slice(0, 10));
  if (!claimed) return;

  const alerts = await checkPortfolioPriceAlerts(userId).catch((error) => {
    console.error(`checkPortfolioPriceAlerts failed for user ${userId}:`, error);
    return [];
  });
  if (!alerts.length) return;

  for (const alert of alerts) {
    if (await hasActivePushSubscription(userId)) {
      await sendPushToUser(userId, buildPortfolioAlertPushPayload(alert)).catch((error) => console.error(`Portfolio alert push failed for user ${userId}:`, error));
    }
    if (telegramLinked && isSubscribed) {
      await sendTelegramMessage(chatId, buildPortfolioAlertTelegramMessage(alert), 'HTML').catch((error) => console.error(`Portfolio alert telegram failed for user ${userId}:`, error));
    }
  }
}

// ============ ملخص حركة المحفظة كل 3 أيام (Telegram) — بس للمشتركين المرتبطين بتليجرام ============
// بنستخدم يوم الإبوك (عدد الأيام من 1970) مقسوم على 3 كـ"دور" ثابت، فكل 3 أيام بالظبط بيتبعت ملخص واحد
// لكل مستخدم، مهما كان وقت أول تسجيل بتاعه (مفيش حاجة مربوطة بتاريخ تسجيله شخصيًا).
async function sendPortfolioDigestIfDue(userId, chatId) {
  const epochDay = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const cycleKey = String(Math.floor(epochDay / 3));
  const claimed = await claimCronSlot(userId, 'portfolio_digest', cycleKey);
  if (!claimed) return;

  const digest = await getPortfolioDigest(userId, 3).catch((error) => {
    console.error(`getPortfolioDigest failed for user ${userId}:`, error);
    return null;
  });
  if (!digest) return; // مفيش صورة قديمة كفاية للمقارنة لسه (مستخدم جديد على المحفظة)

  const message = buildPortfolioDigestMessage(digest);
  if (message) await sendTelegramMessage(chatId, message, 'HTML');
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
async function processUser(user, { isFriday, isLastDayOfMonth, monthKey, remindersByUser }) {
  const { telegram_user_id: userId, chat_id: chatId, subscription_expires_at } = user;
  const expiresAt = subscription_expires_at ? new Date(subscription_expires_at) : null;
  const isSubscribed = !!expiresAt && expiresAt.getTime() > Date.now();

  try {
    // تحديث أسعار السوق (ذهب/عملات رقمية) في المحفظة الاستثمارية — مرة واحدة يوميًا، لكل المستخدمين
    // (مش مربوط بالاشتراك، بيانات فقط ومفيش رسالة بتتبعت)
    const claimedPriceSync = await claimCronSlot(userId, 'portfolio_price_sync', new Date().toISOString().slice(0, 10));
    if (claimedPriceSync) {
      await refreshPortfolioMarketPrices(userId).catch((error) => console.error(`Portfolio price sync failed for user ${userId}:`, error));
    }
    // تسجيل صورة يومية من المحفظة — بيانات فقط، لكل المستخدمين، مش مربوط بالاشتراك
    // ملحوظة: بنجيب تنبيهات حركة الأسعار الأول (بيقارن بأمس) قبل ما نكتب صورة النهاردة فوقها
    const telegramLinkedEarly = Number(userId) > 0 && Number(chatId) > 0;
    await sendPortfolioPriceAlerts(userId, chatId, telegramLinkedEarly, isSubscribed).catch((error) => console.error(`Portfolio price alerts failed for user ${userId}:`, error));
    await saveDailyPortfolioSnapshot(userId);

    // إشعارات الـ push (تذكير يومي / ملخص يومي / ملخص أسبوعي) اتنقلت لـ lib/pushSchedule.js
    // وبتتبعت لكل مستخدم في وقته المحلي عن طريق /api/push-cron (كل 5 دقايق) — راجع PUSH_NOTIFICATIONS_SETUP.md

    // من هنا تحت: تقارير وتذكيرات Telegram — دي مخصوصة للمشتركين فعليًا بس
    if (!isSubscribed) {
      return { ok: true, pushOnly: true, skipped: 'not subscribed' };
    }

    // الحساب المستقل يستفيد من كل إشعارات المتصفح، لكن لا نرسل له أي رسالة
    // عبر Telegram لأن chat_id هنا placeholder سالب وليس Chat حقيقيًا.
    const telegramLinked = telegramLinkedEarly;
    if (!telegramLinked) return { ok: true, pushOnly: true };

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
    await sendPortfolioDigestIfDue(userId, chatId).catch((error) => console.error(`Portfolio digest failed for user ${userId}:`, error));

    // ---- تنبيهات التذكيرات (يومين قبل / يوم قبل / يوم الاستحقاق) — مفيش أي AI هنا، رسالة ثابتة بس ----
    const userReminders = remindersByUser?.[userId] || [];
    for (const r of userReminders) {
      try {
        await sendTelegramMessage(chatId, buildReminderMessage(r.title, r.stage));
        await markReminderNotified(r.id, r.stage);
      } catch (error) {
        console.error(`Reminder notification failed for user ${userId}, reminder ${r.id}:`, error);
      }
    }

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

  const trialReminderUsers = await getUsersNeedingTrialReminder().catch((error) => {
    console.error('getUsersNeedingTrialReminder failed:', error);
    return [];
  });
  await runWithConcurrencyLimit(trialReminderUsers, CONCURRENCY, async (user) => {
    if (!user.chat_id || Number(user.chat_id) <= 0) return { ok: true };
    const state = await getSubscriptionState(user.telegram_user_id);
    if (state.status !== 'trial') return { ok: true };
    await sendTelegramMessage(user.chat_id, formatTrialReminder(state), 'HTML');
    await markTrialReminderSent(user.telegram_user_id);
    return { ok: true };
  });

  // التذكيرات المستحقة تنبيه النهاردة (يومين قبل / يوم قبل / يوم الاستحقاق) — بنجيبها مرة واحدة بس لكل المستخدمين
  const dueReminders = await getRemindersNeedingNotification().catch((error) => {
    console.error('getRemindersNeedingNotification failed:', error);
    return [];
  });
  const remindersByUser = dueReminders.reduce((acc, r) => {
    (acc[r.telegram_user_id] = acc[r.telegram_user_id] || []).push(r);
    return acc;
  }, {});

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
    processUser(user, { isFriday, isLastDayOfMonth, monthKey, remindersByUser })
  );

  const processed = results.filter((r) => r && r.ok).length;
  const failed = results.length - processed;

  // احتياطي: نفس جدولة الـ push الخاصة بكل مستخدم (idempotent بفضل push_notification_runs).
  // الشغل الأساسي بيتم من /api/push-cron كل 5 دقايق، والسطر ده بيغطي لو الـ scheduler الخارجي وقع.
  const push = await runPushSchedule().catch((error) => {
    console.error('runPushSchedule (fallback) failed:', error);
    return { error: String(error?.message || error) };
  });

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

  return res.status(200).json({ ok: true, total: users.length, processed, failed, isFriday, isLastDayOfMonth, push });
}
