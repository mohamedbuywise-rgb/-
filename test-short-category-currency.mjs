import { extractDeterministicExpense, normalizeDigits, detectCurrency } from './lib/textNormalize.js';

const cases = [
  ['أكل 500', 500, 'أكل', 'EGP'],
  ['فطار 100', 100, 'أكل', 'EGP'],
  ['مواصلات 300', 300, 'مواصلات', 'EGP'],
  ['I spent 50 USD on food', 50, 'أكل', 'USD'],
  ['ربحت من YouTube 300 دولار', null, null, 'USD'],
  ['اشتريت موبايل ب 4000 جنيه', 4000, 'تسوق', 'EGP'],
];

for (const [text, amount, category, currency] of cases) {
  const result = extractDeterministicExpense(text);
  if (currency !== detectCurrency(text)) throw new Error(`${text}: currency expected ${currency}, got ${detectCurrency(text)}`);
  if (amount !== null && (!result || result.amount !== amount || result.category !== category || result.currency_code !== currency)) {
    throw new Error(`${text}: ${JSON.stringify(result)}`);
  }
}
console.log('short-category-currency tests passed');
console.log(JSON.stringify(cases.map(([text]) => ({ text, parsed: extractDeterministicExpense(text), currency: detectCurrency(text) })), null, 2));
