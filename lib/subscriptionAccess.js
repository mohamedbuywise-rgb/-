import { supabase } from './supabaseClient.js';
import { TRIAL_DAYS, SUBSCRIPTION_PRICE_EGP } from './config.js';

export const SUBSCRIPTION_FEATURES = Object.freeze({
  voice_input: 'الصوت',
  invoice_ocr: 'قراءة الفواتير',
  bank_linking: 'ربط الحسابات البنكية',
  ai_assistant: 'اسأل دبّر',
  share_extension: 'المشاركة من تطبيقات تانية',
  ai_classification: 'التصنيف التلقائي بالـ AI',
});

export const FREE_FEATURES = Object.freeze(['manual_entry', 'manual_category', 'history_read']);

function trialEndsAt(startedAt) {
  return startedAt ? new Date(new Date(startedAt).getTime() + TRIAL_DAYS * 86400000) : null;
}

export async function ensureTrialStarted(userId) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('users')
    .update({ trial_started_at: now })
    .eq('telegram_user_id', userId)
    .is('trial_started_at', null)
    .select('trial_started_at')
    .maybeSingle();
  if (error) console.error('ensureTrialStarted error:', JSON.stringify(error));
  return data?.trial_started_at ? new Date(data.trial_started_at) : null;
}

export async function getSubscriptionState(userId, { startTrial = false } = {}) {
  let { data, error } = await supabase
    .from('users')
    .select('trial_started_at, subscription_expires_at')
    .eq('telegram_user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('getSubscriptionState error:', JSON.stringify(error));
    return { status: 'free_locked', trialStartedAt: null, trialEndsAt: null, subscribedUntil: null };
  }
  if (!data && startTrial) {
    await ensureTrialStarted(userId);
    ({ data } = await supabase.from('users').select('trial_started_at, subscription_expires_at').eq('telegram_user_id', userId).maybeSingle());
  }
  const subscribedUntil = data?.subscription_expires_at ? new Date(data.subscription_expires_at) : null;
  const trialStartedAt = data?.trial_started_at ? new Date(data.trial_started_at) : null;
  const trialEnd = trialEndsAt(trialStartedAt);
  if (subscribedUntil && subscribedUntil.getTime() > Date.now()) return { status: 'subscribed', trialStartedAt, trialEndsAt: trialEnd, subscribedUntil };
  if (trialEnd && trialEnd.getTime() > Date.now()) return { status: 'trial', trialStartedAt, trialEndsAt: trialEnd, subscribedUntil };
  return { status: 'free_locked', trialStartedAt, trialEndsAt: trialEnd, subscribedUntil };
}

export async function getFeatureAccess(userId, feature, options = {}) {
  const state = await getSubscriptionState(userId, options);
  return {
    ...state,
    feature,
    featureLabel: SUBSCRIPTION_FEATURES[feature] || feature,
    allowed: state.status === 'trial' || state.status === 'subscribed' || FREE_FEATURES.includes(feature),
  };
}

export function subscriptionRequiredResponse(access) {
  return {
    error: `الميزة «${access.featureLabel}» متاحة أثناء التجربة أو مع الاشتراك الشهري (${SUBSCRIPTION_PRICE_EGP} ج.م).`,
    subscriptionRequired: true,
    subscriptionUrl: '/app/dabbar-website-premium.html',
    status: access.status,
    trialEnded: access.status === 'free_locked',
  };
}

export function trialDaysLeft(state) {
  return state.trialEndsAt ? Math.max(0, Math.ceil((state.trialEndsAt.getTime() - Date.now()) / 86400000)) : 0;
}

export async function markTrialReminderSent(userId) {
  const { error } = await supabase.from('users').update({ trial_reminder_sent_at: new Date().toISOString() }).eq('telegram_user_id', userId);
  if (error) console.error('markTrialReminderSent error:', JSON.stringify(error));
}

export async function getUsersNeedingTrialReminder() {
  const now = Date.now();
  const from = new Date(now - (TRIAL_DAYS * 86400000)).toISOString();
  const to = new Date(now - ((TRIAL_DAYS - 1) * 86400000)).toISOString();
  const { data, error } = await supabase.from('users')
    .select('telegram_user_id, chat_id, trial_started_at, trial_reminder_sent_at, subscription_expires_at')
    .gte('trial_started_at', from).lte('trial_started_at', to)
    .is('trial_reminder_sent_at', null).is('subscription_expires_at', null);
  if (error) console.error('getUsersNeedingTrialReminder error:', JSON.stringify(error));
  return data || [];
}

export function formatTrialReminder(state) {
  return `⏳ تنبيه: فاضل حوالي ${trialDaysLeft(state) || 1} يوم على نهاية تجربتك المجانية.\nبعدها هتفضل بياناتك محفوظة بالكامل، لكن الصوت وقراءة الفواتير وربط البنوك و«اسأل دبّر» والتصنيف الذكي والمشاركة هتحتاج اشتراكًا شهريًا بقيمة ${SUBSCRIPTION_PRICE_EGP} ج.م.\n\nتقدر تشترك من هنا: /subscription`;
}

export const FEATURE_ACCESS = SUBSCRIPTION_FEATURES;
export const TRIAL_LENGTH_DAYS = TRIAL_DAYS;
export const PAID_MONTHLY_PRICE_EGP = SUBSCRIPTION_PRICE_EGP;
export default getFeatureAccess;
