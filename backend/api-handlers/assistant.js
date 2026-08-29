import { supabase } from '../../lib/supabaseClient.js';
import { getRecentExpensesSummaryText } from '../../lib/expenses.js';
import { getDebtsSummaryText } from '../../lib/debts.js';
import { extractItemizedReceiptFromImageBase64, askDabbarChat, classifyMessage, reviewTransactions, transcribeAudioBase64 } from '../../lib/groq.js';
import { saveInvoiceRecord, deleteInvoiceById } from '../../lib/invoices.js';
import { hasActiveSubscription, isInTrial } from '../../lib/users.js';
import { checkOcrUsage, checkChatUsage, refundOcrUsage, refundUsage } from '../../lib/rateLimits.js';
import { normalizeDigits, extractDeterministicExpenses, correctDebtDirections, detectCurrency, currencyLabel, normalizeFinancialTransaction, reconcileSingleTransaction, countExpectedAmounts } from '../../lib/textNormalize.js';
import { maybeSendBudgetAlert } from '../../lib/webPush.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { isFinancialEventType, recordFinancialEvent } from '../../lib/financialEvents.js';

// ============ Router: POST /api/assistant  { action: ... } ============
// كل ميزات "دبّر الذكي" الجديدة (الأهداف، امسح فاتورة، اسأل دبّر) اتلمّت هنا في endpoint واحد،
// بنفس فكرة api/reports.js — عشان نفضل تحت حد Vercel Hobby (12 function كحد أقصى) بدل ما نضيف
// ملف مستقل لكل ميزة.
//
// action = "goal_create"      { title, targetAmount, targetDate? }
// action = "goal_contribute"  { amount }
// action = "goal_cancel"      {}
// action = "receipt_scan"     { imageBase64 }
// action = "invoice_delete"   { invoiceId }
// action = "ask"              { question }

async function requireLink(req, res) {
  const user = await getDashboardUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    return null;
  }

  // الربط بتيليجرام ليس شرطًا. الحساب المستقل يستخدم dataUserId السالب
  // بنفس جداول المصروفات/الديون، بينما تظل بوابة الاشتراك والتجربة فعّالة.
  const subscribed = await hasActiveSubscription(user.dataUserId);
  if (!subscribed) {
    const trial = await isInTrial(user.dataUserId);
    if (!trial) {
      res.status(403).json({ error: 'محتاج تشترك الأول عشان تستخدم دبّر الذكي.', subscriptionRequired: true });
      return null;
    }
  }

  return user.dataUserId;
}

function formatGoal(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    targetAmount: Number(row.target_amount),
    savedAmount: Number(row.saved_amount),
    targetDate: row.target_date,
    percent: Math.min(100, Math.round((Number(row.saved_amount) / Number(row.target_amount)) * 100)),
  };
}

async function handleGoalCreate(userId, body, res) {
  const title = (body.title || '').trim();
  const targetAmount = Number(body.targetAmount);
  const targetDate = body.targetDate || null;

  if (!title || !targetAmount || targetAmount <= 0) {
    return res.status(400).json({ error: 'محتاج اسم الهدف ومبلغ صحيح أكبر من صفر.' });
  }

  const { data: existing } = await supabase
    .from('goals')
    .select('id')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (existing) {
    return res.status(400).json({ error: 'عندك هدف شغال دلوقتي بالفعل. لازم تلغيه الأول عشان تبدأ هدف جديد.' });
  }

  const { data, error } = await supabase
    .from('goals')
    .insert({ telegram_user_id: userId, title, target_amount: targetAmount, saved_amount: 0, target_date: targetDate })
    .select('*')
    .single();

  if (error) {
    console.error('goal_create insert error:', JSON.stringify(error));
    return res.status(500).json({ error: 'حصل خطأ وإحنا بنسجل الهدف، جرب تاني.' });
  }

  return res.status(200).json({ goal: formatGoal(data) });
}

