import { supabase } from './supabaseClient.js';

const LABELS = {
  income: 'دخل',
  purchase: 'شراء',
  asset: 'أصل/جهاز',
  transfer: 'تحويل',
  refund: 'استرداد',
  subscription: 'اشتراك',
  other: 'عملية مالية',
};

const EVENT_TYPES = new Set(Object.keys(LABELS));

export function isFinancialEventType(type) {
  return EVENT_TYPES.has(type);
}

export async function recordFinancialEvent(event, userId) {
  if (!event || !isFinancialEventType(event.type)) return { ok: false, error: 'نوع العملية غير مدعوم.' };
  const amount = Number(event.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return { ok: false, error: 'المبلغ غير صحيح.' };
  const currency_code = String(event.currency_code || event.currencyCode || 'EGP').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency_code)) return { ok: false, error: 'العملة غير صحيحة.' };

  const direction = event.type === 'income' || event.type === 'refund'
    ? 'inflow'
    : event.type === 'transfer'
      ? 'neutral'
      : 'outflow';
  const description = String(event.note || event.item || event.sourceText || '').slice(0, 500);
  const rawText = String(event.raw_text || event.sourceText || '').slice(0, 1200);

  const { data, error } = await supabase.from('financial_events').insert({
    telegram_user_id: userId,
    event_type: event.type,
    amount,
    currency_code,
    category: String(event.category || '').slice(0, 100) || null,
    description,
    raw_text: rawText,
    direction,
    metadata: { item: String(event.item || '').slice(0, 200) },
  }).select('id, event_type, amount, currency_code, category, description, raw_text, direction, created_at').single();

  if (error) {
    console.error('recordFinancialEvent error:', JSON.stringify(error));
    return { ok: false, error: 'تعذر حفظ العملية المالية.' };
  }
  return { ok: true, type: event.type, record: data, label: LABELS[event.type] };
}
