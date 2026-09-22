import crypto from 'node:crypto';
import webpush from 'web-push';
import { supabase } from './supabaseClient.js';
import { VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT } from './config.js';
import { getDashboardUserFromToken as getAuthDashboardUserFromToken } from './dashboardAuth.js';

let vapidConfigured = false;

// قيم متغيرات البيئة أحيانًا بتتنسخ ومعاها مسافة/سطر جديد/علامات اقتباس أو بصيغة base64 عادية بدل base64url — بنطبّعها.
function cleanVapidValue(value) {
  return String(value || '').trim().replace(/^["']+|["']+$/g, '').trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// المفتاح العام بيتحسب دايمًا من المفتاح الخاص نفسه. أي خطأ 403 من Chrome كان معناه إن VAPID_PUBLIC_KEY و VAPID_PRIVATE_KEY في Vercel
// مش زوج واحد؛ بحساب العام من الخاص بقى مستحيل يحصل عدم تطابق، حتى لو VAPID_PUBLIC_KEY في Vercel غلط أو مش موجود.
export function getVapidPublicKey() {
  const privateKey = cleanVapidValue(VAPID_PRIVATE_KEY);
  if (privateKey) {
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
      return ecdh.getPublicKey().toString('base64url');
    } catch (error) {
      console.error('VAPID_PRIVATE_KEY is not a valid P-256 private key:', error?.message || error);
    }
  }
  return cleanVapidValue(VAPID_PUBLIC_KEY);
}

// للتشخيص فقط: هل VAPID_PUBLIC_KEY في Vercel بيطابق المفتاح الخاص؟ (null = مش مضبوط)
export function vapidEnvPublicKeyMatches() {
  const configured = cleanVapidValue(VAPID_PUBLIC_KEY);
  if (!configured) return null;
  return configured === getVapidPublicKey();
}

function ensureVapid() {
  if (vapidConfigured) return true;
  const publicKey = getVapidPublicKey();
  const privateKey = cleanVapidValue(VAPID_PRIVATE_KEY);
  if (!publicKey || !privateKey || !VAPID_SUBJECT) return false;
  try {
    webpush.setVapidDetails(String(VAPID_SUBJECT).trim(), publicKey, privateKey);
  } catch (error) {
    console.error('web-push VAPID setup failed:', error?.message || error);
    return false;
  }
  vapidConfigured = true;
  return true;
}

export function isPushConfigured() {
  return ensureVapid();
}

export async function getDashboardUserFromToken(token) {
  const user = await getAuthDashboardUserFromToken(token);
  if (!user) return null;
  return {
    authUserId: user.authUserId,
    telegramUserId: user.dataUserId,
    dataUserId: user.dataUserId,
    linked: user.linked,
  };
}

function normalizeSubscription(subscription) {
  const endpoint = String(subscription?.endpoint || '').trim();
  const p256dh = String(subscription?.keys?.p256dh || '').trim();
  const auth = String(subscription?.keys?.auth || '').trim();
  if (!endpoint || !p256dh || !auth || endpoint.length > 2000 || p256dh.length > 500 || auth.length > 500) return null;
  return { endpoint, p256dh, auth };
}

export async function savePushSubscription({ authUserId, telegramUserId, subscription, userAgent = '' }) {
  const normalized = normalizeSubscription(subscription);
  if (!normalized) throw new Error('اشتراك الإشعارات غير صالح.');

  const { data, error } = await supabase
    .from('push_subscriptions')
    .upsert({
      auth_user_id: authUserId,
      telegram_user_id: telegramUserId,
      endpoint: normalized.endpoint,
      p256dh: normalized.p256dh,
      auth: normalized.auth,
      user_agent: String(userAgent || '').slice(0, 500),
      is_active: true,
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' })
    .select('id, endpoint, is_active')
    .single();
  if (error) throw error;
  return data;
}

export async function removePushSubscription({ authUserId, endpoint }) {
  const cleanEndpoint = String(endpoint || '').trim();
  if (!cleanEndpoint) return;
  const { error } = await supabase
    .from('push_subscriptions')
    .update({ is_active: false, updated_at: new Date().toISOString(), last_error: 'removed_by_user' })
    .eq('auth_user_id', authUserId)
    .eq('endpoint', cleanEndpoint);
  if (error) throw error;
}

const DEFAULT_PREFERENCES = {
  dailyReminderEnabled: true,
  dailySummaryEnabled: true,
  weeklySummaryEnabled: true,
  budgetAlertEnabled: true,
  bankMovementEnabled: true,
  paymentRemindersEnabled: true,
  dailyPresenceEnabled: true,
  subscriptionAlertsEnabled: true,
  largeExpenseEnabled: true,
  dailyReminderHour: 8,
  dailyReminderMinute: 0,
  budgetAlertThreshold: 0.80,
  timezone: 'Africa/Cairo',
};

// أعمدة تفضيلات الإشعارات (نفس القايمة في كل الاستعلامات).
// الأعمدة "الاختيارية" اتضافت على مراحل؛ لو قاعدة البيانات لسه ما اتحدّثتش (migration ما اتشغلتش)، بنرجع للأعمدة الأساسية
// بدل ما نوقف حفظ/قراءة الإعدادات كلها.
const BASE_PREFERENCE_COLUMNS = 'daily_reminder_enabled, daily_summary_enabled, weekly_summary_enabled, budget_alert_enabled, bank_movement_enabled, payment_reminders_enabled, daily_reminder_hour, daily_reminder_minute, budget_alert_threshold, timezone';
const OPTIONAL_PREFERENCE_COLUMNS = ['daily_presence_enabled', 'subscription_alerts_enabled', 'large_expense_enabled'];
export const PREFERENCE_COLUMNS = `${BASE_PREFERENCE_COLUMNS}, ${OPTIONAL_PREFERENCE_COLUMNS.join(', ')}`;
export const LEGACY_PREFERENCE_COLUMNS = BASE_PREFERENCE_COLUMNS;

export function isMissingOptionalPreferenceColumn(error) {
  const text = JSON.stringify(error || {}).toLowerCase();
  const mentionsColumn = OPTIONAL_PREFERENCE_COLUMNS.some((column) => text.includes(column));
  return mentionsColumn && (text.includes('schema cache') || text.includes('does not exist') || text.includes('pgrst204') || text.includes('pgrst205') || text.includes('42703'));
}

// بيتأكد إن اسم المنطقة الزمنية صالح (مثال: Africa/Cairo) وإلا بيرجّع القيمة الافتراضية
export function normalizeTimeZone(value, fallback = DEFAULT_PREFERENCES.timezone) {
  const tz = String(value || '').trim();
  if (!tz || tz.length > 64) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

export function cleanPreferences(row) {
  return {
    dailyReminderEnabled: row?.daily_reminder_enabled ?? DEFAULT_PREFERENCES.dailyReminderEnabled,
    dailySummaryEnabled: row?.daily_summary_enabled ?? DEFAULT_PREFERENCES.dailySummaryEnabled,
    weeklySummaryEnabled: row?.weekly_summary_enabled ?? DEFAULT_PREFERENCES.weeklySummaryEnabled,
    budgetAlertEnabled: row?.budget_alert_enabled ?? DEFAULT_PREFERENCES.budgetAlertEnabled,
    bankMovementEnabled: row?.bank_movement_enabled ?? DEFAULT_PREFERENCES.bankMovementEnabled,
    paymentRemindersEnabled: row?.payment_reminders_enabled ?? DEFAULT_PREFERENCES.paymentRemindersEnabled,
    dailyPresenceEnabled: row?.daily_presence_enabled ?? DEFAULT_PREFERENCES.dailyPresenceEnabled,
    subscriptionAlertsEnabled: row?.subscription_alerts_enabled ?? DEFAULT_PREFERENCES.subscriptionAlertsEnabled,
    largeExpenseEnabled: row?.large_expense_enabled ?? DEFAULT_PREFERENCES.largeExpenseEnabled,
    dailyReminderHour: Number.isInteger(Number(row?.daily_reminder_hour)) ? Number(row.daily_reminder_hour) : DEFAULT_PREFERENCES.dailyReminderHour,
    dailyReminderMinute: Number.isInteger(Number(row?.daily_reminder_minute)) ? Number(row.daily_reminder_minute) : DEFAULT_PREFERENCES.dailyReminderMinute,
    budgetAlertThreshold: Number(row?.budget_alert_threshold || DEFAULT_PREFERENCES.budgetAlertThreshold),
    timezone: normalizeTimeZone(row?.timezone),
  };
}

export async function getNotificationPreferences(telegramUserId) {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select(PREFERENCE_COLUMNS)
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();
  if (error && isMissingOptionalPreferenceColumn(error)) {
    // توافق مؤقت مع قواعد البيانات التي لم تُشغّل migration الأعمدة الجديدة بعد.
    const legacy = await supabase
      .from('notification_preferences')
      .select(LEGACY_PREFERENCE_COLUMNS)
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();
    if (!legacy.error) return cleanPreferences(legacy.data);
  }
  if (error) {
    console.error('notification preferences lookup error:', JSON.stringify(error));
    return DEFAULT_PREFERENCES;
  }
  return cleanPreferences(data);
}

export async function saveNotificationPreferences({ authUserId, telegramUserId, preferences }) {
  const dailyReminderHour = Math.min(23, Math.max(0, Math.round(Number(preferences?.dailyReminderHour ?? 8))));
  const dailyReminderMinute = Math.min(59, Math.max(0, Math.round(Number(preferences?.dailyReminderMinute ?? 0))));
  const threshold = Math.min(1, Math.max(0.5, Number(preferences?.budgetAlertThreshold ?? 0.8)));
  const payload = {
    auth_user_id: authUserId,
    telegram_user_id: telegramUserId,
    daily_reminder_enabled: preferences?.dailyReminderEnabled !== false,
    daily_summary_enabled: preferences?.dailySummaryEnabled !== false,
    weekly_summary_enabled: preferences?.weeklySummaryEnabled !== false,
    budget_alert_enabled: preferences?.budgetAlertEnabled !== false,
    bank_movement_enabled: preferences?.bankMovementEnabled !== false,
    payment_reminders_enabled: preferences?.paymentRemindersEnabled !== false,
    daily_presence_enabled: preferences?.dailyPresenceEnabled !== false,
    subscription_alerts_enabled: preferences?.subscriptionAlertsEnabled !== false,
    large_expense_enabled: preferences?.largeExpenseEnabled !== false,
    daily_reminder_hour: Number.isFinite(dailyReminderHour) ? dailyReminderHour : 8,
    daily_reminder_minute: Number.isFinite(dailyReminderMinute) ? dailyReminderMinute : 0,
    timezone: normalizeTimeZone(preferences?.timezone),
    budget_alert_threshold: Number.isFinite(threshold) ? threshold : 0.8,
    updated_at: new Date().toISOString(),
  };
  let { data, error } = await supabase
    .from('notification_preferences')
    .upsert(payload, { onConflict: 'auth_user_id' })
    .select(PREFERENCE_COLUMNS)
    .single();
  if (error && isMissingOptionalPreferenceColumn(error)) {
    // نحفظ بقية الإعدادات فورًا حتى قبل تشغيل migration؛ الخيارات الجديدة تظل افتراضيًا مفعّلة.
    const legacyPayload = { ...payload };
    for (const column of OPTIONAL_PREFERENCE_COLUMNS) delete legacyPayload[column];
    ({ data, error } = await supabase
      .from('notification_preferences')
      .upsert(legacyPayload, { onConflict: 'auth_user_id' })
      .select(LEGACY_PREFERENCE_COLUMNS)
      .single());
  }
  if (error) throw error;
  return cleanPreferences(data);
}

async function getActiveSubscriptions(telegramUserId) {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('telegram_user_id', telegramUserId)
    .eq('is_active', true);
  if (error) {
    console.error('push subscriptions lookup error:', JSON.stringify(error));
    return [];
  }
  return data || [];
}

export async function hasActivePushSubscription(telegramUserId) {
  if (!ensureVapid()) return false;
  const subscriptions = await getActiveSubscriptions(telegramUserId);
  return subscriptions.length > 0;
}

// options.urgency: 'high' للإشعارات اللي لازم توصل فورًا (حركة بنكية/تذكير) — بدونها أندرويد ممكن يأخّرها لما الموبايل يبقى خامل (Doze).
export async function sendPushToUser(telegramUserId, payload, options = {}) {
  if (!ensureVapid()) return { sent: 0, skipped: 'vapid_not_configured' };
  const subscriptions = await getActiveSubscriptions(telegramUserId);
  if (!subscriptions.length) return { sent: 0, skipped: 'no_active_subscription' };

  const urgency = ['very-low', 'low', 'normal', 'high'].includes(options.urgency) ? options.urgency : 'normal';
  let sent = 0;
  let failed = 0;
  let removed = 0;
  const errors = [];
  for (const row of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
        { TTL: Number(options.ttl) > 0 ? Number(options.ttl) : 86400, urgency }
      );
      sent += 1;
      await supabase.from('push_subscriptions').update({ last_used_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq('id', row.id);
    } catch (error) {
      failed += 1;
      const status = Number(error?.statusCode || 0);
      // 404/410 = الاشتراك اتلغى من المتصفح. 401/403 = الاشتراك اتعمل بمفاتيح VAPID مختلفة (مش هيشتغل أبدًا) → نعطّله
      // عشان الداشبورد يكتشفه ويعمل اشتراك جديد تلقائيًا.
      const inactive = [404, 410, 401, 403].includes(status);
      if (inactive) removed += 1;
      const message = String(error?.body || error?.message || error).slice(0, 300);
      errors.push({ status, message });
      await supabase.from('push_subscriptions').update({ is_active: !inactive, last_error: `${status || 'ERR'}: ${message}`.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', row.id);
      console.error('web push send error:', status, message);
    }
  }
  return { sent, failed, removed, errors };
}

export async function claimPushRun(telegramUserId, notificationType, periodKey) {
  const { error } = await supabase
    .from('push_notification_runs')
    .insert({ telegram_user_id: telegramUserId, notification_type: notificationType, period_key: periodKey });
  if (!error) return true;
  if (error.code === '23505') return false;
  console.error('push run claim error:', JSON.stringify(error));
  return false;
}

// لو الإرسال فشل بعد ما حجزنا المفتاح، بنحرره عشان المحاولة الجاية (أو إعادة الاختبار) تنجح بدل ما يفضل محجوز لليوم كله.
export async function releasePushRun(telegramUserId, notificationType, periodKey) {
  try {
    await supabase
      .from('push_notification_runs')
      .delete()
      .eq('telegram_user_id', telegramUserId)
      .eq('notification_type', notificationType)
      .eq('period_key', periodKey);
  } catch (error) {
    console.error('push run release error:', error?.message || error);
  }
}

// حجز + إرسال + تحرير عند الفشل، في خطوة واحدة.
export async function sendClaimedPush(telegramUserId, notificationType, periodKey, payload, options = {}) {
  if (!(await hasActivePushSubscription(telegramUserId))) return { sent: 0, skipped: 'no_active_subscription' };
  if (!(await claimPushRun(telegramUserId, notificationType, periodKey))) return { sent: 0, skipped: 'already_sent' };
  const result = await sendPushToUser(telegramUserId, payload, options);
  if (!result.sent) await releasePushRun(telegramUserId, notificationType, periodKey);
  return result;
}

function monthStart() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
}

function fmt(amount) {
  return Number(amount || 0).toLocaleString('ar-EG', { maximumFractionDigits: 0 });
}

export async function maybeSendBudgetAlert(telegramUserId) {
  if (!ensureVapid()) return { sent: 0, skipped: 'vapid_not_configured' };
  const preferences = await getNotificationPreferences(telegramUserId);
  if (!preferences.budgetAlertEnabled) return { sent: 0, skipped: 'disabled' };

  const { data: settings, error: settingsError } = await supabase
    .from('financial_settings')
    .select('monthly_income, monthly_budget, category_budgets, balance_categories')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();
  if (settingsError || !settings) return { sent: 0, skipped: 'no_budget' };

  const monthlyIncome = Number(settings.monthly_income || 0);
  const monthlyBudget = Number(settings.monthly_budget || 0);
  const categoryBudgets = settings.category_budgets && typeof settings.category_budgets === 'object' ? settings.category_budgets : {};
  if (monthlyIncome <= 0 && monthlyBudget <= 0 && !Object.values(categoryBudgets).some((value) => Number(value) > 0)) return { sent: 0, skipped: 'no_budget' };

  const start = monthStart();
  const { data: expenses, error: expensesError } = await supabase
    .from('expenses')
    .select('amount, category')
    .eq('telegram_user_id', telegramUserId)
    .gte('created_at', start.toISOString());
  if (expensesError) return { sent: 0, skipped: 'expenses_error' };

  const total = (expenses || []).reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const categoryTotals = {};
  for (const expense of expenses || []) categoryTotals[expense.category] = (categoryTotals[expense.category] || 0) + Number(expense.amount || 0);

  const threshold = preferences.budgetAlertThreshold;
  const alerts = [];
  if (monthlyBudget > 0 && total >= monthlyBudget * threshold) {
    alerts.push({ key: 'total', title: 'قربت من ميزانيتك الشهرية', body: `صرفك وصل لـ ${fmt(total)} من ${fmt(monthlyBudget)} جنيه (${Math.round(total / monthlyBudget * 100)}%).`, tag: 'budget-total' });
  }
  for (const [category, budgetValue] of Object.entries(categoryBudgets)) {
    const budget = Number(budgetValue || 0);
    const spent = Number(categoryTotals[category] || 0);
    if (budget > 0 && spent >= budget * threshold) {
      alerts.push({ key: `category:${category}`, title: `ميزانية ${category} قربت تخلص`, body: `صرفك في ${category} وصل لـ ${fmt(spent)} من ${fmt(budget)} جنيه.`, tag: `budget-${category}` });
    }
  }

  // مؤشرات التوازن: نفس القاموس الموجود في الكارت، برسالة تشجيعية وبدون إزعاج متكرر.
  if (monthlyIncome > 0 && total > 0) {
    const needsCategories = new Set(['أكل', 'مواصلات', 'فواتير', 'صحة', 'تعليم', 'منزل وأثاث']);
    const overrides = settings.balance_categories && typeof settings.balance_categories === 'object' ? settings.balance_categories : {};
    const isNeeds = (category) => (overrides[category] || (needsCategories.has(category) ? 'needs' : 'wants')) === 'needs';
    const needs = Object.entries(categoryTotals).filter(([category]) => isNeeds(category)).reduce((sum, [, amount]) => sum + amount, 0);
    // أي فئة جديدة غير موجودة في الاحتياجات تُعامل كرغبة افتراضيًا.
    const wants = Object.entries(categoryTotals).filter(([category]) => !isNeeds(category)).reduce((sum, [, amount]) => sum + amount, 0);
    const savings = Math.max(0, monthlyIncome - total);
    if (needs >= monthlyIncome * 0.50) alerts.push({ key: 'balance:needs-50', title: 'وصلت لحد الاحتياجات بهدوء', body: `احتياجاتك وصلت لـ ${fmt(needs)} جنيه. راقبها براحة، وإنت لسه ماسك زمام خطتك.`, tag: 'balance-needs-50' });
    if (wants >= monthlyIncome * 0.30) alerts.push({ key: 'balance:wants-30', title: 'إنت قريب من توازن رغباتك', body: `الرغبات وصلت لـ ${fmt(wants)} جنيه. وقفة صغيرة دلوقتي تساعدك تحافظ على باقي الشهر.`, tag: 'balance-wants-30' });
    if (savings >= monthlyIncome * 0.20) alerts.push({ key: 'balance:savings-20', title: 'برافو — حققت هدف الادخار', body: `فاضلك ${fmt(savings)} جنيه من دخلك، يعني وصلت تقريبًا لهدف ادخار الـ٢٠٪. كمّل بنفس القوة!`, tag: 'balance-savings-20' });
  }

  const results = [];
  const monthKey = start.toISOString().slice(0, 7);
  for (const alert of alerts) {
    const hasSubscription = await hasActivePushSubscription(telegramUserId);
    if (!hasSubscription) break;
    const claimed = await claimPushRun(telegramUserId, 'budget', `${monthKey}:${alert.key}`);
    if (!claimed) continue;
    results.push(await sendPushToUser(telegramUserId, {
      title: `دبّر — ${alert.title}`,
      body: alert.body,
      tag: alert.tag,
      url: './dabbar-dashboard-full.html',
      icon: './icons/icon-192.png',
      badge: './icons/badge-mono-96.png',
    }));
  }
  return results;
}

const CURRENCY_LABELS = { EGP: 'جنيه', USD: 'دولار', EUR: 'يورو', SAR: 'ريال', AED: 'درهم', GBP: 'جنيه إسترليني' };
function currencyLabel(code) {
  const upper = String(code || 'EGP').trim().toUpperCase();
  return CURRENCY_LABELS[upper] || String(code || 'جنيه');
}

// ============ إشعار فوري لكل حركة بنكية (SMS) ============
// الاستخدام (من sms-webhook.js بعد ما الحركة تتسجل):
//   await sendBankMovementPush(userId, { direction: 'out' | 'in', kind, amount, currency, merchant, bank, balance })
// كل رسالة بنك جديدة = إشعار جديد. التكرار (نفس الرسالة وصلت مرتين) بيتمنع قبل كده في sms-webhook عن طريق بصمة الرسالة،
// فمش محتاجين هنا "مفتاح دائم" (كان بيمنع أي إعادة إرسال لنفس النص لأبد). dedupeKey لسه مدعوم لو حد عايزه صراحة.
export async function sendBankMovementPush(telegramUserId, movement = {}) {
  try {
    if (!ensureVapid()) return { sent: 0, skipped: 'vapid_not_configured' };
    const preferences = await getNotificationPreferences(telegramUserId);
    if (!preferences.bankMovementEnabled) return { sent: 0, skipped: 'disabled' };
    if (!(await hasActivePushSubscription(telegramUserId))) return { sent: 0, skipped: 'no_active_subscription' };

    const amount = Math.abs(Number(movement.amount));
    if (!Number.isFinite(amount) || amount <= 0) return { sent: 0, skipped: 'no_amount' };

    const dedupeKey = String(movement.dedupeKey ?? movement.id ?? '').trim().slice(0, 120);
    if (dedupeKey && !(await claimPushRun(telegramUserId, 'bank-movement', dedupeKey))) return { sent: 0, skipped: 'duplicate' };

    const direction = String(movement.direction ?? '').toLowerCase();
    const incoming = ['in', 'incoming', 'income', 'credit', 'deposit', 'received', 'إيداع', 'دخل', 'وارد'].includes(direction);
    const kind = String(movement.kind || '').toLowerCase();
    const currency = currencyLabel(movement.currency);
    const place = String(movement.merchant ?? movement.description ?? movement.counterparty ?? '').trim().slice(0, 80);
    const bank = String(movement.bank ?? movement.bankName ?? '').trim().slice(0, 40);
    const balance = movement.balance === undefined || movement.balance === null || movement.balance === '' ? null : Number(movement.balance);

    const verb = kind === 'transfer' ? (incoming ? 'تحويل وارد' : 'تحويل صادر')
      : kind === 'withdrawal' ? 'سحب'
        : kind === 'refund' ? 'استرداد'
          : incoming ? 'إيداع' : 'خصم';
    const lines = [`${verb}: ${fmt(amount)} ${currency}`];
    if (place) lines.push(place);
    if (bank) lines.push(`${bank}`);
    if (Number.isFinite(balance)) lines.push(`الرصيد: ${fmt(balance)} ${currency}`);

    const result = await sendPushToUser(telegramUserId, {
      title: incoming ? 'دبّر — فلوس دخلت حسابك 💰' : 'دبّر — حركة جديدة على حسابك 💳',
      body: lines.join('\n'),
      tag: `bank-movement-${dedupeKey || Date.now()}`,
      url: './dabbar-dashboard-full.html',
      icon: './icons/icon-192.png',
      badge: './icons/badge-mono-96.png',
    }, { urgency: 'high' });
    if (!result.sent && dedupeKey) await releasePushRun(telegramUserId, 'bank-movement', dedupeKey);
    return result;
  } catch (error) {
    console.error('bank movement push error:', error?.message || error);
    return { sent: 0, failed: 1 };
  }
}

// ============ تنبيه مصروف كبير أو أكبر من المعتاد بكتير ============
// الاستخدام (من الدالة اللي بتسجل المصروف، بعد ما يتسجل):
//   await maybeSendLargeExpenseAlert(userId, { id, amount, category, description })
// القاعدة: المبلغ >= LARGE_EXPENSE_MIN_AMOUNT و >= (LARGE_EXPENSE_MULTIPLIER × متوسط مصروفات آخر 30 يوم)،
// ومحتاج على الأقل LARGE_EXPENSE_MIN_SAMPLES مصروف سابق عشان المتوسط يبقى له معنى. حد أقصى LARGE_EXPENSE_DAILY_CAP تنبيه في اليوم.
const LARGE_EXPENSE_MULTIPLIER = 3;
const LARGE_EXPENSE_MIN_AMOUNT = 300;
const LARGE_EXPENSE_MIN_SAMPLES = 8;
const LARGE_EXPENSE_DAILY_CAP = 3;
const LARGE_EXPENSE_LOOKBACK_DAYS = 30;

export async function maybeSendLargeExpenseAlert(telegramUserId, expense = {}) {
  try {
    const amount = Number(expense.amount);
    // خروج سريع من غير أي استعلام للمصاريف الصغيرة (أغلب الحالات)
    if (!Number.isFinite(amount) || amount < LARGE_EXPENSE_MIN_AMOUNT) return { sent: 0, skipped: 'below_minimum' };
    if (!ensureVapid()) return { sent: 0, skipped: 'vapid_not_configured' };
    const preferences = await getNotificationPreferences(telegramUserId);
    if (!preferences.largeExpenseEnabled) return { sent: 0, skipped: 'disabled' };
    if (!(await hasActivePushSubscription(telegramUserId))) return { sent: 0, skipped: 'no_active_subscription' };

    const since = new Date(Date.now() - LARGE_EXPENSE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('expenses')
      .select('amount')
      .eq('telegram_user_id', telegramUserId)
      .gte('created_at', since)
      .limit(500);
    if (error) return { sent: 0, skipped: 'expenses_error' };

    const amounts = (data || []).map((row) => Number(row.amount)).filter((n) => Number.isFinite(n) && n > 0);
    // لو المصروف اتسجل قبل ما نحسب، نشيله من المتوسط عشان ما يرفعوش
    if (expense.alreadyRecorded !== false) {
      const at = amounts.indexOf(amount);
      if (at >= 0) amounts.splice(at, 1);
    }
    if (amounts.length < LARGE_EXPENSE_MIN_SAMPLES) return { sent: 0, skipped: 'not_enough_history' };
    const average = amounts.reduce((sum, n) => sum + n, 0) / amounts.length;
    if (!(average > 0) || amount < average * LARGE_EXPENSE_MULTIPLIER) return { sent: 0, skipped: 'normal_amount' };

    const dayKey = new Date().toISOString().slice(0, 10);
    const { data: todays } = await supabase
      .from('push_notification_runs')
      .select('id')
      .eq('telegram_user_id', telegramUserId)
      .eq('notification_type', 'large-expense')
      .like('period_key', `${dayKey}:%`);
    if ((todays || []).length >= LARGE_EXPENSE_DAILY_CAP) return { sent: 0, skipped: 'daily_cap' };

    const uniquePart = expense.id ?? `${amount}-${Date.now()}`;
    const label = String(expense.description || expense.category || '').trim().slice(0, 60);
    const ratio = Math.max(2, Math.round(amount / average));
    return await sendClaimedPush(telegramUserId, 'large-expense', `${dayKey}:${uniquePart}`, {
      title: 'دبّر — مصروف أكبر من المعتاد 🚨',
      body: [`${fmt(amount)} جنيه${label ? ` — ${label}` : ''}`, `ده حوالي ${ratio} ${ratio <= 10 ? 'أضعاف' : 'ضعف'} متوسط مصروفاتك (${fmt(average)} جنيه).`].join('\n'),
      tag: `large-expense-${uniquePart}`,
      url: './dabbar-dashboard-full.html',
      icon: './icons/icon-192.png',
      badge: './icons/badge-mono-96.png',
    }, { urgency: 'high' });
  } catch (error) {
    console.error('large expense alert error:', error?.message || error);
    return { sent: 0, failed: 1 };
  }
}

// ============ تشخيص الإشعارات (بتستخدمه الداشبورد: حالة الجهاز على الخادم + إشعار تجريبي) ============
export async function getPushSubscriptionStatus(telegramUserId, endpoint = '') {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, is_active, last_error, last_used_at, telegram_user_id')
    .eq('telegram_user_id', telegramUserId);
  if (error) {
    console.error('push status lookup error:', JSON.stringify(error));
    return { error: 'lookup_failed', activeCount: 0, thisDevice: null };
  }
  const rows = data || [];
  const cleanEndpoint = String(endpoint || '').trim();
  const mine = cleanEndpoint ? rows.find((row) => row.endpoint === cleanEndpoint) : null;
  return {
    activeCount: rows.filter((row) => row.is_active).length,
    thisDevice: mine ? { registered: true, active: Boolean(mine.is_active), lastError: mine.last_error || null, lastUsedAt: mine.last_used_at || null } : { registered: false, active: false, lastError: null, lastUsedAt: null },
  };
}

export async function sendTestPush(telegramUserId) {
  if (!ensureVapid()) return { sent: 0, skipped: 'vapid_not_configured' };
  return sendPushToUser(telegramUserId, {
    title: 'دبّر — إشعار تجريبي ✅',
    body: 'لو شايف الرسالة دي، الإشعارات شغّالة على جهازك تمام.',
    tag: 'dabbar-test-push',
    renotify: true,
    url: './dabbar-dashboard-full.html',
    icon: './icons/icon-192.png',
    badge: './icons/badge-mono-96.png',
  }, { urgency: 'high', ttl: 600 });
}

export { DEFAULT_PREFERENCES };
