import { supabase } from './supabaseClient.js';

export const DEFAULT_GLOBAL_CONTEXT = Object.freeze({
  country: 'Egypt',
  countryCode: 'EG',
  language: 'ar',
  currency: 'Egyptian Pound',
  currencyCode: 'EGP',
  locale: 'ar-EG',
  timezone: 'Africa/Cairo',
});

const ALLOWED_LANGUAGES = new Set(['ar', 'en']);
const ISO_CURRENCY = /^[A-Z]{3}$/;
const ISO_COUNTRY = /^[A-Z]{2}$/;
const IANA_TZ = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/;

function safeString(value, fallback, validator = () => true) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return validator(normalized) ? normalized : fallback;
}

export function normalizeGlobalContext(profile = {}) {
  const countryCode = safeString(profile.country_code || profile.countryCode, DEFAULT_GLOBAL_CONTEXT.countryCode, (v) => ISO_COUNTRY.test(v));
  const language = safeString(profile.language, DEFAULT_GLOBAL_CONTEXT.language, (v) => ALLOWED_LANGUAGES.has(v));
  const currencyCode = safeString(profile.currency_code || profile.currencyCode, DEFAULT_GLOBAL_CONTEXT.currencyCode, (v) => ISO_CURRENCY.test(v));
  const locale = safeString(profile.locale, language === 'en' ? `en-${countryCode}` : `ar-${countryCode}`, (v) => v.length >= 2 && v.length <= 35);
  const timezone = safeString(profile.timezone, DEFAULT_GLOBAL_CONTEXT.timezone, (v) => IANA_TZ.test(v));

  return {
    country: safeString(profile.country, DEFAULT_GLOBAL_CONTEXT.country),
    countryCode,
    language,
    currency: safeString(profile.currency, DEFAULT_GLOBAL_CONTEXT.currency),
    currencyCode,
    locale,
    timezone,
  };
}

export async function getUserGlobalContext(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('country, country_code, language, currency, currency_code, locale, timezone')
    .eq('telegram_user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('getUserGlobalContext error:', error);
    return { ...DEFAULT_GLOBAL_CONTEXT };
  }
  return normalizeGlobalContext(data || DEFAULT_GLOBAL_CONTEXT);
}

export async function updateUserGlobalContext(userId, patch) {
  const next = normalizeGlobalContext(patch);
  const { data, error } = await supabase
    .from('users')
    .update({
      country: next.country,
      country_code: next.countryCode,
      language: next.language,
      currency: next.currency,
      currency_code: next.currencyCode,
      locale: next.locale,
      timezone: next.timezone,
    })
    .eq('telegram_user_id', userId)
    .select('country, country_code, language, currency, currency_code, locale, timezone')
    .maybeSingle();

  if (error) throw error;
  return normalizeGlobalContext(data || next);
}

export function formatMoney(amount, context = DEFAULT_GLOBAL_CONTEXT) {
  const ctx = normalizeGlobalContext(context);
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return '—';
  try {
    return new Intl.NumberFormat(ctx.locale, {
      style: 'currency',
      currency: ctx.currencyCode,
      maximumFractionDigits: 2,
    }).format(numeric);
  } catch {
    return `${numeric.toLocaleString(ctx.locale)} ${ctx.currencyCode}`;
  }
}

export function formatDate(value, context = DEFAULT_GLOBAL_CONTEXT, options = {}) {
  const ctx = normalizeGlobalContext(context);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(ctx.locale, { timeZone: ctx.timezone, ...options }).format(date);
}

export function assistantContextBlock(context = DEFAULT_GLOBAL_CONTEXT) {
  const ctx = normalizeGlobalContext(context);
  return [
    `User language: ${ctx.language}`,
    `Country: ${ctx.country} (${ctx.countryCode})`,
    `Currency: ${ctx.currencyCode}`,
    `Locale: ${ctx.locale}`,
    `Timezone: ${ctx.timezone}`,
    'Adapt to the user\'s regional dialect and colloquial wording; Arabic dialects may differ across Egypt, the Gulf, the Levant, and North Africa.',
    'Recognize local currency names and synonyms from the selected country, but never convert currencies or infer a missing amount.',
    'Use only verified user records. Do not guess local laws, taxes, products, exchange rates, or missing amounts.',
    'Calculate totals in application code; use the model only to explain verified results.',
  ].join('\n');
}
