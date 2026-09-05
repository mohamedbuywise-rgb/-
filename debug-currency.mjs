import { detectCurrency } from './lib/textNormalize.js';
for (const text of ['اشتريت موبايل ب 4000 جنيه', 'ربحت 300 دولار', 'I spent 50 USD on food', '300 جنيه']) {
  console.log(text, detectCurrency(text));
}