async function handleGoalContribute(userId, body, res) {
  const amount = Number(body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'محتاج مبلغ صحيح أكبر من صفر.' });
  }

  const { data: goal, error: fetchError } = await supabase
    .from('goals')
    .select('*')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (fetchError) console.error('goal_contribute fetch error:', JSON.stringify(fetchError));
  if (!goal) return res.status(400).json({ error: 'معندكش هدف شغال دلوقتي.' });

  const newSaved = Number(goal.saved_amount) + amount;
  const achieved = newSaved >= Number(goal.target_amount);

  const { data: updated, error: updateError } = await supabase
    .from('goals')
    .update({ saved_amount: newSaved, is_active: achieved ? false : true, achieved_at: achieved ? new Date().toISOString() : null })
    .eq('id', goal.id)
    .select('*')
    .single();

  if (updateError) {
    console.error('goal_contribute update error:', JSON.stringify(updateError));
    return res.status(500).json({ error: 'حصل خطأ وإحنا بنحدّث هدفك، جرب تاني.' });
  }

  return res.status(200).json({ goal: formatGoal(updated), achieved });
}

async function handleGoalCancel(userId, res) {
  const { data: goal } = await supabase
    .from('goals')
    .select('id')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (!goal) return res.status(400).json({ error: 'معندكش هدف شغال أصلاً.' });

  const { error } = await supabase.from('goals').update({ is_active: false }).eq('id', goal.id);
  if (error) {
    console.error('goal_cancel error:', JSON.stringify(error));
    return res.status(500).json({ error: 'حصل خطأ وإحنا بنلغي الهدف، جرب تاني.' });
  }

  return res.status(200).json({ ok: true });
}

async function handleReceiptScan(userId, body, res) {
  const { imageBase64, mimeType } = body;
  if (!imageBase64) return res.status(400).json({ error: 'مفيش صورة اتبعتت.' });

  // فحص حد "امسح فاتورة" الشهري (أو حد التجربة) قبل ما نستدعي Groq Vision خالص
  const usage = await checkOcrUsage(userId);
  if (!usage.allowed) {
    if (usage.isTrial) {
      return res.status(403).json({ error: 'خلصت حدود مسح الفواتير في التجربة المجانية. اشترك عشان تكمل.', trialEnded: true });
    }
    return res.status(429).json({ error: 'وصلت للحد الأقصى من مسح الفواتير الشهر ده. هيرجع تاني بداية الشهر الجاي.', limitReached: true });
  }

  // بنشيل data:...;base64, لو المتصفح بعتها كاملة، Groq محتاج الـ base64 الخام بس
  const cleanBase64 = String(imageBase64).replace(/^data:[^,]+,/, '');

  const receipt = await extractItemizedReceiptFromImageBase64(cleanBase64);
  if (!receipt.success) {
    // القراءة فشلت — مش غلطة المستخدم، فبنرجّعله المحاولة اللي اتخصمت من عداده قبل النداء على Groq
    await refundOcrUsage(userId);
    const hintSuffix = receipt.hint ? ` (${receipt.hint})` : '';
    return res.status(422).json({ error: `معرفتش أقرا الصورة دي حتى بعد أكتر من محاولة${hintSuffix}. جرب صورة أوضح للإيصال أو الفاتورة.`, refunded: true });
  }

  const saved = await saveInvoiceRecord(receipt, userId);
  if (!saved) {
    return res.status(500).json({ error: 'قريت الفاتورة بس حصل خطأ وإحنا بنسجلها، جرب تاني.' });
  }

  return res.status(200).json({
    invoiceId: saved.invoiceId,
    merchant: receipt.merchant || null,
    items: receipt.items,
    totalAmount: receipt.totalAmount,
    isDebt: receipt.isDebt,
    debtPerson: receipt.debtPerson || null,
    usage: !usage.isTrial && usage.remaining !== null ? { remaining: usage.remaining, limit: usage.limit } : null,
  });
}

