// تشغيل:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessage } from '../lib/localClassifier.js';
import { classifyByRules } from '../lib/localClassifierAdapter.js';

const brief = (r) => r.transactions.map((t) => [t.type, t.amount, t.category || t.counterparty]);

test('رسالة المستخدم الأصلية: 4 عمليات مفهومة محليًا + الـ 310 الغامضة تتحول للـ AI لوحدها', () => {
  const r = classifyMessage('بقول لك ايه انا النهارده اتصرفت 100 مواصلات و200g غدا و 310 g وسلفت مصطفى احمد 500 واستلفت من خالتي 200');
  assert.equal(r.route, 'ai');
  assert.equal(r.reason, 'no-category');
  assert.deepEqual(r.partial.transactions.map((t) => [t.type, t.amount]), [
    ['expense', 100], ['expense', 200], ['debt_lent', 500], ['debt_borrowed', 200],
  ]);
  assert.equal(r.partial.transactions[2].counterparty, 'مصطفى احمد');
  assert.equal(r.partial.transactions[3].counterparty, 'خالتي');
  assert.deepEqual(r.partial.unresolved, ['310 جنيه']);
});

test('نفس الرسالة بعد توضيح الـ 310: 5 عمليات كلها محلي وبالأنواع الصح', () => {
  const r = classifyMessage('بقول لك ايه انا النهارده اتصرفت 100 مواصلات و200g غدا و 310 g عشا وسلفت مصطفى احمد 500 واستلفت من خالتي 200');
  assert.equal(r.route, 'local');
  assert.deepEqual(brief(r), [
    ['expense', 100, 'مواصلات'], ['expense', 200, 'أكل'], ['expense', 310, 'أكل'],
    ['debt_lent', 500, 'مصطفى احمد'], ['debt_borrowed', 200, 'خالتي'],
  ]);
});

test('13 عملية في رسالة واحدة (روابط + أفعال ملزوقة) كلها تتصنف محليًا', () => {
  const msg = 'صرفت 50 قهوة و100 مواصلات و200 غدا واشتريت بنزين 300 ودفعت 450 كهربا ' +
    'وسلفت احمد 500 واستلفت من سعيد 250 وقبضت 8000 مرتب ودفعت 120 صيدليه وصرفت 75 سينما ' +
    'و60 عشا واشتركت نتفلكس 199 واشتريت 1500 ملابس';
  const r = classifyMessage(msg);
  assert.equal(r.route, 'local', JSON.stringify(r.debug.filter((d) => !d.ok)));
  assert.equal(r.transactions.length, 13);
  assert.deepEqual(r.transactions.map((t) => t.amount), [50, 100, 200, 300, 450, 500, 250, 8000, 120, 75, 60, 199, 1500]);
  assert.deepEqual(r.transactions.map((t) => t.type), [
    'expense', 'expense', 'expense', 'expense', 'expense', 'debt_lent', 'debt_borrowed', 'income',
    'expense', 'expense', 'expense', 'expense', 'expense',
  ]);
});

test('قائمة مرقّمة بأسطر (1) 2) 3-) : الترقيم ميتحسبش مبلغ', () => {
  const lines = ['صرفت 50 قهوة', 'دفعت 100 مواصلات', 'اشتريت 200 غدا', 'دفعت 300 كهربا', 'صرفت 40 عصير', 'دفعت 60 تاكسي',
    'اشتريت 90 خضار', 'دفعت 150 صيدليه', 'صرفت 35 شاي', 'دفعت 500 ايجار', 'صرفت 70 عشا', 'دفعت 25 مترو', 'صرفت 80 فطار'];
  const msg = lines.map((l, i) => `${i + 1}) ${l}`).join('\n');
  const r = classifyMessage(msg);
  assert.equal(r.route, 'local', JSON.stringify(r.debug.filter((d) => !d.ok)));
  assert.equal(r.transactions.length, 13);
  assert.deepEqual(r.transactions.map((t) => t.amount), [50, 100, 200, 300, 40, 60, 90, 150, 35, 500, 70, 25, 80]);
});

test('نمط "وصف مبلغ" من غير روابط', () => {
  const r = classifyMessage('قهوة 50 مواصلات 30 غدا 100');
  assert.equal(r.route, 'local');
  assert.deepEqual(brief(r), [['expense', 50, 'مشروبات وقهوة'], ['expense', 30, 'مواصلات'], ['expense', 100, 'أكل']]);
});

test('نمط "مبلغ وصف" من غير روابط', () => {
  const r = classifyMessage('50 قهوة 30 مواصلات 100 غدا');
  assert.equal(r.route, 'local');
  assert.deepEqual(brief(r), [['expense', 50, 'مشروبات وقهوة'], ['expense', 30, 'مواصلات'], ['expense', 100, 'أكل']]);
});

test('اسم بيبدأ بـ "و" (وليد) مش بيتقص كأنه واو عطف', () => {
  const r = classifyMessage('سلفت وليد 100 واشتريت قهوة 30');
  assert.equal(r.route, 'local');
  assert.deepEqual(brief(r), [['debt_lent', 100, 'وليد'], ['expense', 30, 'مشروبات وقهوة']]);
});

