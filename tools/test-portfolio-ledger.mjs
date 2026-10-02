import assert from 'node:assert/strict';
import { calculateYield, calculatePortfolioMetrics } from '../lib/portfolioLedgerMath.js';
assert.equal(calculateYield({ amount: 100000, yieldRate: 27, frequency: 'monthly' }), 2250);
assert.equal(calculateYield({ amount: 100000, yieldRate: 27, frequency: 'quarterly' }), 6750);
const metrics = calculatePortfolioMetrics([
  { amount: 100000, category: 'fixed_yield', status: 'active', yield_rate: 27, payout_frequency: 'monthly' },
  { amount: 50000, category: 'market_asset', status: 'active', buy_price: 100, current_price: 120, quantity: 100 },
  { amount: 20000, category: 'loan_debt', status: 'active' },
], [{ type: 'yield_payout', amount: 2250 }]);
assert.deepEqual(metrics, { netWorth: 130000, expectedMonthlyIncome: 2250, unrealizedPnl: 2000, realizedYield: 2250 });
console.log('portfolio ledger tests: ok');
