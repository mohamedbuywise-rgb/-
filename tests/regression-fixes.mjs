import assert from 'node:assert/strict';
import { CATEGORIES, TRIAL_DAYS, USAGE_LIMITS } from '../lib/config.js';
import { classifyLocally, dedupeEquivalentTransactions, extractDeterministicTransactions, normalizeFinancialTransaction } from '../lib/textNormalize.js';

assert.equal(TRIAL_DAYS, 15, 'trial should last 15 days');
assert.equal(USAGE_LIMITS.paid.text, 300, 'ordinary text limit remains 300');
assert.equal(USAGE_LIMITS.paid.voice, 250, 'server voice limit remains 250');
assert.equal(USAGE_LIMITS.paid.web_text, 600, 'successful browser speech gets its own 600/month counter');
assert.ok(CATEGORIES.length >= 40, 'the expanded category catalog should contain many categories');
assert.ok(CATEGORIES.includes('جمعية وأقساط'));

const duplicateTransactions = dedupeEquivalentTransactions([
  { type: 'expense', amount: 300, currency_code: 'EGP', category: 'مواصلات' },
  { type: 'expense', amount: 300, currency_code: 'EGP', category: 'مواصلات' },
]);
assert.equal(duplicateTransactions.length, 1, 'identical same-message transactions should be saved once');

const localDuplicate = extractDeterministicTransactions('300 و 300 مواصلات');
assert.equal(localDuplicate.length, 1);
assert.equal(localDuplicate[0].amount, 300);
assert.equal(localDuplicate[0].category, 'مواصلات');

const distinctTrips = dedupeEquivalentTransactions([
  { type: 'expense', amount: 300, currency_code: 'EGP', category: 'مواصلات', note: 'تاكسي' },
  { type: 'expense', amount: 300, currency_code: 'EGP', category: 'مواصلات', note: 'مترو' },
]);
assert.equal(distinctTrips.length, 2, 'different explicit transaction notes should remain separate');

const gameya = normalizeFinancialTransaction(
  { type: 'expense', amount: 300, category: 'تسوق' },
  'دفعت قسط الجمعية 300 جنيه',
);
assert.equal(gameya.category, 'جمعية وأقساط');

const salary = extractDeterministicTransactions('قبضت 8000 جنيه مرتب');
assert.equal(salary.length, 1);
assert.equal(salary[0].type, 'income');
assert.equal(salary[0].category, 'مرتب');

const loan = extractDeterministicTransactions('أخدت من أحمد 300 جنيه');
assert.equal(loan.length, 1);
assert.equal(loan[0].type, 'debt');
assert.equal(loan[0].person, 'احمد');
assert.equal(loan[0].direction, 'borrowed');

const multi = extractDeterministicTransactions('صرفت 50 جنيه أكل و100 جنيه مواصلات');
assert.deepEqual(multi.map((tx) => [tx.amount, tx.category]), [[50, 'أكل'], [100, 'مواصلات']]);

const local = classifyLocally('صرفت 50 جنيه أكل و100 جنيه مواصلات');
assert.equal(local.handled, true, 'clear multi-expense text should be handled locally');
assert.equal(local.transactions.length, 2);
assert.ok(local.confidence >= 0.95);

const twenty = Array.from({ length: 20 }, (_, i) => `${i + 1} جنيه مواصلات`).join(' و');
assert.equal(extractDeterministicTransactions(twenty).length, 20, 'local extraction should support up to 20 transactions');

const ambiguous = classifyLocally('هو معايا 300 جنيه؟');
assert.equal(ambiguous.handled, false, 'questions must not be classified locally');

console.log('Regression tests passed.');
