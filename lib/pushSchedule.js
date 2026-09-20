import { supabase } from './supabaseClient.js';
import { getExpensesBetween } from './expenses.js';
import { buildReminderMessage, getRemindersNeedingNotification } from './reminders.js';
import { PREFERENCE_COLUMNS, LEGACY_PREFERENCE_COLUMNS, claimPushRun, cleanPreferences, isPushConfigured, sendPushToUser } from './webPush.js';

// ============================================================================
// جدولة إشعارات الـ Push لكل مستخدم حسب وقته وتوقيته المحلي.
//
// الفكرة: الدالة دي بتتنده كل 5 دقايق (من Supabase pg_cron أو cron-job.org عن طريق /api/push-cron)،
// وكمان من cron-daily كاحتياطي. في كل تشغيل بنسأل: مين وقته المحلي حان؟
// وclaimPushRun (جدول push_notification_runs) بيضمن إن نفس الإشعار مايتبعتش مرتين لنفس اليوم.
// ============================================================================

// الإشعار بيتبعت بس لو عدّى على الميعاد أقل من الفترة دي (دقايق). لو الـ scheduler وقع ساعة+،
// مبنبعتش تذكير الساعة 8 الصبح الساعة 6 المغرب.
export const SEND_WINDOW_MINUTES = 60;
const CONCURRENCY = 10;
const ID_CHUNK = 200;

const pad = (n) => String(n).padStart(2, '0');

// ---------- أدوات التوقيت (من غير الاعتماد على TZ بتاع السيرفر) ----------
const formatterCache = new Map();
function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// الوقت المحلي (في منطقة زمنية معينة) لحظة معينة
export function zonedParts(date, timeZone) {
  const raw = {};
  for (const part of getFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') raw[part.type] = part.value;
  }
  const year = Number(raw.year);
  const month = Number(raw.month);
  const day = Number(raw.day);
  return {
    year,
    month,
    day,
    hour: Number(raw.hour) % 24,
    minute: Number(raw.minute),
    second: Number(raw.second),
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
  };
}

function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// لحظة بداية اليوم المحلي (00:00) كـ Date (UTC)
export function startOfLocalDay(dateKey, timeZone) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - tzOffsetMs(new Date(first), timeZone));
}

