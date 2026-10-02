import { supabase } from '../../lib/supabaseClient.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { isSupportedCurrency } from '../../lib/currencies.js';

export default async function handler(req, res) {
  const user = await getDashboardUserFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'انتهت جلسة الدخول.' });
  const userId = user.dataUserId;
  if (req.method === 'GET') {
    const { data, error } = await supabase.from('user_currency_preferences').select('currency_code').eq('telegram_user_id', userId).maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, currencyCode: data?.currency_code || 'EGP' });
  }
  if (req.method !== 'PUT') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const code = String(req.body?.currencyCode || '').trim().toUpperCase();
  if (!isSupportedCurrency(code)) return res.status(400).json({ ok: false, error: 'اختار عملة صحيحة من القائمة.' });
  const { data, error } = await supabase.from('user_currency_preferences').upsert({ telegram_user_id: userId, currency_code: code, updated_at: new Date().toISOString() }, { onConflict: 'telegram_user_id' }).select('currency_code').single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.status(200).json({ ok: true, currencyCode: data.currency_code });
}
