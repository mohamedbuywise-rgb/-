import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../lib/config.js';
import { CATEGORY_GROUPS, groupByParent, foldSmallCategories, groupOfCategory } from '../lib/categoryGroups.js';

test('كل فئة في CATEGORIES ليها مجموعة، ومفيش فئة في مجموعتين، ومفيش اسم غلط', () => {
  const seen = new Map();
  for (const g of CATEGORY_GROUPS) for (const c of g.categories) {
    assert.ok(CATEGORIES.includes(c), `فئة غير موجودة في CATEGORIES: ${c}`);
    assert.ok(!seen.has(c), `فئة مكررة بين مجموعتين: ${c}`);
    seen.set(c, g.id);
  }
  for (const c of CATEGORIES) assert.ok(seen.has(c), `فئة من غير مجموعة: ${c}`);
});

test('groupByParent: بيجمع ومجموع الأرقام بيفضل ثابت', () => {
  const totals = { 'أكل': 1000, 'مشروبات وقهوة': 300, 'بنزين': 400, 'مواصلات': 200, 'إيجار وسكن': 3000, 'متنوع': 50 };
  const r = groupByParent(totals);
  assert.deepEqual(r.map((x) => [x.name, x.amount]), [['سكن وفواتير', 3000], ['أكل ومشروبات', 1300], ['مواصلات وسيارة', 600], ['أخرى', 50]]);
  assert.equal(r.reduce((s, x) => s + x.amount, 0), 4950);
  assert.equal(Math.round(r.reduce((s, x) => s + x.percent, 0)), 100);
  assert.deepEqual(r[1].items, [{ category: 'أكل', amount: 1000 }, { category: 'مشروبات وقهوة', amount: 300 }]);
});

test('foldSmallCategories: أكبر الفئات لوحدها والصغيرة في أخرى، والمجموع ثابت', () => {
  const totals = { 'أكل': 5000, 'مواصلات': 2000, 'فواتير': 1500, 'تسوق': 800, 'ترفيه': 400, 'صحة': 300, 'بنزين': 100, 'تأمين': 50, 'حيوانات أليفة': 20 };
  const r = foldSmallCategories(totals, { maxSlices: 5, minPercent: 3 });
  assert.equal(r.length, 5);
  assert.equal(r[r.length - 1].id, 'other');
  assert.match(r[r.length - 1].name, /أخرى \(\d+ فئات\)/);
  assert.equal(r.reduce((s, x) => s + x.amount, 0), 10170);
  const other = r[r.length - 1];
  assert.equal(other.items.reduce((s, x) => s + x.amount, 0), other.amount);
});

test('foldSmallCategories: فئة واحدة صغيرة متتسماش "أخرى"، وبيانات فاضية/سالبة آمنة', () => {
  const r = foldSmallCategories({ 'أكل': 1000, 'مواصلات': 900, 'تسوق': 10 }, { maxSlices: 7, minPercent: 3 });
  assert.deepEqual(r.map((x) => x.name), ['أكل', 'مواصلات', 'تسوق']);
  assert.deepEqual(foldSmallCategories({}), []);
  assert.deepEqual(foldSmallCategories([{ category: 'أكل', amount: -5 }, { category: 'x', amount: 'abc' }]), []);
});

test('يقبل مصفوفة صفوف Supabase كمان', () => {
  const r = foldSmallCategories([{ category: 'أكل', amount: 100 }, { category: 'أكل', total: 50 }, { name: 'بنزين', value: 50 }]);
  assert.deepEqual(r.map((x) => [x.name, x.amount]), [['أكل', 150], ['بنزين', 50]]);
  assert.equal(groupOfCategory('غير معروف').id, 'other');
});
