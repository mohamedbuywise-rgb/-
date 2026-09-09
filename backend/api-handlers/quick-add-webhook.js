// backend/api-handlers/quick-add-webhook.js
// ============================================================================
// المصدر: اختصار "Share Sheet" على آيفون (Apple Shortcuts) — بيسمح للمستخدم إنه
// يشير نص/تسجيل صوتي/صورة فاتورة من أي تطبيق تاني (واتساب، المعرض...) مباشرة
// لدبّر، من غير ما يحتاج يفتح المتصفح ويسجل دخول (لأن Shortcuts مايقدرش يستخدم
// جلسة تسجيل الدخول العادية بسهولة). بيستخدم نفس فكرة sms-webhook.js: توكن ثابت
// خاص بكل مستخدم (sms_webhook_token) بدل الجلسة.
//
// POST body (JSON): { token: string, text?: string, audioBase64?: string,
//                      imageBase64?: string, mimeType?: string }
// لازم حاجة واحدة بس من (text / audioBase64 / imageBase64) — لو اتبعت أكتر من
// واحدة، الأولوية: صورة (فاتورة) > صوت > نص.
// ============================================================================

import { supabase } from '../../lib/supabaseClient.js';
import { classifyMessage, transcribeAudioBase64, extractItemizedReceiptFromImageBase64 } from '../../lib/groq.js';
import { recordExpense } from '../../lib/expenses.js';
import { recordDebt } from '../../lib/debts.js';
import { recordFinancialEvent } from '../../lib/financialEvents.js';
import { saveInvoiceRecord } from '../../lib/invoices.js';
import { checkTextUsage, checkVoiceUsage, checkOcrUsage } from '../../lib/rateLimits.js';
import { standaloneDataUserId, ensureStandaloneUser } from '../../lib/dashboardAuth.js';

const DAILY_LIMIT = 80; // نفس حد sms-webhook.js تقريبًا، حماية من استهلاك API غير متوقع

async function getProfileByToken(token) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, sms_webhook_enabled, quick_add_webhook_daily_count, quick_add_webhook_daily_reset_at')
    .eq('sms_webhook_token', token) // بنستخدم نفس التوكن بتاع أتمتة SMS — توكن واحد لكل أتمتة الحساب
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

