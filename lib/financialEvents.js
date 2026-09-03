import { supabase } from './supabaseClient.js';

const LABELS = {
  income: 'دخل',
  purchase: 'شراء',
  asset: 'أصل/جهاز',
  transfer: 'تحويل',
  withdrawal: 'سحب',
  deposit: 'إيداع',
  refund: 'استرداد',
  subscription: 'اشتراك',
  other: 'عملية مالية',
};

// أنواع "الحركات البنكية" الحصرية: بتظهر في شاشة الحركات البنكية ولا تدخل إجمالي المصروفات أبدًا.
export const BANK_NEUTRAL_TYPES = new Set(['withdrawal', 'deposit', 'transfer']);

const EVENT_TYPES = new Set(Object.keys(LABELS));

export function isFinancialEventType(type) {
  return EVENT_TYPES.has(type);
}

export function financialEventLabel(type) {
  return LABELS[type] || 'عملية مالية';
}

export async function recordFinancialEvent(event, userId) {
  if (!event || !isFinancialEventType(event.type)) return { ok: false, error: 'نوع العملية غير مدعوم.' };
  const amount = Number(event.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return { ok: false, error: 'المبلغ غير صحيح.' };
  const currency_code = String(event.currency_code || event.currencyCode || 'EGP').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency_code)) return { ok: false, error: 'العملة غير صحيحة.' };

  const direction = event.type === 'income' || event.type === 'refund' || event.type === 'deposit'
    ? 'inflow'
    : event.type === 'transfer'
      ? 'neutral'
      : 'outflow';
  const description = String(event.note || event.item || event.sourceText || '').slice(0, 500);
  const rawText = String(event.raw_text || event.sourceText || '').slice(0, 1200);
  // needs_review: بيتحط true بس لما تحويل واصل/صادر يكون فيه اسم شخص أو رقم موبايل بدون سياق تجاري واضح
  // (زي "InstaPay 500 جنيه إلى محمد أحمد") — المستخدم بيراجعها بضغطة من شاشة الحركات البنكية.
  const needsReview = Boolean(event.needs_review);
  const counterparty = String(event.counterparty || '').slice(0, 200);

  const payload = {
    telegram_user_id: userId,
    event_type: event.type,
    amount,
    currency_code,
    category: String(event.category || '').slice(0, 100) || null,
    description,
    raw_text: rawText,
    direction,
    needs_review: needsReview,
    counterparty,
    metadata: {
      item: String(event.item || '').slice(0, 200),
      source: String(event.source || '').slice(0, 30),
      bank_key: String(event.bank_key || '').slice(0, 60),
      bank_label: String(event.bank_label || '').slice(0, 120),
      bank_sender: String(event.bank_sender || '').slice(0, 120),
    },
  };
  const selectColumns = 'id, event_type, amount, currency_code, category, description, raw_text, direction, needs_review, counterparty, metadata, created_at';
  let { data, error } = await supabase.from('financial_events').insert(payload).select(selectColumns).single();

  // قواعد بيانات قديمة قد تحتوي الجدول قبل إضافة حقول المراجعة/metadata؛ نعيد المحاولة بالحقول الأساسية.
  if (error && ['PGRST204', '42703'].includes(error.code)) {
    const legacyPayload = { telegram_user_id: userId, event_type: event.type, amount, currency_code, category: payload.category, description, raw_text, direction };
    ({ data, error } = await supabase.from('financial_events').insert(legacyPayload).select('id, event_type, amount, currency_code, category, description, raw_text, direction, created_at').single());
  }

  if (error) {
    console.error('recordFinancialEvent error:', JSON.stringify(error));
    const schemaError = ['42P01', 'PGRST205', 'PGRST204', '42703'].includes(error.code);
    return { ok: false, error: schemaError
      ? 'تسجيل الدخل يحتاج تحديث قاعدة البيانات أولًا. شغّل ملف sql/financial-recording-repair.sql مرة واحدة في Supabase ثم جرّب التسجيل.'
      : 'تعذر حفظ العملية المالية، جرّب تاني بعد شوية.' };
  }
  return { ok: true, type: event.type, record: data, label: LABELS[event.type] };
}

// ============ قايمة الحركات البنكية لشاشة "الحركات البنكية" ============
export async function listBankMovements(userId, { period = 'month', limit = 100 } = {}) {
  const rangeStart = period === 'month'
    ? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
    : period === 'week'
      ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      : null;

  let eventsQuery = supabase
    .from('financial_events')
    .select('id, event_type, amount, currency_code, category, description, direction, needs_review, counterparty, metadata, created_at')
    .eq('telegram_user_id', userId);
  let expensesQuery = supabase
    .from('expenses')
    .select('id, amount, currency_code, category, description, source, source_bank_key, source_bank_label, source_bank_sender, created_at')
    .eq('telegram_user_id', userId)
    .eq('source', 'sms');
  if (rangeStart) {
    eventsQuery = eventsQuery.gte('created_at', rangeStart);
    expensesQuery = expensesQuery.gte('created_at', rangeStart);
  }

  const [{ data: eventRows, error: eventsError }, { data: expenseRows, error: expensesError }] = await Promise.all([eventsQuery, expensesQuery]);
  if (eventsError) {
    console.error('listBankMovements financial_events error:', JSON.stringify(eventsError));
    return { ok: false, error: 'تعذر جلب الحركات البنكية.' };
  }
  // مصروفات SMS تظهر هنا أيضًا، كي يرى المستخدم البنك/المحفظة بجانب الخصم.
  if (expensesError) console.warn('listBankMovements SMS expenses unavailable:', JSON.stringify(expensesError));
  const smsExpenses = (expenseRows || []).map((expense) => ({
    id: `expense:${expense.id}`,
    sourceExpenseId: expense.id,
    event_type: 'expense',
    amount: expense.amount,
    currency_code: expense.currency_code || 'EGP',
    category: expense.category,
    description: expense.description,
    direction: 'outflow',
    needs_review: false,
    counterparty: null,
    metadata: {
      source: expense.source,
      bank_key: expense.source_bank_key || '',
      bank_label: expense.source_bank_label || '',
      bank_sender: expense.source_bank_sender || '',
    },
    created_at: expense.created_at,
  }));
  const movements = [...(eventRows || []), ...smsExpenses]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
  return { ok: true, movements };
}

// ============ تصنيف حركة كانت "تحتاج مراجعة" بعد ما المستخدم يحدد نوعها الحقيقي ============
export async function resolveBankMovementReview(eventId, userId) {
  const { data, error } = await supabase
    .from('financial_events')
    .update({ needs_review: false })
    .eq('id', eventId)
    .eq('telegram_user_id', userId)
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: 'تعذر تحديث الحركة.' };
  return { ok: true };
}
