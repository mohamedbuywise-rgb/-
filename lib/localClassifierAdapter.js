// جسر بين localClassifier.js (قواعد محلية) وشكل المعاملات اللي بيستخدمه دبّر.
// بيرجّع نفس شكل classifyLocally القديم: { handled, confidence, reason, transactions }
// handled=true  => التصنيف تم محليًا بثقة عالية (علامة ✓ "راجع قبل الحفظ")
// handled=false => نكمل للـ AI الحالي (الجملة فيها مبلغ غامض/دين ناقص/كلمة مش مفهومة...)
import { classifyMessage } from './localClassifier.js';
import { CATEGORIES } from './config.js';
import { normalizeDigits } from './textNormalize.js';

const MAX_TRANSACTIONS = 20;
const INCOME_CATEGORIES = new Set(['مرتب', 'بيع خدمة', 'أرباح استثمار', 'دخل متنوع']);

// ربط فئات المصنّف المحلي (categoryId) بفئات دبّر الـ 12 الفعلية في config.js.
// أي id مش هنا (أو ناتجه مش موجود في CATEGORIES) => العملية تروح للـ AI بدل ما تتسجل في فئة غلط.
// عدّل القيم هنا لو عايز تغيّر الربط (مثلاً القهوة لـ 'ترفيه').
export const CATEGORY_ID_TO_APP = {
  // [الفئة المفضّلة, فئة بديلة قديمة لو الفئة الجديدة مش متضافة في config.js]
  food: ['أكل'],
  drinks: ['مشروبات وقهوة', 'أكل'],
  grocery: ['بقالة ومستلزمات غذائية', 'أكل'],
  transport: ['مواصلات'],
  fuel: ['بنزين', 'مواصلات'],
  car: ['صيانة سيارة', 'مواصلات'],
  bills: ['فواتير'],
  housing: ['إيجار وسكن', 'فواتير'],
  home: ['منزل وأثاث'],
  health: ['صحة'],
  education: ['تعليم'],
  fun: ['ترفيه'],
  subs: ['اشتراكات'],
  shopping: ['تسوق'],
  gifts: ['هدايا وتبرعات'],
  care: ['شخصي وعناية'],
  gameya: ['جمعية وأقساط'],   // من غير الفئة في config.js بتروح للـ AI
};

function appCategory(tx, userCategoryOk) {
  // تصحيح المستخدم (userMap) بيرجع اسم فئة جاهز: نقبله بس لو هو فئة صالحة في دبّر
  if (!tx.categoryId) return userCategoryOk && CATEGORIES.includes(tx.category) ? tx.category : null;
  const options = CATEGORY_ID_TO_APP[tx.categoryId] || [];
  return options.find((c) => CATEGORIES.includes(c)) || null;
}

function clean(value, max = 80) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toProjectTransaction(tx, rawText) {
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const base = { amount, currency_code: 'EGP', raw_text: rawText };

  if (tx.type === 'expense') {
    const category = appCategory(tx, true);
    if (!category) return null;
    return { ...base, type: 'expense', category, note: clean(tx.description, 120) };
  }
  if (tx.type === 'income') {
    if (!INCOME_CATEGORIES.has(tx.category)) return null;
    return { ...base, type: 'income', category: tx.category, note: clean(tx.description, 120) };
  }
  if (tx.type === 'debt_lent' || tx.type === 'debt_borrowed') {
    const person = clean(tx.counterparty);
    if (!person) return null;
    return {
      ...base,
      type: 'debt',
      person,
      direction: tx.type === 'debt_lent' ? 'lent' : 'borrowed',
      is_repayment: false,
      note: '',
    };
  }
  // سداد ديون (رجّعت/رجّعلي): بنسيبه للـ AI لحد ما اتجاه السداد يتأكد في الـ debts flow.
  return null;
}

export function classifyByRules(text, options = {}) {
  const raw = String(text || '').trim().slice(0, 2500);
  const source = normalizeDigits(raw);
  if (!source) return { handled: false, confidence: 0, reason: 'empty', transactions: [] };
  if (/[؟?]/u.test(source)) return { handled: false, confidence: 0, reason: 'question', transactions: [] };

  let result;
  try {
    result = classifyMessage(source, options);
  } catch (error) {
    return { handled: false, confidence: 0, reason: 'classifier-error', transactions: [] };
  }
  if (result.route !== 'local') {
    const out = { handled: false, confidence: result.confidence || 0, reason: result.reason || 'rules-declined', transactions: [] };
    // نتيجة جزئية (اختيارية): اللي اتفهم بثقة + النصوص اللي لازم تتبعت للـ AI لوحدها.
    // المستدعي الحالي بيتجاهلها ويبعت الرسالة كلها للـ AI زي الأول (مفيش تغيير في السلوك).
    if (result.partial && result.partial.transactions.length) {
      const mapped = result.partial.transactions.map((tx) => toProjectTransaction(tx, raw));
      if (mapped.every(Boolean)) out.partial = { transactions: mapped, unresolved: result.partial.unresolved };
    }
    return out;
  }
  if (!result.transactions.length || result.transactions.length > MAX_TRANSACTIONS) {
    return { handled: false, confidence: result.confidence || 0, reason: 'bad-count', transactions: [] };
  }

  const transactions = result.transactions.map((tx) => toProjectTransaction(tx, raw));
  if (transactions.some((tx) => !tx)) {
    return { handled: false, confidence: result.confidence || 0, reason: 'unmappable-transaction', transactions: [] };
  }
  return { handled: true, confidence: result.confidence, reason: 'rules-ok', transactions };
}
