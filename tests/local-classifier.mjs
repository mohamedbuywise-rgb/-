import assert from 'node:assert/strict';
import { classifyByRules } from '../lib/localClassifierAdapter.js';

const pick = (r) => r.transactions.map((t) => [t.type, t.amount, t.category ?? t.person, t.direction].filter((x) => x !== undefined));

// جمل واضحة: تتصنف محليًا (علامة ✓)
let r = classifyByRules('صرفت 50 جنيه أكل و100 جنيه مواصلات');
assert.equal(r.handled, true);
assert.deepEqual(pick(r), [['expense', 50, 'أكل'], ['expense', 100, 'مواصلات']]);

r = classifyByRules('100 مواصلات و200 غدا');
assert.equal(r.handled, true);
assert.deepEqual(pick(r), [['expense', 100, 'مواصلات'], ['expense', 200, 'أكل']]);

r = classifyByRules('دفعت 200 جنيه بنزين');
assert.equal(r.transactions[0].category, 'بنزين');

r = classifyByRules('دفعت جمعية 300');
assert.equal(r.transactions[0].category, 'جمعية وأقساط');

r = classifyByRules('قبضت 8000 جنيه مرتب');
assert.equal(r.handled, true);
assert.deepEqual(pick(r), [['income', 8000, 'مرتب']]);

r = classifyByRules('سلفت مصطفى 500');
assert.equal(r.handled, true);
assert.equal(r.transactions[0].type, 'debt');
assert.equal(r.transactions[0].direction, 'lent');
assert.equal(r.transactions[0].person, 'مصطفى');

r = classifyByRules('استلفت من خالتي 200');
assert.equal(r.transactions[0].direction, 'borrowed');

// جمل من الصور: مبلغ/وحدة غامضة => لازم تروح للـ AI (مفيش علامة ✓)
for (const text of [
  'بقول لك ايه انا النهارده اتصرفت 100 مواصلات و200g غدا و 310 g وسلفت مصطفى احمد 500 واستلفت من خالتي 200',
  'غذا ١٠٠ عشا ١٠٠ مواصلات ١٠٠',
  'غذا عشا مواصلات 100',
  'هو معايا 300 جنيه؟',
  'مبلغ من غير سياق',
]) {
  const out = classifyByRules(text);
  assert.equal(out.handled, false, `should defer to AI: ${text}`);
  assert.equal(out.transactions.length, 0);
}

console.log('Local classifier tests passed.');
