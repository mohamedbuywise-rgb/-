import assert from 'node:assert/strict';
import { normalizeDigits, normalizeFinancialTransaction, reconcileSingleTransaction, correctDebtDirections, extractMultipleDeterministicExpenses } from './lib/textNormalize.js';

const mixedText = normalizeDigits('صرفت 50 جنيه أكل و100 جنيه مواصلات وعطيت محمد 200 جنيه');
assert.equal(mixedText, 'صرفت 50 جنيه أكل و100 جنيه مواصلات وعطيت محمد 200 جنيه');

const threeTransactions = [
  normalizeFinancialTransaction({ type: 'expense', amount: 50, category: 'أكل', note: 'أكل' }, mixedText),
  normalizeFinancialTransaction({ type: 'expense', amount: 100, category: 'مواصلات', note: 'مواصلات' }, mixedText),
  normalizeFinancialTransaction({ type: 'debt', amount: 200, person: 'محمد', direction: 'lent' }, mixedText),
];
assert.equal(threeTransactions.length, 3);
assert.deepEqual(reconcileSingleTransaction(threeTransactions, mixedText), threeTransactions);
assert.equal(correctDebtDirections(mixedText, threeTransactions).length, 3);

const screenshotText = normalizeDigits('صرفت 100 جنيه على القهوة وكمان 300 طلبات من على امازون وكمان 500 مصاريف وكمان 500 حلويات من محل بركة وكمان 500 مواصلات');
const extracted = extractMultipleDeterministicExpenses(screenshotText);
assert.equal(extracted.length, 5);
assert.deepEqual(extracted.map((item) => item.amount), [100, 300, 500, 500, 500]);
assert.equal(extracted[0].category, 'أكل');

const mixedWithDebt = normalizeDigits('صرفت 100 جنيه قهوة وكمان 300 طلبات وكمان 500 هدايا وعطيت احمد 500');
const expensesBeforeDebt = extractMultipleDeterministicExpenses(mixedWithDebt);
assert.deepEqual(expensesBeforeDebt.map((item) => item.amount), [100, 300, 500]);

const spoken = normalizeDigits('غدا مية جنيه وعشا تلاتمية ومواصلات ميتين');
assert.equal(spoken, 'غدا 100 جنيه وعشا 300 ومواصلات 200');

console.log('multi-entry tests passed');
