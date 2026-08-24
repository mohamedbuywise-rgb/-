import webpush from 'web-push';
import { supabase } from './supabaseClient.js';
import { VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT } from './config.js';

let vapidConfigured = false;

function ensureVapid() {
  if (vapidConfigured) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
  return true;
}

export function isPushConfigured() {
  return ensureVapid();
}

export async function getDashboardUserFromToken(token) {
  if (!token) return null;
  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) return null;

  const { data: link, error: linkError } = await supabase
    .from('user_links')
    .select('auth_user_id, telegram_user_id')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  if (linkError) {
    console.error('push user_links lookup error:', JSON.stringify(linkError));
    return null;
  }
  if (!link) return null;
  return { authUserId: userData.user.id, telegramUserId: link.telegram_user_id };
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
  dailyReminderHour: 8,
  budgetAlertThreshold: 0.80,
};

function cleanPreferences(row) {
  return {
    dailyReminderEnabled: row?.daily_reminder_enabled ?? DEFAULT_PREFERENCES.dailyReminderEnabled,
    dailySummaryEnabled: row?.daily_summary_enabled ?? DEFAULT_PREFERENCES.dailySummaryEnabled,
    weeklySummaryEnabled: row?.weekly_summary_enabled ?? DEFAULT_PREFERENCES.weeklySummaryEnabled,
    budgetAlertEnabled: row?.budget_alert_enabled ?? DEFAULT_PREFERENCES.budgetAlertEnabled,
    dailyReminderHour: Number.isInteger(Number(row?.daily_reminder_hour)) ? Number(row.daily_reminder_hour) : DEFAULT_PREFERENCES.dailyReminderHour,
    budgetAlertThreshold: Number(row?.budget_alert_threshold || DEFAULT_PREFERENCES.budgetAlertThreshold),
  };
}

export async function getNotificationPreferences(telegramUserId) {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('daily_reminder_enabled, daily_summary_enabled, weekly_summary_enabled, budget_alert_enabled, daily_reminder_hour, budget_alert_threshold')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();
  if (error) {
    console.error('notification preferences lookup error:', JSON.stringify(error));
    return DEFAULT_PREFERENCES;
  }
  return cleanPreferences(data);
}

export async function saveNotificationPreferences({ authUserId, telegramUserId, preferences }) {
  const dailyReminderHour = Math.min(23, Math.max(0, Number(preferences?.dailyReminderHour ?? 8)));
  const threshold = Math.min(1, Math.max(0.5, Number(preferences?.budgetAlertThreshold ?? 0.8)));
  const payload = {
    auth_user_id: authUserId,
    telegram_user_id: telegramUserId,
    daily_reminder_enabled: preferences?.dailyReminderEnabled !== false,
    daily_summary_enabled: preferences?.dailySummaryEnabled !== false,
    weekly_summary_enabled: preferences?.weeklySummaryEnabled !== false,
    budget_alert_enabled: preferences?.budgetAlertEnabled !== false,
    daily_reminder_hour: Number.isFinite(dailyReminderHour) ? dailyReminderHour : 8,
    budget_alert_threshold: Number.isFinite(threshold) ? threshold : 0.8,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('notification_preferences')
    .upsert(payload, { onConflict: 'auth_user_id' })
    .select('daily_reminder_enabled, daily_summary_enabled, weekly_summary_enabled, budget_alert_enabled, daily_reminder_hour, budget_alert_threshold')
    .single();
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

export async function sendPushToUser(telegramUserId, payload) {
  if (!ensureVapid()) return { sent: 0, skipped: 'vapid_not_configured' };
  const subscriptions = await getActiveSubscriptions(telegramUserId);
  if (!subscriptions.length) return { sent: 0, skipped: 'no_active_subscription' };

  let sent = 0;
  let failed = 0;
  let removed = 0;
  for (const row of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
        { TTL: 86400 }
      );
      sent += 1;
      await supabase.from('push_subscriptions').update({ last_used_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq('id', row.id);
    } catch (error) {
      failed += 1;
      const status = Number(error?.statusCode || 0);
      const inactive = status === 404 || status === 410;
      if (inactive) removed += 1;
      await supabase.from('push_subscriptions').update({ is_active: !inactive, last_error: String(error?.message || error).slice(0, 500), updated_at: new Date().toISOString() }).eq('id', row.id);
      console.error('web push send error:', status, error?.message || error);
    }
  }
  return { sent, failed, removed };
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
    .select('monthly_budget, category_budgets')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();
  if (settingsError || !settings) return { sent: 0, skipped: 'no_budget' };

  const monthlyBudget = Number(settings.monthly_budget || 0);
  const categoryBudgets = settings.category_budgets && typeof settings.category_budgets === 'object' ? settings.category_budgets : {};
  if (monthlyBudget <= 0 && !Object.values(categoryBudgets).some((value) => Number(value) > 0)) return { sent: 0, skipped: 'no_budget' };

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
      badge: './icons/icon-192.png',
    }));
  }
  return results;
}

export { DEFAULT_PREFERENCES };