test('دخل + مصروف في نفس الرسالة', () => {
  const r = classifyMessage('قبضت 5000 مرتب وصرفت 100 مواصلات');
  assert.equal(r.route, 'local');
  assert.deepEqual(brief(r), [['income', 5000, 'مرتب'], ['expense', 100, 'مواصلات']]);
});

test('أرقام هندية + تاريخ', () => {
  const r = classifyMessage('امبارح صرفت ١٠٠ غدا و٥٠ قهوة');
  assert.equal(r.route, 'local');
  assert.deepEqual(r.transactions.map((t) => t.amount), [100, 50]);
});

test('عملية واحدة لسه شغالة زي الأول (regression)', () => {
  for (const [msg, amount, cat] of [['صرفت 50 جنيه على القهوة', 50, 'مشروبات وقهوة'], ['دفعت 300 كهربا', 300, 'فواتير'], ['اشتريت بنزين بمبلغ 400', 400, 'بنزين']]) {
    const r = classifyMessage(msg);
    assert.equal(r.route, 'local', msg);
    assert.equal(r.transactions.length, 1);
    assert.equal(r.transactions[0].amount, amount);
    assert.equal(r.transactions[0].category, cat);
  }
});

test('جرام حقيقي (منتج بيتوزن) مش بيتحول لجنيه', () => {
  const r = classifyMessage('اشتريت 200 g جبنه');
  assert.equal(r.route, 'ai');
});

test('الأسئلة والمبالغ الغامضة بتروح للـ AI (أمان)', () => {
  assert.equal(classifyMessage('صرفت كام على القهوة؟').route, 'ai');
  assert.equal(classifyMessage('100').route, 'ai');
  assert.equal(classifyMessage('هل صرفت 100 مواصلات').route, 'ai');
});

test('adapter: رسالة متعددة بتتحول لشكل مشروع دبّر، والديون بدون category', () => {
  // بيشتغل على config.js الحقيقي (12 فئة).
  const r = classifyByRules('صرفت 50 قهوة و100 مواصلات وسلفت احمد 500 واستلفت من سعيد 250');
  assert.equal(r.handled, true);
  assert.equal(r.transactions.length, 4);
  assert.deepEqual(r.transactions.map((t) => t.type), ['expense', 'expense', 'debt', 'debt']);
  assert.deepEqual(r.transactions.filter((t) => t.type === 'debt').map((t) => [t.person, t.direction]), [['احمد', 'lent'], ['سعيد', 'borrowed']]);
});

test('adapter: الجزئي بيرجع unresolved ومتغيرش handled=false', () => {
  const r = classifyByRules('صرفت 50 قهوة و100 مواصلات و310');
  assert.equal(r.handled, false);
  assert.equal(r.partial.transactions.length, 2);
  assert.deepEqual(r.partial.unresolved, ['310']);
});

// ---- المسار القديم (textNormalize.classifyLocally) ----
import { classifyLocally } from '../lib/textNormalize.js';
test('textNormalize.classifyLocally: الديون الملزوقة بالواو مبقتش تتسجل مصروف أكل', () => {
  const r = classifyLocally('اتصرفت 100 مواصلات و200 غدا وسلفت مصطفى احمد 500 واستلفت من خالتي 200');
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'multi-amount-debt');
});
test('textNormalize.classifyLocally: مصروفات متعددة عادية لسه بتتسجل محليًا', () => {
  const r = classifyLocally('صرفت 100 مواصلات و200 غدا');
  assert.equal(r.handled, true);
});

test('adapter: كل الفئات الناتجة موجودة فعلاً في CATEGORIES الحقيقية', async () => {
  const { CATEGORIES } = await import('../lib/config.js');
  const samples = ['صرفت 50 قهوة', 'دفعت 300 بنزين', 'اشتريت 200 خضار', 'دفعت 100 كهربا', 'دفعت 500 ايجار',
    'دفعت 300 هديه', 'دفعت 80 حلاق', 'دفعت 120 صيدليه', 'دفعت 99 نتفلكس', 'صرفت 75 سينما', 'دفعت 40 كورس'];
  for (const m of samples) {
    const r = classifyByRules(m);
    assert.equal(r.handled, true, m);
    assert.ok(CATEGORIES.includes(r.transactions[0].category), `${m} -> ${r.transactions[0].category}`);
  }
});

test('adapter: الفئات الجديدة بتتسجل باسمها (قهوة/بنزين/بقالة/إيجار/جمعية)', () => {
  const cat = (m) => classifyByRules(m).transactions[0]?.category;
  assert.equal(cat('صرفت 50 قهوة'), 'مشروبات وقهوة');
  assert.equal(cat('دفعت 300 بنزين'), 'بنزين');
  assert.equal(cat('اشتريت 200 خضار'), 'بقالة ومستلزمات غذائية');
  assert.equal(cat('دفعت 500 ايجار'), 'إيجار وسكن');
  assert.equal(cat('دفعت 500 قسط الجمعيه'), 'جمعية وأقساط');
  assert.equal(cat('دفعت 400 ميكانيكي'), 'صيانة سيارة');
});