export function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// 0 = الأحد ... 6 = السبت
export function weekdayOf(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// هل الوقت المحلي الحالي داخل نافذة الإرسال بعد الميعاد المطلوب (بالدقايق من بداية اليوم)؟
// بترجّع اليوم اللي الميعاد بتاعه ده (ممكن يكون امبارح لو الميعاد 23:50 والوقت دلوقتي 00:10).
export function dueSlot(parts, targetMinutes, windowMinutes = SEND_WINDOW_MINUTES) {
  let diff = parts.hour * 60 + parts.minute - targetMinutes;
  let dateKey = parts.dateKey;
  if (diff < 0) {
    diff += 1440;
    dateKey = addDays(dateKey, -1);
  }
  return diff < windowMinutes ? { dateKey, minutesLate: diff } : null;
}

// ---------- محتوى الإشعارات ----------
const APP_URL = './dabbar-dashboard-full.html';
const ICON = './icons/icon-192.png';

function formatPushAmount(amount) {
  return Number(amount || 0).toLocaleString('ar-EG', { maximumFractionDigits: 0 });
}

const reminderMinutes = (prefs) => prefs.dailyReminderHour * 60 + prefs.dailyReminderMinute;

// ---------- التذكير اليومي (لو مفيش مصروفات النهارده) ----------
function dailyReminderSlot(prefs, parts) {
  if (!prefs.dailyReminderEnabled) return null;
  return dueSlot(parts, reminderMinutes(prefs));
}

async function sendDailyReminder(userId, prefs, slot) {
  const start = startOfLocalDay(slot.dateKey, prefs.timezone);
  const end = startOfLocalDay(addDays(slot.dateKey, 1), prefs.timezone);
  const todayExpenses = await getExpensesBetween(userId, start, end);
  const presenceEnabled = prefs.dailyPresenceEnabled !== false;
  const reminderEnabled = prefs.dailyReminderEnabled !== false;
  if (!presenceEnabled && !reminderEnabled) return 'disabled';

  // رسالة دبّر اليومية والتذكير اليومي يخرجان من نفس النافذة حتى لا يصل إشعاران متتاليان.
  const claimType = presenceEnabled ? 'daily-presence' : 'daily-reminder';
  if (!(await claimPushRun(userId, claimType, slot.dateKey))) return 'already_sent';
  const hasExpenses = todayExpenses.length > 0;
  const payload = presenceEnabled
    ? hasExpenses
      ? { title: 'دبّر موجود معاك 🌱', body: 'ممتاز، دبّر شايف متابعتك النهارده. خطوة صغيرة كل يوم تصنع فرقًا كبيرًا.', tag: 'daily-presence' }
      : { title: 'دبّر موجود معاك 🤝', body: reminderEnabled ? 'لسه مفيش مصروفات مسجلة النهارده. لو صرفت حاجة، سجّلها في ثواني.' : 'لو احتجت ترتّب فلوسك النهارده، دبّر موجود معاك.', tag: 'daily-presence' }
    : { title: 'دبّر — فاكر مصاريفك؟', body: 'لسه مفيش مصروفات مسجلة النهارده. سجّل أول عملية في ثواني.', tag: 'daily-reminder' };
  await sendPushToUser(userId, { ...payload, url: APP_URL, icon: ICON, badge: ICON });
  return 'sent';
}

// ---------- ملخص نهاية اليوم (بعد منتصف الليل بتوقيت المستخدم) ----------
function dailySummarySlot(prefs, parts) {
  if (!prefs.dailySummaryEnabled) return null;
  return dueSlot(parts, 0);
}

async function sendDailySummary(userId, prefs, slot) {
  const todayKey = slot.dateKey;
  const yesterdayKey = addDays(todayKey, -1);
  const startOfToday = startOfLocalDay(todayKey, prefs.timezone);
  const startOfYesterday = startOfLocalDay(yesterdayKey, prefs.timezone);
  const expenses = await getExpensesBetween(userId, startOfYesterday, startOfToday);
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const byCategory = new Map();
  for (const expense of expenses) {
    const category = String(expense.category || 'مصروف عام');
    byCategory.set(category, (byCategory.get(category) || 0) + Number(expense.amount || 0));
  }
  const topCategory = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!(await claimPushRun(userId, 'daily-summary', yesterdayKey))) return 'already_sent';

  const dateLabel = startOfYesterday.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: prefs.timezone });
  const body = expenses.length
    ? [`${dateLabel}`, `عدد العمليات: ${expenses.length}`, `الإجمالي: ${formatPushAmount(total)} جنيه`, `أكثر فئة: ${topCategory[0]} — ${formatPushAmount(topCategory[1])} جنيه`, '', 'يومك جاهز بشكل حلو — افتح دبّر وشاركه مع صحابك.'].join('\n')
    : `${dateLabel}\nمفيش عمليات مسجلة امبارح. إجمالي الصرف: 0 جنيه.`;

  await sendPushToUser(userId, {
    title: 'دبّر — يومك جاهز 🎉',
    body,
    tag: 'daily-summary',
    url: APP_URL,
    icon: ICON,
    badge: ICON,
    data: { type: 'daily-summary', date: yesterdayKey, total, count: expenses.length, topCategory: topCategory?.[0] || null },
  });
  return 'sent';
}

// ---------- الملخص الأسبوعي (صباح السبت، في وقت تذكير المستخدم) ----------
function weeklySummarySlot(prefs, parts) {
  if (!prefs.weeklySummaryEnabled) return null;
  const slot = dueSlot(parts, reminderMinutes(prefs));
  return slot && weekdayOf(slot.dateKey) === 6 ? slot : null;
}

async function sendWeeklySummary(userId, prefs, slot) {
  const weekStartKey = addDays(slot.dateKey, -7);
  const expenses = await getExpensesBetween(userId, startOfLocalDay(weekStartKey, prefs.timezone), startOfLocalDay(slot.dateKey, prefs.timezone));
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  if (!(await claimPushRun(userId, 'weekly-summary', `${weekStartKey}:${slot.dateKey}`))) return 'already_sent';
  await sendPushToUser(userId, {
    title: 'دبّر — ملخص أسبوعك',
    body: expenses.length ? `سجلت ${expenses.length} عملية بإجمالي ${formatPushAmount(total)} جنيه الأسبوع اللي فات.` : 'الأسبوع اللي فات مفيهوش مصروفات مسجلة.',
    tag: 'weekly-summary',
    url: APP_URL,
    icon: ICON,
    badge: ICON,
  });
  return 'sent';
}

// ---------- تذكير مواعيد الدفع (يومين قبل / يوم قبل / يوم الاستحقاق) بنفس وقت التذكير اليومي ----------
function paymentRemindersSlot(prefs, parts) {
  if (!prefs.paymentRemindersEnabled) return null;
  return dueSlot(parts, reminderMinutes(prefs));
}

function plainText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

