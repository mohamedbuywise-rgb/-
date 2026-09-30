// جسر بين localClassifier.js (قواعد محلية) وشكل المعاملات اللي بيستخدمه دبّر.
// بيرجّع نفس شكل classifyLocally القديم: { handled, confidence, reason, transactions }
// handled=true  => التصنيف تم محليًا بثقة عالية (علامة ✓ "راجع قبل الحفظ")
// handled=false => نكمل للـ AI الحالي (الجملة فيها مبلغ غامض/دين ناقص/كلمة مش مفهومة...)
import { classifyMessage } from './localClassifier.js';
import { CATEGORIES } from './config.js';
import { normalizeDigits } from './textNormalize.js';

const MAX_TRANSACTIONS = 20;
const INCOME_CATEGORIES = new Set(['مرتب', 'بيع خدمة', 'أرباح استثمار', 'دخل متنوع']);

function clean(value, max = 80) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toProjectTransaction(tx, rawText) {
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const base = { amount, currency_code: 'EGP', raw_text: rawText };

  if (tx.type === 'expense') {
    if (!CATEGORIES.includes(tx.category) || tx.category === 'متنوع') return null;
    return { ...base, type: 'expense', category: tx.category, note: clean(tx.description, 120) };
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
    return { handled: false, confidence: result.confidence || 0, reason: result.reason || 'rules-declined', transactions: [] };
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
