// backend/api-handlers/sms-webhook.js
// ============================================================================
// المصدر: تطبيق MacroDroid على جهاز المستخدم — بمجرد ما توصله رسالة SMS من بنك/محفظة مصرية،
// القاعدة اللي استوردها (ملف .macro اللي دبّر بيولّده له) بتبعت POST هنا فيها: التوكن + اسم المرسل + نص الرسالة.
//
// خطوات المعالجة (الأهم "نفهم الرسالة صح من أول مرة"):
//   1) قراءة الطلب بتسامح: JSON عادي، أو نص عادي token=/sender=/text= (الأسلم لأن نص الرسالة ممكن فيه سطور/علامات اقتباس).
//   2) lib/smsParser.js: محلل قواعد (عربي + إنجليزي) بيطلّع المبلغ الحقيقي (مش الرصيد/الرسوم) والاتجاه والجهة.
//      لو واثق → بيتسجل مباشرة بدون AI. لو مش واثق → AI (برومبت مخصوص للـ SMS) + مراجعة نتيجته قبل التسجيل.
//   3) بصمة الرسالة (lib/smsDedupe.js): نفس النص بالحرف خلال 90 ثانية = وصول مزدوج فبنتجاهله؛ أي رسالة تانية بتتسجل عادي.
//   4) التسجيل: مصروف → expenses، دخل/إيداع/سحب/تحويل/استرداد → financial_events (وبتظهر في "الحركات البنكية").
//   5) إشعار Push فوري لكل حركة.
//
// POST body: { token, sender?, bank?, text, dry_run?, force? }
//   dry_run: يحلل الرسالة ويرجّع النتيجة من غير ما يسجل أي حاجة (للاختبار).
//   force:   يتخطى فحص التكرار (للاختبار).
// ============================================================================

import { supabase } from '../../lib/supabaseClient.js';
import { CATEGORIES } from '../../lib/config.js';
import { classifyBankSms } from '../../lib/groq.js';
import { recordExpense } from '../../lib/expenses.js';
import { recordFinancialEvent } from '../../lib/financialEvents.js';
import { GENERIC_BANK, detectBankFromText, looksLikePersonalNumber, matchBankSender } from '../../lib/bank-senders.js';
import { numbersInText, parseBankSms, stripNoiseForAi } from '../../lib/smsParser.js';
import { claimSmsFingerprint, releaseSmsFingerprint, smsFingerprint } from '../../lib/smsDedupe.js';
import { checkTextUsage } from '../../lib/rateLimits.js';
import { getFeatureAccess, subscriptionRequiredResponse } from '../../lib/subscriptionAccess.js';
import { sendBankMovementPush } from '../../lib/webPush.js';
import { standaloneDataUserId, ensureStandaloneUser } from '../../lib/dashboardAuth.js';

const DAILY_SMS_LIMIT = 80; // حد أقصى يومي للحماية من استهلاك API غير متوقع لكل مستخدم

const SKIP_REASONS = {
  otp: 'رسالة رمز تحقق (OTP) — اتجاهلت.',
  failed_transaction: 'عملية مرفوضة/فاشلة — اتجاهلت.',
  promotional: 'رسالة ترويجية — اتجاهلت.',
  balance_only: 'رسالة رصيد بس من غير عملية — اتجاهلت.',
  balance_inquiry: 'استعلام رصيد — اتجاهلت.',
  no_amount: 'الرسالة مفيهاش مبلغ وعملة واضحين — اتجاهلت.',
  no_main_amount: 'مفيش مبلغ عملية واضح في الرسالة — اتجاهلت.',
  no_transaction_verb: 'الرسالة مش عملية مكتملة (مفيهاش خصم/إيداع/تحويل...) — اتجاهلت.',
  invalid_amount: 'المبلغ غير صالح — اتجاهلت.',
  empty: 'رسالة فاضية.',
};