async function handleAsk(userId, body, res) {
  const question = (body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'اكتب سؤالك الأول.' });
  if (question.length > 500) return res.status(400).json({ error: 'السؤال طويل أوي، اختصره شوية.' });

  // فحص حد "اسأل دبّر" الشهري (أو حد التجربة) قبل ما نستدعي Groq خالص
  const usage = await checkChatUsage(userId);
  if (!usage.allowed) {
    if (usage.isTrial) {
      return res.status(403).json({ error: 'خلصت حدود الأسئلة في التجربة المجانية. اشترك عشان تكمل.', trialEnded: true });
    }
    return res.status(429).json({ error: 'وصلت للحد الأقصى من الأسئلة الشهر ده. هيرجع تاني بداية الشهر الجاي.', limitReached: true });
  }

  // كل مصدر بيانات مستقل؛ لو مصدر واحد فشل لا نمنع المساعد من الرد على السؤال.
  const [expensesResult, debtsResult, goalResult] = await Promise.allSettled([
    getRecentExpensesSummaryText(userId),
    getDebtsSummaryText(userId),
    supabase
      .from('goals')
      .select('title, target_amount, saved_amount')
      .eq('telegram_user_id', userId)
      .eq('is_active', true)
      .maybeSingle(),
  ]);

  const expensesText = expensesResult.status === 'fulfilled'
    ? expensesResult.value
    : 'تعذر تحميل ملخص المصاريف مؤقتًا.';
  const debtsText = debtsResult.status === 'fulfilled'
    ? debtsResult.value
    : 'تعذر تحميل ملخص الديون مؤقتًا.';
  const goalRow = goalResult.status === 'fulfilled' ? goalResult.value.data : null;
  const goalText = goalRow
    ? `هدفه المالي الحالي: ${goalRow.title} — وفّر ${Number(goalRow.saved_amount)} من ${Number(goalRow.target_amount)} جنيه.`
    : 'مفيش هدف مالي مسجل دلوقتي.';

  const dataContext = `${expensesText}\n\n${debtsText}\n\n${goalText}`;
  const answer = await askDabbarChat(question, dataContext);

  // askDabbarChat يرجع نصًا بديلًا عند الفشل؛ لا نردّ العداد إذا وصل رد حقيقي.
  if (!answer || answer.startsWith('معلش، حصل خطأ بسيط')) {
    await refundUsage(userId, 'chat');
  }
  return res.status(200).json({
    answer,
    usage: !usage.isTrial && usage.remaining !== null ? { remaining: usage.remaining, limit: usage.limit } : null,
  });
}

