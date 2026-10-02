import { supabase } from './supabaseClient.js';
export { calculatePortfolioMetrics } from './portfolioLedgerMath.js';
export async function getPortfolioMetrics(userId) {
  const [{ data: assets, error: assetsError }, { data: transactions, error: txError }] = await Promise.all([
    supabase.from('portfolio_assets').select('*').eq('telegram_user_id', userId),
    supabase.from('portfolio_transactions').select('type, amount').eq('telegram_user_id', userId),
  ]);
  if (assetsError && !String(assetsError.message || '').includes('portfolio_transactions')) console.error('portfolio metrics assets error', assetsError);
  if (txError) console.error('portfolio metrics transactions error', txError);
  return calculatePortfolioMetrics(assets || [], transactions || []);
}
export async function processPortfolioDaily(userId, today = new Date().toISOString().slice(0, 10)) {
  const { data, error } = await supabase.rpc('process_portfolio_daily', { p_user_id: userId, p_today: today });
  if (error) { console.error(JSON.stringify({ event: 'portfolio.cron.error', userId, error: error.message })); return { ok: false, error: error.message }; }
  console.log(JSON.stringify({ event: 'portfolio.cron.completed', userId, result: data }));
  return { ok: true, ...(data || {}) };
}
