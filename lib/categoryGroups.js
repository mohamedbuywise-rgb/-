// lib/categoryGroups.js
// تجميع الفئات للعرض فقط (pie chart / ملخص التقارير). مفيش أي تأثير على تخزين البيانات أو تصنيف الـ AI —
// الفئات الـ 27 كلها لسه موجودة في CATEGORIES وبتتخزن زي ما هي.
//
// وضعين:
//   groupByParent(totals)            -> 9 مجموعات رئيسية ثابتة (أكل ومشروبات، مواصلات وسيارة، ...)
//   foldSmallCategories(totals, opts) -> أكبر N فئة لوحدها + الباقي في "أخرى" (مع items للتفاصيل)
// totals: { 'أكل': 1200, 'بنزين': 300, ... } أو [{ category, amount }]
import { CATEGORY_EMOJI, CATEGORY_COLOR } from './config.js';

export const CATEGORY_GROUPS = [
  { id: 'food', name: 'أكل ومشروبات', emoji: '🍽️', color: '#FF6B6B', categories: ['أكل', 'مشروبات وقهوة', 'بقالة ومستلزمات غذائية'] },
  { id: 'transport', name: 'مواصلات وسيارة', emoji: '🚗', color: '#4ECDC4', categories: ['مواصلات', 'بنزين', 'صيانة سيارة'] },
  { id: 'home', name: 'سكن وفواتير', emoji: '🏠', color: '#FFD166', categories: ['فواتير', 'إيجار وسكن', 'منزل وأثاث', 'إنترنت واتصالات'] },
  { id: 'shopping', name: 'تسوق وملابس', emoji: '🛍️', color: '#A78BFA', categories: ['تسوق', 'ملابس'] },
  { id: 'health', name: 'صحة وعناية', emoji: '💊', color: '#34D399', categories: ['صحة', 'شخصي وعناية'] },
  { id: 'fun', name: 'ترفيه وسفر', emoji: '🎬', color: '#F472B6', categories: ['ترفيه', 'سفر وإقامة', 'رياضة وجيم', 'اشتراكات'] },
  { id: 'family', name: 'عائلة ومناسبات', emoji: '🎁', color: '#FB923C', categories: ['هدايا وتبرعات', 'أطفال وحضانة', 'مناسبات وأفراح', 'حيوانات أليفة'] },
  { id: 'work', name: 'تعليم وعمل', emoji: '📚', color: '#60A5FA', categories: ['تعليم', 'عمل ومشروع'] },
  { id: 'finance', name: 'التزامات مالية', emoji: '🏦', color: '#14B8A6', categories: ['جمعية وأقساط', 'رسوم بنكية', 'تأمين'] },
];
export const OTHER_GROUP = { id: 'other', name: 'أخرى', emoji: '📦', color: '#94A3B8' };

const CATEGORY_TO_GROUP = new Map();
CATEGORY_GROUPS.forEach((g) => g.categories.forEach((c) => CATEGORY_TO_GROUP.set(c, g)));

export function groupOfCategory(category) {
  return CATEGORY_TO_GROUP.get(category) || OTHER_GROUP;   // فئات قديمة/مجهولة (زي "متنوع") => أخرى
}

function toEntries(totals) {
  const map = new Map();
  const add = (cat, amount) => {
    const n = Number(amount);
    if (!cat || !Number.isFinite(n) || n <= 0) return;
    map.set(cat, (map.get(cat) || 0) + n);
  };
  if (Array.isArray(totals)) totals.forEach((r) => add(r && (r.category ?? r.name), r && (r.amount ?? r.total ?? r.value)));
  else Object.entries(totals || {}).forEach(([c, a]) => add(c, a));
  return Array.from(map.entries()).map(([category, amount]) => ({ category, amount }));
}

const round = (n) => Math.round(n * 100) / 100;
function withPercent(rows) {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return rows.map((r) => ({ ...r, amount: round(r.amount), percent: total > 0 ? Math.round((r.amount / total) * 1000) / 10 : 0 }));
}
const byAmountDesc = (a, b) => b.amount - a.amount;
const itemsOf = (entries) => entries.slice().sort(byAmountDesc).map((e) => ({ category: e.category, amount: round(e.amount) }));

/** 9 مجموعات رئيسية، مرتبة من الأكبر. كل مجموعة فيها items بالفئات التفصيلية (للضغط/الـ drill-down). */
export function groupByParent(totals) {
  const buckets = new Map();
  for (const e of toEntries(totals)) {
    const g = groupOfCategory(e.category);
    if (!buckets.has(g.id)) buckets.set(g.id, { group: g, amount: 0, entries: [] });
    const b = buckets.get(g.id);
    b.amount += e.amount; b.entries.push(e);
  }
  const rows = Array.from(buckets.values()).map((b) => ({
    id: b.group.id, name: b.group.name, emoji: b.group.emoji, color: b.group.color, isGroup: true,
    amount: b.amount, items: itemsOf(b.entries),
  })).sort(byAmountDesc);
  return withPercent(rows);
}

/**
 * أكبر فئات لوحدها والباقي في شريحة "أخرى".
 * opts.maxSlices  (افتراضي 7): أقصى عدد شرائح شامل "أخرى"
 * opts.minPercent (افتراضي 3): أي فئة أقل من كده تدخل "أخرى" حتى لو فيه مكان
 * لو "أخرى" هتبقى فئة واحدة بس، بنعرضها باسمها الحقيقي بدل "أخرى".
 */
export function foldSmallCategories(totals, { maxSlices = 7, minPercent = 3 } = {}) {
  const entries = toEntries(totals).sort(byAmountDesc);
  const sum = entries.reduce((s, e) => s + e.amount, 0);
  if (!entries.length || sum <= 0) return [];
  const shown = []; const folded = [];
  entries.forEach((e, i) => {
    const pct = (e.amount / sum) * 100;
    if (i < maxSlices - 1 && pct >= minPercent) shown.push(e); else folded.push(e);
  });
  // لو المطوي فئة واحدة بس، نظهرها بدل "أخرى" (لو فيه مكان)
  if (folded.length === 1 && shown.length < maxSlices) shown.push(folded.pop());
  const rows = shown.map((e) => ({
    id: e.category, name: e.category, emoji: CATEGORY_EMOJI[e.category] || '📦', color: CATEGORY_COLOR[e.category] || OTHER_GROUP.color,
    isGroup: false, amount: e.amount, items: [],
  }));
  if (folded.length) {
    rows.push({
      id: OTHER_GROUP.id, name: `${OTHER_GROUP.name} (${folded.length} فئات)`, emoji: OTHER_GROUP.emoji, color: OTHER_GROUP.color,
      isGroup: true, amount: folded.reduce((s, e) => s + e.amount, 0), items: itemsOf(folded),
    });
  }
  // "أخرى" دايمًا في الآخر مهما كان حجمها
  rows.sort((a, b) => (a.id === 'other') - (b.id === 'other') || b.amount - a.amount);
  return withPercent(rows);
}