// ============ قراءة الطلب بتسامح ============
// MacroDroid بيحط نص الرسالة "زي ما هو" جوه الـ body؛ ولو النص فيه سطر جديد أو علامة اقتباس، الـ JSON بيبوظ.
// عشان كده الماكرو الجديد بيبعت نص عادي، وهنا بنقبل الاتنين + بنحاول نصلّح JSON المكسور.
function parseLooseBody(raw) {
  const text = String(raw ?? '');
  try {
    const json = JSON.parse(text);
    if (json && typeof json === 'object') return json;
  } catch { /* نكمل للمحاولات التانية */ }

  // JSON مكسور: بنطلّع الحقول بالتعبيرات النمطية (text لازم يكون آخر حقل)
  const token = text.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
  if (token) {
    const sender = text.match(/"sender"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
    const textStart = text.search(/"text"\s*:\s*"/);
    let message = '';
    if (textStart >= 0) {
      const after = text.slice(textStart).replace(/^"text"\s*:\s*"/, '');
      const end = after.lastIndexOf('"');
      message = end >= 0 ? after.slice(0, end) : after;
    }
    return { token, sender, text: message.replace(/\\n/g, '\n').replace(/\\"/g, '"') };
  }

  // نص عادي: token=... / sender=... / text=... (text بياخد كل اللي بعده بما فيه السطور)
  const kvToken = text.match(/^\s*token\s*=\s*(\S+)/im)?.[1];
  if (kvToken) {
    const sender = text.match(/^\s*sender\s*=\s*(.*)$/im)?.[1]?.trim() ?? '';
    const at = text.search(/^\s*text\s*=/im);
    const message = at >= 0 ? text.slice(at).replace(/^\s*text\s*=\s*/i, '') : '';
    return { token: kvToken, sender, text: message.trim() };
  }
  return {};
}

function readRequestBody(req) {
  let body;
  try {
    body = req.body;
  } catch {
    return { error: 'invalid_body' };
  }
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return parseLooseBody(String(body));
  return {};
}

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

// ============ مراجعة نتيجة الـ AI قبل ما نسجّلها ============
const AI_TYPES = new Set(['expense', 'purchase', 'asset', 'income', 'deposit', 'withdrawal', 'transfer', 'refund']);
const IN_TYPES = new Set(['income', 'deposit', 'refund']);

function itemDirection(item) {
  if (IN_TYPES.has(item.type)) return 'in';
  if (item.type === 'transfer') return item.direction === 'in' ? 'in' : item.direction === 'out' ? 'out' : null;
  return 'out';
}

function validateAiItems(aiItems, rawText, parsed) {
  const numbers = numbersInText(rawText);
  const ruleAmount = parsed.hints?.amount ?? null;
  const balance = parsed.meta?.balance ?? null;
  const fee = parsed.meta?.fee ?? null;
  const ruleDirection = parsed.meta?.direction || parsed.hints?.direction || null;
  const scores = parsed.meta?.scores || { out: 0, in: 0 };
  const strongRule = Math.abs((scores.out || 0) - (scores.in || 0)) >= 3;
  const accepted = [];

  for (const raw of Array.isArray(aiItems) ? aiItems : []) {
    const type = String(raw?.type || '').toLowerCase();
    if (!AI_TYPES.has(type)) continue;
    let amount = Number(raw.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const present = numbers.some((v) => Math.abs(v - amount) < 0.005);
    const isBalance = balance !== null && Math.abs(balance - amount) < 0.005 && ruleAmount !== null && Math.abs(ruleAmount - balance) > 0.005;
    const isFee = fee !== null && Math.abs(fee - amount) < 0.005 && ruleAmount !== null && Math.abs(ruleAmount - fee) > 0.005;
    if (!present || isBalance || isFee) {
      // الـ AI مسك رقم غلط (رصيد/رسوم/رقم مش في الرسالة) — نستبدله بمبلغ العملية اللي المحلل القاعدي لقاه، أو نرفض
      if (ruleAmount !== null) amount = ruleAmount; else continue;
    }

    const candidate = { ...raw, type: type === 'purchase' || type === 'asset' ? 'expense' : type, amount };
    const direction = itemDirection(candidate);
    if (strongRule && ruleDirection && direction && direction !== ruleDirection) continue; // تعارض واضح مع القواعد → نرفضه ونرجع للقواعد

    let currency = String(raw.currency_code || raw.currency || parsed.hints?.currency || 'EGP').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) currency = parsed.hints?.currency || 'EGP';
    const category = CATEGORIES.includes(raw.category) ? raw.category : 'تسوق';
    const normalized = {
      type: candidate.type,
      amount,
      currency_code: currency,
      category,
      note: String(raw.note || raw.item || raw.counterparty || '').slice(0, 200),
      item: String(raw.item || '').slice(0, 120),
      counterparty: String(raw.counterparty || '').slice(0, 120),
      raw_text: String(rawText).slice(0, 1200),
      balance: Number.isFinite(Number(raw.balance)) && raw.balance !== null && raw.balance !== '' ? Number(raw.balance) : (balance ?? null),
      fee: Number.isFinite(Number(raw.fee)) && Number(raw.fee) > 0 ? Number(raw.fee) : (fee ?? null),
      reference: parsed.items?.[0]?.reference || '',
      card_last4: parsed.items?.[0]?.card_last4 || '',
      account_last4: parsed.items?.[0]?.account_last4 || '',
    };
    if (candidate.type === 'transfer') {
      normalized.direction = direction || ruleDirection || 'out';
      normalized.needs_review = raw.needs_review === undefined ? Boolean(normalized.counterparty) : Boolean(raw.needs_review);
    }
    accepted.push(normalized);
  }
  return accepted;
}

function markLowConfidence(item) {
  // نتيجة قواعد مش مؤكدة: التحويل/الإيداع بنعلّمهم للمراجعة عشان المستخدم يحدد نوعهم بضغطة.
  if (['transfer', 'deposit'].includes(item.type)) return { ...item, needs_review: true };
  return item;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const body = readRequestBody(req);
  if (body.error) {
    return res.status(400).json({ ok: false, error: 'تعذر قراءة الطلب. اتأكد إن نص الرسالة مبعوت بشكل صحيح (يفضّل تحمّل الماكرو الجديد من الداشبورد).' });
  }
  const { token, sender, bank, text } = body;
  if (!token || !text) {
    return res.status(400).json({ ok: false, error: 'محتاجين token و text.' });
  }
  const dryRun = body.dry_run === true || body.dry_run === 'true';
  const force = body.force === true || body.force === 'true';

  const profile = await getProfileByToken(String(token));
  if (!profile) {
    return res.status(404).json({ ok: false, error: 'توكن غير صحيح.' });
  }
  if (!profile.sms_webhook_enabled) {
    return res.status(403).json({ ok: false, error: 'الميزة دي متوقفة على حسابك.' });
  }

  const rawText = String(text).slice(0, 4000);
  const senderName = String(sender || bank || '').trim();

  // ============ 1) المحلل القاعدي (من غير AI) ============
  const parsed = parseBankSms(rawText, { sender: senderName });
  if (parsed.skip) {
    return res.status(200).json({ ok: true, skipped: true, code: parsed.skip, reason: SKIP_REASONS[parsed.skip] || 'اتجاهلت.' });
  }

  // ============ 2) تحديد البنك/المحفظة: من اسم المرسل، وإلا من اسم الجهة جوه النص ============
  let bankMatch = matchBankSender(senderName) || detectBankFromText(rawText);
  if (!bankMatch) {
    // مرسل مش معروف: لو مش رقم شخصي والرسالة واضحة جدًا كعملية بنكية، بنقبلها كـ "بنك/محفظة" عامة بدل ما نضيّعها.
    if (!looksLikePersonalNumber(senderName) && parsed.confidence === 'high') {
      bankMatch = { ...GENERIC_BANK, label: senderName ? senderName.slice(0, 40) : GENERIC_BANK.label };
    } else {
      return res.status(200).json({ ok: true, skipped: true, code: 'unknown_sender', reason: 'مرسل غير معروف كبنك/محفظة، اتجاهلت.' });
    }
  }

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dry_run: true,
      bank: bankMatch.label,
      confidence: parsed.confidence,
      parsed_by: parsed.confidence === 'high' ? 'rules' : 'needs_ai',
      items: parsed.items,
      meta: parsed.meta,
    });
  }

  const dailyCount = await bumpDailyCounter(profile);
  if (dailyCount > DAILY_SMS_LIMIT) {
    return res.status(429).json({ ok: false, error: 'وصلت للحد الأقصى اليومي لرسائل SMS.' });
  }

  const { userId: telegramUserId, linked } = await resolveDataUserId(profile.id);
  // chatId بيستخدم بس عشان نبعت رسالة تأكيد على تليجرام لو الحساب مرتبط فعلًا. للحسابات المستقلة
  // الـ id سالب صناعي، وأي نداء sendTelegramMessage بيه بيفشل بهدوء من غير ما يوقف تسجيل الحركة.
  const chatId = telegramUserId;

  // ============ 3) بصمة الرسالة: نمنع الوصول المزدوج بس (نفس النص بالحرف خلال 90 ثانية) ============
  const fingerprint = smsFingerprint({ userKey: telegramUserId, sender: senderName, text: rawText });
  if (!force && (await claimSmsFingerprint(telegramUserId, fingerprint))) {
    return res.status(200).json({ ok: true, skipped: true, code: 'duplicate_delivery', reason: 'نفس الرسالة وصلت مرتين في خلال ثواني، سجّلنا واحدة بس.' });
  }
  const abandon = () => releaseSmsFingerprint(telegramUserId, fingerprint);

  const bankAccess = await getFeatureAccess(telegramUserId, 'bank_linking', { startTrial: true });
  if (!bankAccess.allowed) {
    await abandon();
    return res.status(403).json({ ok: false, ...subscriptionRequiredResponse(bankAccess) });
  }

  try {
    // ============ 4) نفهم الرسالة: قواعد لو واثقين، وإلا AI + مراجعة ============
    let items = [];
    let parsedBy = 'rules';
    if (parsed.confidence === 'high') {
      items = parsed.items;
    } else {
      // الـ AI بيستهلك من عداد الإدخال النصي الشهري، فمش بنعدّ الرسايل اللي القواعد فهمتها لوحدها.
      const textUsage = await checkTextUsage(telegramUserId);
      if (!textUsage.allowed) {
        await abandon();
        return res.status(429).json({ ok: false, error: textUsage.isTrial
          ? 'خلصت حدود الإدخال النصي في التجربة المجانية.'
          : 'وصلت للحد الأقصى من الإدخالات النصية الشهر ده.' });
      }
      const aiItems = await classifyBankSms(stripNoiseForAi(rawText), parsed.hints || {});
      items = validateAiItems(aiItems, rawText, parsed);
      parsedBy = 'ai';
      if (!items.length && parsed.items.length) {
        items = parsed.items.map(markLowConfidence);
        parsedBy = 'rules-low';
      }
    }

    if (!items.length) {
      await abandon();
      return res.status(200).json({ ok: true, skipped: true, code: 'not_understood', reason: 'مقدرتش أفهم الرسالة كعملية مكتملة، اتجاهلت.' });
    }

    // ============ 5) التسجيل + الإشعار ============
    const sourceMeta = { source: 'sms', bank_key: bankMatch.key, bank_label: bankMatch.label, bank_sender: senderName, account_last4: '' };
    let recorded = 0;
    const failures = [];
    let pushSent = 0;
    let pushFailed = 0;
    const pushSkipped = [];

    for (const item of items) {
      const type = ['purchase', 'asset'].includes(item.type) ? 'expense' : item.type;
      const category = CATEGORIES.includes(item.category) ? item.category : 'تسوق';

      if (type === 'expense') {
        await recordExpense({ ...item, type, category }, rawText, telegramUserId, chatId, `\n\n🏦 اتسجلت أوتوماتيك من رسالة ${bankMatch.label}${item.account_last4 ? ` (حساب ••${item.account_last4})` : ''}`, { ...sourceMeta, account_last4: item.account_last4 || '' });
        recorded += 1;
      } else if (['income', 'deposit', 'withdrawal', 'transfer', 'refund'].includes(type)) {
        // دخل/إيداع/سحب/تحويل/استرداد → financial_events، وبتظهر في "الحركات البنكية" ومش بتدخل إجمالي المصروفات.
        // التحويل الغامض (شخص/رقم بدون سياق تجاري) بيتعلّم needs_review عشان المستخدم يحدد نوعه بنفسه.
        const result = await recordFinancialEvent({
          ...item,
          type,
          category,
          bank_key: bankMatch.key,
          bank_label: bankMatch.label,
          bank_sender: senderName,
          account_last4: item.account_last4 || '',
          source: 'sms',
          parsed_by: parsedBy,
        }, telegramUserId);
        if (result?.ok) recorded += 1; else failures.push(result?.error || 'تعذر حفظ العملية.');
      } else {
        continue;
      }

      const direction = itemDirection({ ...item, type });
      const pushResult = await sendBankMovementPush(telegramUserId, {
        direction: direction || 'out',
        kind: type,
        amount: item.amount,
        currency: item.currency_code || 'EGP',
        merchant: type === 'transfer' ? (item.counterparty || '') : (item.item || item.note || ''),
        bank: item.account_last4 ? `${bankMatch.label} ••${item.account_last4}` : bankMatch.label,
        balance: item.balance,
      });
      pushSent += Number(pushResult?.sent || 0);
      pushFailed += Number(pushResult?.failed || 0);
      if (pushResult?.skipped) pushSkipped.push(pushResult.skipped);
    }

    if (!recorded) await abandon();
    return res.status(200).json({
      ok: recorded > 0,
      recorded,
      parsed_by: parsedBy,
      bank: bankMatch.label,
      linked,
      ...(failures.length ? { errors: failures } : {}),
      push: { sent: pushSent, failed: pushFailed, skipped: [...new Set(pushSkipped)] },
    });
  } catch (err) {
    console.error('sms-webhook classify/record error:', err);
    await abandon();
    return res.status(500).json({ ok: false, error: 'تعذر معالجة الرسالة.' });
  }
}
