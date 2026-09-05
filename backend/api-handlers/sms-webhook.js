// backend/api-handlers/sms-webhook.js
// ============================================================================
// المصدر: تطبيق MacroDroid على جهاز المستخدم — بمجرد ما توصله رسالة SMS من
// بنك/محفظة مصرية، القاعدة اللي استوردها (ملف .macro اللي دبّر بيولّده له) بتبعت
// POST هنا فيها: التوكن الخاص بيه + اسم مرسل الرسالة + نص الرسالة.
//
// الأمان: التوكن (sms_webhook_token) عشوائي (uuid) وثابت لكل مستخدم، بيتولد
// تلقائي مع صف الـ profile بتاعه (شوف sql/sms-webhook.sql)، وهو اللي بيربط
// الرسالة بحساب المستخدم الصح من غير ما يحتاج تسجيل دخول Supabase من الموبايل.
//
// POST body: { token: string, sender?: string, bank?: string, text: string }
// ============================================================================

import { supabase } from '../../lib/supabaseClient.js';
import { classifyMessage } from '../../lib/groq.js';
import { recordExpense } from '../../lib/expenses.js';
import { recordDebt } from '../../lib/debts.js';
import { recordFinancialEvent } from '../../lib/financialEvents.js';
import { matchBankSender } from '../../lib/bank-senders.js';
import { checkTextUsage } from '../../lib/rateLimits.js';
import { standaloneDataUserId, ensureStandaloneUser } from '../../lib/dashboardAuth.js';

const DAILY_SMS_LIMIT = 80; // حد أقصى يومي للحماية من استهلاك API غير متوقع لكل مستخدم

// لازم النص يحتوي مبلغ رقمي واضح + رمز/اسم عملة، وإلا نتجاهل الرسالة قبل ما توصل لـ Groq خالص
// (توفيرًا لتكلفة الـ AI، وتفاديًا لتسجيل رسائل ترويجية أو تنبيهات عامة من نفس رقم البنك).
const AMOUNT_PATTERN = /\d/;
const CURRENCY_PATTERN = /(EGP|USD|EUR|SAR|AED|جنيه|ج\s*\.?\s*م|دولار|يورو|ريال|درهم)/i;

async function getProfileByToken(token) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, sms_webhook_enabled, sms_webhook_daily_count, sms_webhook_daily_reset_at')
    .eq('sms_webhook_token', token)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

