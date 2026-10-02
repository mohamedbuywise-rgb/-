// اختبار سريع لطبقة تصنيف الفئات (بدون أي نداء AI): node tools/test-categories.mjs
import assert from 'node:assert/strict';
import { CATEGORIES } from '../lib/config.js';
import { guessCategory, resolveCategory } from '../lib/categoryHints.js';
import { normalizeFinancialTransaction, extractDeterministicExpense } from '../lib/textNormalize.js';

const guess = [
  ['بنزين 300', 'بنزين وسيارة'], ['حطيت بنزين', 'بنزين وسيارة'], ['للبنزين', 'بنزين وسيارة'], ['زيت موتور', 'بنزين وسيارة'],
  ['قهوة من ستاربكس', 'مشروبات'], ['عصير مانجا', 'مشروبات'], ['خضار وفاكهة', 'بقالة وسوبر ماركت'], ['مقاضي البيت', 'بقالة وسوبر ماركت'],
  ['زيت طبخ', 'بقالة وسوبر ماركت'], ['كارت شحن 100', 'اتصالات وإنترنت'], ['فاتورة نت', 'اتصالات وإنترنت'],
  ['غدا كشري', null], ['تاكسي أوبر', null], ['فاتورة كهربا', null],
];
for (const [text, expected] of guess) assert.equal(guessCategory(text), expected, `guessCategory("${text}")`);

assert.equal(resolveCategory('أكل', 'قهوة'), 'مشروبات');
assert.equal(resolveCategory('مواصلات', 'بنزين'), 'بنزين وسيارة');
assert.equal(resolveCategory('صحة', 'قهوة'), 'صحة', 'فئة محددة أصلًا منلمسهاش');
assert.equal(resolveCategory('', 'xyz', { fallback: 'أكل' }), 'أكل');
assert.equal(resolveCategory('قهوة', 'ستاربكس'), 'مشروبات', 'فئة مش في القايمة تتصحح بالكلمة');

const cat = (tx, src) => normalizeFinancialTransaction(tx, src).category;
assert.equal(cat({ type: 'expense', amount: 300, category: 'مواصلات', note: 'بنزين' }, 'بنزين 300'), 'بنزين وسيارة');
assert.equal(cat({ type: 'expense', amount: 50, category: 'أكل', note: '' }, 'قهوة 50'), 'مشروبات');
assert.equal(cat({ type: 'expense', amount: 50, category: 'أكل', note: '' }, 'صرفت 50 قهوة و100 بنزين'), 'أكل', 'رسالة فيها أكتر من مبلغ: منخمنش من النص الكامل');
assert.equal(cat({ type: 'income', amount: 500, category: 'دخل', note: 'قهوة' }, 'x'), 'دخل', 'الدخل مايتلمسش');
assert.equal(extractDeterministicExpense('بنزين 300 جنيه').category, 'بنزين وسيارة');
for (const c of ['مشروبات', 'بقالة وسوبر ماركت', 'بنزين وسيارة', 'اتصالات وإنترنت']) assert.ok(CATEGORIES.includes(c), c);
console.log('categories OK —', CATEGORIES.length, 'فئة');