async function sendPaymentReminders(userId, prefs, slot, ctx) {
  const list = await ctx.remindersFor(userId);
  if (!list.length) return 'none';
  let sent = 0;
  for (const r of list) {
    // مفتاح لكل تذكير ولكل مرحلة، فالإشعار بيتبعت مرة واحدة حتى لو الـ scheduler اشتغل مرات كتير
    if (!(await claimPushRun(userId, 'payment-reminder', `${r.id}:${r.stage}`))) continue;
    let body = '';
    try { body = plainText(buildReminderMessage(r.title, r.stage)); } catch { /* نرجع للنص البديل */ }
    await sendPushToUser(userId, {
      title: 'دبّر — تذكير بموعد دفع 🗓️',
      body: body || `تذكير: ${r.title}`,
      tag: `payment-reminder-${r.id}`,
      url: APP_URL,
      icon: ICON,
      badge: ICON,
    });
    sent += 1;
  }
  return sent ? 'sent' : 'already_sent';
}

// بنجيب التذكيرات المستحقة مرة واحدة بس في التشغيلة، وبس لو فيه حد محتاجها
function makeContext() {
  let byUser = null;
  return {
    async remindersFor(userId) {
      if (!byUser) {
        const rows = await getRemindersNeedingNotification().catch((error) => {
          console.error('getRemindersNeedingNotification failed:', error?.message || error);
          return [];
        });
        byUser = new Map();
        for (const r of rows || []) {
          const key = String(r.telegram_user_id);
          if (!byUser.has(key)) byUser.set(key, []);
          byUser.get(key).push(r);
        }
      }
      return byUser.get(String(userId)) || [];
    },
  };
}

const TASKS = [
  { name: 'daily-reminder', slot: dailyReminderSlot, run: sendDailyReminder },
  { name: 'payment-reminders', slot: paymentRemindersSlot, run: sendPaymentReminders },
  { name: 'daily-summary', slot: dailySummarySlot, run: sendDailySummary },
  { name: 'weekly-summary', slot: weeklySummarySlot, run: sendWeeklySummary },
];

// ---------- جلب المستخدمين اللي عندهم اشتراك فعّال + تفضيلاتهم ----------
async function getActivePushUserIds() {
  const ids = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('telegram_user_id')
      .eq('is_active', true)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data || []) ids.add(row.telegram_user_id);
    if (!data || data.length < PAGE) break;
  }
  return [...ids];
}

async function getPreferencesMap(userIds) {
  const map = new Map();
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const chunk = userIds.slice(i, i + ID_CHUNK);
    let { data, error } = await supabase
      .from('notification_preferences')
      .select(`telegram_user_id, ${PREFERENCE_COLUMNS}`)
      .in('telegram_user_id', chunk);
    if (error && JSON.stringify(error).toLowerCase().includes('daily_presence_enabled')) {
      // قواعد البيانات القديمة لا تحتوي العمود السابع؛ نكمل بباقي الإعدادات بدل تعطيل الجدولة كلها.
      ({ data, error } = await supabase
        .from('notification_preferences')
        .select(`telegram_user_id, ${LEGACY_PREFERENCE_COLUMNS}`)
        .in('telegram_user_id', chunk));
    }
    if (error) throw error;
    for (const row of data || []) map.set(String(row.telegram_user_id), cleanPreferences(row));
  }
  return map;
}

async function runWithConcurrencyLimit(items, limit, worker) {
  let next = 0;
  async function loop() {
    while (next < items.length) {
      const item = items[next++];
      try { await worker(item); } catch (error) { console.error('push schedule worker error:', error?.message || error); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, loop));
}

// ============ نقطة الدخول ============
export async function runPushSchedule({ now = new Date() } = {}) {
  const summary = { users: 0, due: 0, sent: 0, skipped: 0, failed: 0 };
  if (!isPushConfigured()) return { ...summary, note: 'vapid_not_configured' };

  const userIds = await getActivePushUserIds();
  summary.users = userIds.length;
  if (!userIds.length) return summary;

  const prefsMap = await getPreferencesMap(userIds);

  // نحدد مين محتاج إيه قبل ما نعمل أي استعلام تاني (أغلب التشغيلات مفيهاش أي حد مستحق)
  const jobs = [];
  for (const userId of userIds) {
    const prefs = prefsMap.get(String(userId)) || cleanPreferences(null);
    const parts = zonedParts(now, prefs.timezone);
    for (const task of TASKS) {
      const slot = task.slot(prefs, parts);
      if (slot) jobs.push({ userId, prefs, slot, task });
    }
  }
  summary.due = jobs.length;

  const ctx = makeContext();
  await runWithConcurrencyLimit(jobs, CONCURRENCY, async ({ userId, prefs, slot, task }) => {
    try {
      const result = await task.run(userId, prefs, slot, ctx);
      if (result === 'sent') summary.sent += 1; else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`push ${task.name} failed for user ${userId}:`, error?.message || error);
    }
  });
  return summary;
}
