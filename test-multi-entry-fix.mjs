import assert from 'node:assert/strict';
import { normalizeDigits, normalizeFinancialTransaction, reconcileSingleTransaction, correctDebtDirections } from './lib/textNormalize.js';

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

const spoken = normalizeDigits('غدا مية جنيه وعشا تلاتمية ومواصلات ميتين');
assert.equal(spoken, 'غدا 100 جنيه وعشا 300 ومواصلات 200');

console.log('multi-entry tests passed');
