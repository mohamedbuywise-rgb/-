import { supabase } from './supabaseClient.js';

const TIME_ZONE = 'Africa/Cairo';
const DAY_LABELS = ['ح', 'ن', 'ث', 'ر', 'خ', 'ج', 'س'];

function cairoDateKey(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

function buildLastSevenDays(activeKeys) {
  const todayKey = cairoDateKey(new Date());
  const [year, month, day] = todayKey.split('-').map(Number);
  const today = new Date(Date.UTC(year, month - 1, day));
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    days.push({
      date: key,
      label: DAY_LABELS[date.getUTCDay()],
      active: activeKeys.has(key),
    });
  }
  return days;
}

export async function getActiveDays(telegramUserId) {
  const { data, error } = await supabase.rpc('get_active_days', {
    p_telegram_user_id: telegramUserId,
  });

  if (!error && data) {
    const row = Array.isArray(data) ? data[0] : data;
    const lastSeven = Array.isArray(row?.last_7_days)
      ? row.last_7_days.map((item, index) => ({
          date: item.date || null,
          label: item.label || DAY_LABELS[index],
          active: Boolean(item.active ?? item.is_active),
        }))
      : [];
    return {
      totalActiveDays: Number(row?.total_active_days || 0),
      lastSevenDays: lastSeven,
      source: 'rpc',
    };
  }

  // توافق مؤقت مع المشاريع التي لم تُشغّل فيها Migration الـ RPC بعد.
  // لا نحمل بيانات المصروفات كاملة، بل created_at فقط، ونرجع نفس الشكل.
  if (error) console.error('get_active_days RPC error, using fallback:', JSON.stringify(error));
  const { data: rows, error: fallbackError } = await supabase
    .from('expenses')
    .select('created_at')
    .eq('telegram_user_id', telegramUserId);

  if (fallbackError) {
    console.error('getActiveDays fallback error:', JSON.stringify(fallbackError));
    return { totalActiveDays: 0, lastSevenDays: buildLastSevenDays(new Set()), source: 'unavailable' };
  }

  const activeKeys = new Set((rows || []).map((row) => cairoDateKey(row.created_at)));
  return {
    totalActiveDays: activeKeys.size,
    lastSevenDays: buildLastSevenDays(activeKeys),
    source: 'fallback',
  };
}

export { TIME_ZONE, DAY_LABELS };
