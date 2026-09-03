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

const DAILY_SMS_LIMIT = 80; // حد أقصى يومي للحماية من استهلاك API غير متوقع لكل مستخدم

async function getProfileByToken(token) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, sms_webhook_enabled, sms_webhook_daily_count, sms_webhook_daily_reset_at')
    .eq('sms_webhook_token', token)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function getTelegramLink(authUserId) {
  const { data } = await supabase
    .from('user_links')
    .select('telegram_user_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return data?.telegram_user_id || null;
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

  // فلترة: لازم اسم المرسل يكون واحد من البنوك/المحافظ المصرية المعروفة، وإلا نتجاهل الرسالة
  // (بيحمينا من استهلاك Groq API على رسايل عادية/سبام).
  const bankMatch = matchBankSender(sender || bank);
  if (!bankMatch) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'مرسل غير معروف كبنك/محفظة، اتجاهلت.' });
  }

  const dailyCount = await bumpDailyCounter(profile);
  if (dailyCount > DAILY_SMS_LIMIT) {
    return res.status(429).json({ ok: false, error: 'وصلت للحد الأقصى اليومي لرسائل SMS.' });
  }

  const telegramUserId = await getTelegramLink(profile.id);
  if (!telegramUserId) {
    return res.status(409).json({ ok: false, error: 'الحساب ده لسه مش مربوط بحساب تليجرام دبّر.' });
  }
  const chatId = telegramUserId; // في محادثات البوت الخاصة، chat.id == from.id في تليجرام

  // SMS البنكية تستخدم نفس عداد التصنيف النصي الشهري، مع Telegram والداشبورد.
  const textUsage = await checkTextUsage(telegramUserId);
  if (!textUsage.allowed) {
    return res.status(429).json({ ok: false, error: textUsage.isTrial
      ? 'خلصت حدود الإدخال النصي في التجربة المجانية.'
      : 'وصلت للحد الأقصى من الإدخالات النصية الشهر ده.' });
  }

  try {
    const result = await classifyMessage(text);
    const transactions = Array.isArray(result?.transactions) ? result.transactions : [];
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
    return res.status(200).json({ ok: true, recorded, bank: bankMatch.label });
  } catch (err) {
    console.error('sms-webhook classify/record error:', err);
    return res.status(500).json({ ok: false, error: 'تعذر معالجة الرسالة.' });
  }
}