async function handleEntryDraft(userId, body, res) {
  let text = String(body.text || '').trim();
  if (body.audioBase64) {
    if (String(body.audioBase64).length > 8 * 1024 * 1024) return res.status(413).json({ error: 'التسجيل طويل أوي. الحد الأقصى 30 ثانية.' });
    const transcript = await transcribeAudioBase64(body.audioBase64, body.mimeType || 'audio/webm');
    if (!transcript.success) return res.status(422).json({ error: transcript.error });
    text = transcript.text;
  }
  text = normalizeDigits(text);
  if (!text || text.length > 1200) return res.status(400).json({ error: 'اكتب أو سجّل وصفًا واضحًا للمصروف.' });

  // ============ نفس منطق تليجرام بالظبط: الرسالة الواحدة ممكن يكون فيها أكتر من معاملة مع بعض ============
  // (مثلاً "صرفت 50 جنيه أكل و100 مواصلات") — بنرجّعهم كلهم كمسودات عشان المستخدم يراجعهم ويأكدهم مرة واحدة،
  // بدل ما نلقط أول معاملة بس ونسيب الباقي بلا تسجيل زي ما كان الموقع بيعمل قبل كده.
  const parsed = await classifyMessage(text);
  const normalizedTransactions = (Array.isArray(parsed) ? parsed : []).map((item) => normalizeFinancialTransaction(item, text));
  const transactions = reconcileSingleTransaction(correctDebtDirections(text, normalizedTransactions), text);
  let validTx = transactions.filter((item) => ((isFinancialEventType(item?.type) || item?.type === 'expense') || item?.type === 'debt') && Number.isFinite(Number(item.amount)) && Number(item.amount) > 0 && (item.type !== 'debt' || item.person));

  // طبقة حماية إضافية: لو Groq رجّع رد "صالح" لكنه دمج كذا بند في معاملة واحدة غلط (فئة موحدة،
  // رقم واحد بدل الكل)، والتقسيم الحتمي لقى بنود أكتر بوضوح بالأرقام الصريحة، نفضّله عليه.
  // (بقى ">=" بدل ">" الصارم — نفس تصحيح تليجرام: لو Groq دمج 6 بنود في 3 والتقسيم الحتمي
  // لقى 3 برضو بس بأرقام مختلفة فعليًا، كان بيسيب رد Groq الناقص من غير ما يتفعل.)
  let deterministicSplitEarly = extractDeterministicExpenses(text);
  if (deterministicSplitEarly.length > 1 && deterministicSplitEarly.length >= validTx.length) {
    validTx = deterministicSplitEarly;
  }

  // لو التصنيف الذكي لم يلتقط جملة قصيرة مثل "غدا 100 جنيه"، نستخدم استخراجًا حتميًا
  // مقيدًا بعلامات المصروف، فلا نخلط جمل الديون أو الأسئلة مع مصروفات وهمية.
  if (!validTx.length) {
    const deterministicExpenses = extractDeterministicExpenses(text);
    if (deterministicExpenses.length) validTx = deterministicExpenses;
  }

  // تحقق أخير من "العدّ": لو عدد الأرقام الحقيقي المذكور في النص أكبر من عدد المعاملات الصالحة
  // اللي طلعناها، معناه إن بنود اتضاعت. نعيد نداء Groq مرة كمان بـ temperature أعلى شوية،
  // ولو لسه ناقص نرجع للتقسيم الحتمي كحل أخير.
  const expectedAmountsCount = countExpectedAmounts(text);
  if (expectedAmountsCount > 1 && validTx.length < expectedAmountsCount) {
    const retryParsed = await classifyMessage(text, { temperature: 0.15 });
    const retryNormalized = (Array.isArray(retryParsed) ? retryParsed : []).map((item) => normalizeFinancialTransaction(item, text));
    const retryTx = reconcileSingleTransaction(correctDebtDirections(text, retryNormalized), text)
      .filter((item) => ((isFinancialEventType(item?.type) || item?.type === 'expense') || item?.type === 'debt') && Number.isFinite(Number(item.amount)) && Number(item.amount) > 0 && (item.type !== 'debt' || item.person));
    if (retryTx.length > validTx.length) validTx = retryTx;
    if (validTx.length < expectedAmountsCount && deterministicSplitEarly.length > validTx.length) {
      validTx = deterministicSplitEarly;
    }
  }

  if (!validTx.length) return res.status(422).json({ error: 'محتاج مبلغ واضح عشان أفهم العملية.' });

  // طبقة تحقق أخيرة (self-check): نفس منطق تليجرام بالظبط — نداء تاني رخيص بيراجع الفئات والربط
  // بين الأرقام والبنود قبل ما نرجّع المسودات للمستخدم، بس لو فيه أكتر من بند واحد.
  if (validTx.length > 1) {
    validTx = await reviewTransactions(text, validTx);
  }

  // لو معاملة واحدة بس، برضو بنستخدم النص الأصلي كوصف احتياطي (fallback) لو الموديل ما رجعش note —
  // بالظبط زي ما تليجرام بيعمل. لو أكتر من معاملة، مش بنكرر نفس النص الطويل في كل واحدة فيهم.
  const useFallback = validTx.length === 1;
  const drafts = validTx.map((tx) => ({
    ...tx,
    amount: Number(tx.amount),
    currency_code: String(tx.currency_code || tx.currencyCode || detectCurrency(text)).toUpperCase(),
    note: tx.note || (useFallback ? '' : tx.note || ''),
    raw_text: tx.raw_text || text,
    sourceText: useFallback ? text : (tx.note || ''),
    needsConfirmation: true,
    confidence: 0.85,
  }));
  return res.status(200).json({ transcript: text, drafts });
}