// ============ نفس منطق dashboardAuth.js بالظبط: لو الحساب مرتبط بتليجرام نستخدم الـ id بتاعه، ============
// وإلا (حساب إيميل/باسورد مستقل) بنشتق نفس الرقم السالب الثابت اللي الداشبورد بيستخدمه أصلًا.
// كده أي حساب (مرتبط أو مستقل) بيقدر يستخدم أتمتة رسايل البنوك من غير أي شرط ربط إضافي.
async function resolveDataUserId(authUserId) {
  const { data } = await supabase
    .from('user_links')
    .select('telegram_user_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (data?.telegram_user_id) return { userId: data.telegram_user_id, linked: true };
  const standaloneId = standaloneDataUserId(authUserId);
  await ensureStandaloneUser(standaloneId);
  return { userId: standaloneId, linked: false };
}

async function bumpDailyCounter(profile) {
  const today = new Date().toISOString().slice(0, 10);
  const isNewDay = profile.sms_webhook_daily_reset_at !== today;
  const nextCount = isNewDay ? 1 : (profile.sms_webhook_daily_count || 0) + 1;
  await supabase
    .from('profiles')
    .update({ sms_webhook_daily_count: nextCount, sms_webhook_daily_reset_at: today })
    .eq('id', profile.id);
  return nextCount;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const { token, sender, bank, text } = req.body || {};
  if (!token || !text) {
    return res.status(400).json({ ok: false, error: 'محتاجين token و text.' });
  }

  const profile = await getProfileByToken(String(token));
  if (!profile) {
    return res.status(404).json({ ok: false, error: 'توكن غير صحيح.' });
  }
  if (!profile.sms_webhook_enabled) {
    return res.status(403).json({ ok: false, error: 'الميزة دي متوقفة على حسابك.' });
  }

  // فلترة على 3 مستويات قبل أي استدعاء لـ Groq (توفيرًا للتكلفة):
  // 1) اسم المرسل لازم يكون بنك/محفظة مصرية معروفة من القايمة.
  // 2) النص لازم يحتوي رقم (مبلغ).
  // 3) النص لازم يحتوي اسم/رمز عملة صريح.
  const bankMatch = matchBankSender(sender || bank);
  if (!bankMatch) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'مرسل غير معروف كبنك/محفظة، اتجاهلت.' });
  }
  if (!AMOUNT_PATTERN.test(text) || !CURRENCY_PATTERN.test(text)) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'الرسالة مفيهاش مبلغ وعملة واضحين، اتجاهلت.' });
  }

  const dailyCount = await bumpDailyCounter(profile);
  if (dailyCount > DAILY_SMS_LIMIT) {
    return res.status(429).json({ ok: false, error: 'وصلت للحد الأقصى اليومي لرسائل SMS.' });
  }

  const { userId: telegramUserId, linked } = await resolveDataUserId(profile.id);
  // chatId بيستخدم بس عشان نبعت رسالة تأكيد على تليجرام لو الحساب مرتبط فعلًا. للحسابات
  // المستقلة (إيميل/باسورد) الـ id سالب صناعي، وأي نداء sendTelegramMessage بيه بيفشل بهدوء
  // (متعالج جوه lib/telegram.js) من غير ما يوقف تسجيل الحركة نفسها في الداشبورد.
  const chatId = telegramUserId;

  // SMS البنكية تستخدم نفس عداد التصنيف النصي الشهري، مع Telegram والداشبورد.
  const textUsage = await checkTextUsage(telegramUserId);
  if (!textUsage.allowed) {
    return res.status(429).json({ ok: false, error: textUsage.isTrial
      ? 'خلصت حدود الإدخال النصي في التجربة المجانية.'
      : 'وصلت للحد الأقصى من الإدخالات النصية الشهر ده.' });
  }

  try {
    // ============ classifyMessage بترجع أراي المعاملات مباشرة (مش كائن فيه property اسمها transactions) — ============
    // ده كان الباج الحقيقي اللي بيخلي "recorded" يطلع 0 دايمًا حتى لو التصنيف نجح فعلاً (شوف telegram-webhook.js اللي بيستخدمها صح كأراي مباشرة)
    const transactions = await classifyMessage(text);
    let recorded = 0;
    for (const item of transactions) {
      if (item.type === 'expense' || item.type === 'purchase' || item.type === 'asset' || item.type === 'refund') {
        await recordExpense(item, text, telegramUserId, chatId, `\n\n🏦 اتسجلت أوتوماتيك من رسالة ${bankMatch.label}`, { source: 'sms', bank_key: bankMatch.key, bank_label: bankMatch.label, bank_sender: sender || bank });
        recorded += 1;
      } else if (item.type === 'income') {
        // الدخل البنكي يجب أن يذهب إلى financial_events، وليس expenses.
        await recordFinancialEvent({ ...item, bank_key: bankMatch.key, bank_label: bankMatch.label, bank_sender: sender || bank, source: 'sms' }, telegramUserId);
        recorded += 1;
      } else if (item.type === 'debt') {
        await recordDebt(item, telegramUserId, chatId);
        recorded += 1;
      } else if (item.type === 'withdrawal' || item.type === 'deposit' || item.type === 'transfer') {
        // حركة بنكية محايدة (سحب/إيداع/تحويل) — بتتسجل في "الحركات البنكية" ومتدخلش إجمالي المصروفات.
        // لو غامضة (تحويل لشخص/رقم موبايل بدون سياق تجاري) بتتحط needs_review عشان المستخدم يراجعها بنفسه.
        await recordFinancialEvent({ ...item, bank_key: bankMatch.key, bank_label: bankMatch.label, bank_sender: sender || bank, source: 'sms' }, telegramUserId);
        recorded += 1;
      }
      // settlement/unknown بنتجاهلها هنا عشان منسجلش حاجة غلط أوتوماتيك بدون مراجعة المستخدم
    }
    return res.status(200).json({ ok: true, recorded, bank: bankMatch.label, linked });
  } catch (err) {
    console.error('sms-webhook classify/record error:', err);
    return res.status(500).json({ ok: false, error: 'تعذر معالجة الرسالة.' });
  }
}