// ============ نفس منطق sms-webhook.js/dashboardAuth.js بالظبط — الحساب المرتبط بتليجرام يستخدم ============
// الـ id بتاعه، وإلا (حساب إيميل/باسورد مستقل) بنشتق نفس الرقم السالب الثابت اللي الداشبورد بيستخدمه أصلًا.
async function resolveDataUserId(authUserId) {
  const { data } = await supabase
    .from('user_links')
    .select('telegram_user_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (data?.telegram_user_id) return data.telegram_user_id;
  const standaloneId = standaloneDataUserId(authUserId);
  await ensureStandaloneUser(standaloneId);
  return standaloneId;
}

async function bumpDailyCounter(profile) {
  const today = new Date().toISOString().slice(0, 10);
  const isNewDay = profile.quick_add_webhook_daily_reset_at !== today;
  const nextCount = isNewDay ? 1 : (profile.quick_add_webhook_daily_count || 0) + 1;
  await supabase
    .from('profiles')
    .update({ quick_add_webhook_daily_count: nextCount, quick_add_webhook_daily_reset_at: today })
    .eq('id', profile.id);
  return nextCount;
}

// ============ نفس منطق تصنيف/تسجيل المعاملة اللي في sms-webhook.js — مستخرجة هنا كدالة مشتركة ============
async function classifyAndRecordText(text, userId, note) {
  const transactions = await classifyMessage(text);
  let recorded = 0;
  for (const item of transactions) {
    if (item.type === 'expense' || item.type === 'purchase' || item.type === 'asset' || item.type === 'refund') {
      await recordExpense(item, text, userId, userId, note, { source: 'share_sheet' });
      recorded += 1;
    } else if (item.type === 'income') {
      await recordFinancialEvent({ ...item, source: 'share_sheet' }, userId);
      recorded += 1;
    } else if (item.type === 'debt') {
      await recordDebt(item, userId, userId);
      recorded += 1;
    } else if (item.type === 'withdrawal' || item.type === 'deposit' || item.type === 'transfer') {
      await recordFinancialEvent({ ...item, source: 'share_sheet' }, userId);
      recorded += 1;
    }
    // settlement/unknown بنتجاهلها هنا عشان منسجلش حاجة غلط أوتوماتيك بدون مراجعة المستخدم
  }
  return { recorded, transactions };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const { token, text, audioBase64, imageBase64, mimeType } = req.body || {};
  if (!token) {
    return res.status(400).json({ ok: false, error: 'محتاجين token.' });
  }
  if (!text && !audioBase64 && !imageBase64) {
    return res.status(400).json({ ok: false, error: 'محتاجين نص أو تسجيل صوتي أو صورة فاتورة.' });
  }

  const profile = await getProfileByToken(String(token));
  if (!profile) {
    return res.status(404).json({ ok: false, error: 'توكن غير صحيح.' });
  }
  if (!profile.sms_webhook_enabled) {
    return res.status(403).json({ ok: false, error: 'الميزة دي متوقفة على حسابك. فعّلها من صفحة حسابي.' });
  }

  const dailyCount = await bumpDailyCounter(profile);
  if (dailyCount > DAILY_LIMIT) {
    return res.status(429).json({ ok: false, error: 'وصلت للحد الأقصى اليومي.' });
  }

  const userId = await resolveDataUserId(profile.id);
  const note = '\n\n📤 اتسجلت من مشاركة آيفون (Share Sheet)';

  try {
    // ============ صورة فاتورة — أعلى أولوية لو اتبعتت ============
    if (imageBase64) {
      const usage = await checkOcrUsage(userId);
      if (!usage.allowed) return res.status(429).json({ ok: false, error: usage.isTrial ? 'خلصت حدود قراءة الفواتير في التجربة المجانية.' : 'وصلت للحد الأقصى من قراءة الفواتير الشهر ده.' });
      const receipt = await extractItemizedReceiptFromImageBase64(imageBase64);
      if (!receipt) return res.status(422).json({ ok: false, error: 'معرفتش أقرأ الفاتورة، جرب صورة أوضح.' });
      const saved = await saveInvoiceRecord(receipt, userId);
      return res.status(200).json({ ok: true, type: 'invoice', invoice: saved });
    }

    // ============ تسجيل صوتي — بيتحول لنص الأول، وبعدين بيتصنّف زي أي نص عادي ============
    let finalText = text;
    if (audioBase64) {
      const usage = await checkVoiceUsage(userId);
      if (!usage.allowed) return res.status(429).json({ ok: false, error: usage.isTrial ? 'خلصت حدود التسجيل الصوتي في التجربة المجانية.' : 'وصلت للحد الأقصى من التسجيلات الصوتية الشهر ده.' });
      finalText = await transcribeAudioBase64(audioBase64, mimeType || 'audio/m4a');
      if (!finalText || !finalText.trim()) return res.status(422).json({ ok: false, error: 'معرفتش أسمع التسجيل الصوتي كويس، جرب تاني في مكان أهدأ.' });
    }

    if (!finalText || !finalText.trim()) {
      return res.status(400).json({ ok: false, error: 'مفيش نص واضح.' });
    }

    const textUsage = await checkTextUsage(userId);
    if (!textUsage.allowed) {
      return res.status(429).json({ ok: false, error: textUsage.isTrial ? 'خلصت حدود الإدخال النصي في التجربة المجانية.' : 'وصلت للحد الأقصى من الإدخالات النصية الشهر ده.' });
    }

    const { recorded, transactions } = await classifyAndRecordText(finalText, userId, note);
    return res.status(200).json({ ok: true, type: 'text', recorded, transactions, transcribed: audioBase64 ? finalText : undefined });
  } catch (err) {
    console.error('quick-add-webhook error:', err);
    return res.status(500).json({ ok: false, error: 'حصل خطأ وإحنا بنعالج المشاركة، جرب تاني.' });
  }
}