async function handleEntryInvoiceDraft(userId, body, res) {
  const imageBase64 = String(body.imageBase64 || '').replace(/^data:[^,]+,/, '');
  if (!imageBase64) return res.status(400).json({ error: 'الصورة فاضية.' });
  const receipt = await extractItemizedReceiptFromImageBase64(imageBase64);
  if (!receipt.success) return res.status(422).json({ error: receipt.hint || 'معرفتش أقرا الفاتورة. جرّب صورة أوضح.' });
  return res.status(200).json({ drafts: [{ type: 'invoice', amount: Number(receipt.totalAmount), merchant: receipt.merchant || '', items: receipt.items || [], category: receipt.items?.[0]?.category || 'مصروف عام', note: receipt.merchant || 'فاتورة', sourceText: 'فاتورة مصوّرة', needsConfirmation: true, confidence: 0.9 }] });
}

// ============ حفظ معاملة واحدة (مصروف / دخل / شراء / أصل / تحويل / دين / فاتورة) — القلب المشترك ============
// نفس أنواع المعاملات اللي بوت تليجرام بيسجلها بالظبط (expense/debt)، بالإضافة لنوع "invoice" الخاص بالداشبورد.
async function saveOneDraft(userId, draft) {
  const amount = Number(draft.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return { ok: false, error: 'المبلغ غير صحيح.' };

  if (draft.type === 'expense') {
    const currency_code = String(draft.currency_code || detectCurrency(draft.raw_text || draft.sourceText || '')).toUpperCase();
    const { data, error } = await supabase.from('expenses').insert({ telegram_user_id: userId, amount, currency_code, category: String(draft.category || 'مصروف عام').slice(0, 80), description: String(draft.note || draft.sourceText || '').slice(0, 500) }).select('id, amount, currency_code, category, description, created_at').single();
    if (error) { console.error('entry_confirm expense error:', JSON.stringify(error)); return { ok: false, error: 'تعذر حفظ المصروف.' }; }
    await maybeSendBudgetAlert(userId).catch((pushError) => console.error('entry_confirm budget push failed:', pushError));
    return { ok: true, type: 'expense', record: data, message: `تم تسجيل مصروف ${data.amount} ${currencyLabel(data.currency_code)} في ${data.category}.` };
  }

  // ============ العمليات المالية العامة — تحفظ العبارة الطبيعية كاملة مع النوع والتفاصيل ============
  if (isFinancialEventType(draft.type)) {
    const savedEvent = await recordFinancialEvent(draft, userId);
    if (!savedEvent.ok) return savedEvent;
    return { ...savedEvent, message: `تم تسجيل ${savedEvent.label} بقيمة ${savedEvent.record.amount} ${currencyLabel(savedEvent.record.currency_code)}.` };
  }

  // ============ الديون/السلف — نفس بالظبط منطق recordDebt بتاع تليجرام (lib/debts.js)، بس من غير إرسال رسالة تليجرام ============
  if (draft.type === 'debt') {
    if (!draft.person) return { ok: false, error: 'اسم الشخص مطلوب لتسجيل الدين.' };
    const isRepayment = Boolean(draft.is_repayment || draft.isRepayment);
    const { data, error } = await supabase.from('debts').insert({
      telegram_user_id: userId,
      person_name: String(draft.person).slice(0, 160),
      amount,
      currency_code: String(draft.currency_code || detectCurrency(draft.raw_text || draft.sourceText || '')).toUpperCase(),
      direction: draft.direction === 'borrowed' ? 'borrowed' : 'lent',
      is_repayment: isRepayment,
      note: String(draft.note || '').slice(0, 500),
    }).select('id, person_name, amount, currency_code, direction, is_repayment').single();
    if (error) { console.error('entry_confirm debt error:', JSON.stringify(error)); return { ok: false, error: 'تعذر حفظ الدين.' }; }
    const isLent = data.direction !== 'borrowed';
    const money = `${data.amount} ${currencyLabel(data.currency_code)}`;
    const message = isRepayment
      ? (isLent ? `تم تسجيل: رجّعت لـ ${data.person_name} ${money}.` : `تم تسجيل: ${data.person_name} رجّعلك ${money}.`)
      : (isLent ? `تم تسجيل: بقى ليك عند ${data.person_name} ${money}.` : `تم تسجيل: بقى عليك لـ ${data.person_name} ${money}.`);
    return { ok: true, type: 'debt', record: data, message };
  }

  if (draft.type === 'invoice') {
    const items = Array.isArray(draft.items) ? draft.items.filter((item) => item && item.name && Number(item.amount) > 0).map((item) => ({ name: String(item.name).slice(0, 160), amount: Number(item.amount), category: String(item.category || 'مصروف عام').slice(0, 80) })) : [];
    const saved = await saveInvoiceRecord({ merchant: String(draft.merchant || '').slice(0, 160), totalAmount: amount, paymentMethod: '', invoiceNumber: '', isDebt: false, debtPerson: '', items: items.length ? items : [{ name: String(draft.note || 'فاتورة').slice(0, 160), amount, category: String(draft.category || 'مصروف عام').slice(0, 80) }] }, userId);
    if (!saved) return { ok: false, error: 'تعذر حفظ الفاتورة.' };
    return { ok: true, type: 'invoice', invoiceId: saved.invoiceId, message: `تم تسجيل الفاتورة بإجمالي ${amount} جنيه.` };
  }

  return { ok: false, error: 'نوع العملية غير مدعوم.' };
}

async function handleEntryConfirm(userId, body, res) {
  // بيقبل معاملة واحدة (body.draft، للتوافق مع أي نداء قديم) أو أكتر من معاملة مع بعض (body.drafts)،
  // بالظبط زي تليجرام لما رسالة واحدة فيها أكتر من مصروف/دين مع بعض.
  const drafts = Array.isArray(body.drafts) && body.drafts.length ? body.drafts : (body.draft ? [body.draft] : []);
  if (!drafts.length) return res.status(400).json({ error: 'مفيش عملية للتسجيل.' });

  const results = [];
  for (const draft of drafts) {
    results.push(await saveOneDraft(userId, draft));
  }

  const succeeded = results.filter((r) => r.ok);
  if (!succeeded.length) {
    return res.status(500).json({ error: results[0]?.error || 'تعذر الحفظ.' });
  }

  const message = succeeded.length === 1
    ? succeeded[0].message
    : `✅ تم تسجيل ${succeeded.length} معاملة بنجاح.`;

  return res.status(200).json({ ok: true, results, message });
}

async function handleInvoiceDelete(userId, body, res) {
  const invoiceId = Number(body.invoiceId);
  if (!invoiceId) return res.status(400).json({ error: 'مفيش رقم فاتورة اتبعت.' });

  const deleted = await deleteInvoiceById(invoiceId, userId);
  if (!deleted) return res.status(404).json({ error: 'الفاتورة دي مش موجودة أو اتمسحت قبل كده.' });

  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const userId = await requireLink(req, res);
    if (!userId) return; // requireLink already sent the error response

    const body = req.body || {};
    const action = body.action;

    switch (action) {
      case 'goal_create':
        return await handleGoalCreate(userId, body, res);
      case 'goal_contribute':
        return await handleGoalContribute(userId, body, res);
      case 'goal_cancel':
        return await handleGoalCancel(userId, res);
      case 'receipt_scan':
        return await handleReceiptScan(userId, body, res);
      case 'invoice_delete':
        return await handleInvoiceDelete(userId, body, res);
      case 'entry_draft':
        return await handleEntryDraft(userId, body, res);
      case 'entry_invoice_draft':
        return await handleEntryInvoiceDraft(userId, body, res);
      case 'entry_confirm':
        return await handleEntryConfirm(userId, body, res);
      case 'ask':
        return await handleAsk(userId, body, res);
      default:
        return res.status(400).json({ error: 'action غير معروف.' });
    }
  } catch (err) {
    console.error('assistant error:', err);
    return res.status(500).json({ error: 'حصل خطأ، جرب تاني.' });
  }
}
