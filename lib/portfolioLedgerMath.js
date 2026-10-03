export const FREQUENCY_MONTHS = { monthly: 1, quarterly: 3, annually: 12, at_maturity: 0 };
export function calculateYield({ amount, yieldRate, frequency }) {
  const months = FREQUENCY_MONTHS[frequency] || 0;
  return Math.round(Number(amount || 0) * Number(yieldRate || 0) / 100 * months / 12 * 100) / 100;
}
export function calculatePortfolioMetrics(assets = [], transactions = []) {
  const active = assets.filter(a => (a.status || 'active') === 'active');
  const debt = active.filter(a => a.category === 'loan_debt').reduce((s, a) => s + Number(a.amount || 0), 0);
  const value = active.filter(a => a.category !== 'loan_debt').reduce((s, a) => s + Number(a.amount || 0), 0);
  const monthlyIncome = active.reduce((s, a) => s + calculateYield({ amount: a.amount, yieldRate: a.yield_rate, frequency: a.payout_frequency }) / Math.max(1, FREQUENCY_MONTHS[a.payout_frequency] || 1), 0);
  // الربح غير المحقق: لو فيه سعر شراء وسعر حالي نستخدمهم، وإلا نعتمد على cost_basis اللي بيتسجل فعليًا من الداشبورد (القيمة الحالية - سعر الشراء)
  const unrealizedPnl = active.filter(a => a.category === 'market_asset').reduce((s, a) => {
    if (a.buy_price != null && a.current_price != null && a.quantity != null) return s + (Number(a.current_price) - Number(a.buy_price)) * Number(a.quantity);
    const cost = Number(a.cost_basis);
    if (Number.isFinite(cost) && cost > 0) return s + (Number(a.amount || 0) - cost);
    return s;
  }, 0);
  const realizedYield = transactions.filter(t => t.type === 'yield_payout').reduce((s, t) => s + Number(t.amount || 0), 0);
  return { netWorth: Math.round((value - debt) * 100) / 100, expectedMonthlyIncome: Math.round(monthlyIncome * 100) / 100, unrealizedPnl: Math.round(unrealizedPnl * 100) / 100, realizedYield: Math.round(realizedYield * 100) / 100 };
}
