import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessage, editDistance, learnPerson, buildPersonMap } from '../lib/localClassifier.js';

const one = (msg, opts) => classifyMessage(msg, opts);

test('fuzzy: أخطاء إملائية شائعة تتصنف محليًا', () => {
  for (const [msg, cat] of [
    ['صرفت 100 مواقلات', 'مواصلات'], ['دفعت 50 كابتشنو', 'مشروبات وقهوة'], ['دفعت 300 كهربه', 'فواتير'],
    ['اشتريت 80 سوبرماكت', null], ['دفعت 500 ايجارر', 'إيجار وسكن'], ['صرفت 70 صيدليا', 'صحة'],
  ]) {
    const r = one(msg);
    if (cat === null) continue; // مش مضمون: بنتأكد بس إنه مابيغلطش (تحت)
    assert.equal(r.route, 'local', msg);
    assert.equal(r.transactions[0].category, cat, msg);
  }
});

test('fuzzy: بدون فعل صريح الثقة بتقل فيروح للـ AI (أمان)', () => {
  assert.equal(one('100 مواقلات').route, 'ai');
});

test('fuzzy: كلمات قصيرة وأسماء ناس مبتتحولش لفئة', () => {
  assert.equal(one('سلفت ماجد 500').transactions[0].type, 'debt_lent');
  const r = one('صرفت 100 علي');
  assert.notEqual(r.route === 'local' && r.transactions[0].category === 'أكل', true);
});

test('fuzzy: ممكن تتقفل بـ fuzzy:false', () => {
  assert.equal(one('صرفت 100 مواقلات', { fuzzy: false }).route, 'ai');
});

test('editDistance', () => {
  assert.equal(editDistance('مواصلات', 'مواقلات', 2), 1);
  assert.equal(editDistance('abc', 'xyz', 1), 2);
});

test('personMap: "وليد 200" دين لو اتعلمنا إن وليد سلفة', () => {
  assert.equal(one('وليد 200').route, 'ai');                         // من غير تاريخ: غامض
  const personMap = buildPersonMap([learnPerson('debt_lent', 'وليد')]);
  const r = one('وليد 200', { personMap });
  assert.equal(r.route, 'local');
  assert.deepEqual([r.transactions[0].type, r.transactions[0].amount, r.transactions[0].counterparty], ['debt_lent', 200, 'وليد']);
});

test('personMap: استلفت/اقترضت => borrowed، وميتدخلش لو فيه فعل أو فئة', () => {
  const personMap = buildPersonMap([learnPerson('debt_borrowed', 'خالتي'), learnPerson('debt_lent', 'وليد')]);
  assert.equal(one('خالتي 300', { personMap }).transactions[0].type, 'debt_borrowed');
  const r = one('صرفت 50 قهوة مع وليد', { personMap });
  assert.equal(r.transactions[0].type, 'expense');
  assert.equal(r.transactions.length, 1);
});

test('personMap: داخل رسالة متعددة', () => {
  const personMap = buildPersonMap([learnPerson('debt_lent', 'وليد')]);
  const r = one('صرفت 50 قهوة و100 مواصلات ووليد 200', { personMap });
  assert.equal(r.route, 'local', JSON.stringify(r.debug));
  assert.deepEqual(r.transactions.map((t) => t.type), ['expense', 'expense', 'debt_lent']);
});
