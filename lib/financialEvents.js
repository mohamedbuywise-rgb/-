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

  const { data, error } = await supabase.from('financial_events').insert({
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
    metadata: { item: String(event.item || '').slice(0, 200) },
  }).select('id, event_type, amount, currency_code, category, description, raw_text, direction, needs_review, counterparty, created_at').single();

  if (error) {
    console.error('recordFinancialEvent error:', JSON.stringify(error));
    return { ok: false, error: 'تعذر حفظ العملية المالية.' };
  }
  return { ok: true, type: event.type, record: data, label: LABELS[event.type] };
}

// ============ قايمة الحركات البنكية لشاشة "الحركات البنكية" ============
export async function listBankMovements(userId, { period = 'month', limit = 100 } = {}) {
  let query = supabase
    .from('financial_events')
    .select('id, event_type, amount, currency_code, category, description, direction, needs_review, counterparty, created_at')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (period === 'month') {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    query = query.gte('created_at', start);
  } else if (period === 'week') {
    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', start);
  }

  const { data, error } = await query;
  if (error) {
    console.error('listBankMovements error:', JSON.stringify(error));
    return { ok: false, error: 'تعذر جلب الحركات البنكية.' };
  }
  return { ok: true, movements: data || [] };
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
