// ============ تحويل أي عملة أجنبية للجنيه المصري قبل تسجيل المصروف ============
// أي مصروف بعملة غير الجنيه (دولار/يورو/ريال...) بيتحوّل لجنيه ويتسجل بقيمة الجنيه، والمبلغ الأصلي بيتحفظ في الوصف.
// السعر من open.er-api.com (نفس المصدر المستخدم في marketPrices.js) مع كاش ساعة، وأسعار احتياطية لو الخدمة وقعت.

const CACHE_MS = 60 * 60 * 1000;
let cache = { at: 0, rates: null };

// أسعار احتياطية تقريبية (جنيه لكل وحدة) — بتُستخدم بس لو مفيش اتصال بخدمة الأسعار
const FALLBACK_EGP_PER_UNIT = { USD: 48, EUR: 52, GBP: 61, SAR: 12.8, AED: 13.1, KWD: 156, QAR: 13.2, BHD: 127, OMR: 125, JOD: 67.7, CAD: 35, AUD: 31, CHF: 54, TRY: 1.4, CNY: 6.7, JPY: 0.32, INR: 0.57, RUB: 0.55 };

async function loadRates() {
  if (cache.rates && Date.now() - cache.at < CACHE_MS) return cache.rates;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 4000) : null;
    const res = await fetch('https://open.er-api.com/v6/latest/USD', ctrl ? { signal: ctrl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) throw new Error('fx-http-' + res.status);
    const data = await res.json();
    const rates = data?.rates;
    if (!rates || !Number.isFinite(Number(rates.EGP)) || Number(rates.EGP) <= 0) throw new Error('fx-invalid');
    cache = { at: Date.now(), rates };
    return rates;
  } catch (err) {
    console.error('fx loadRates failed, using fallback:', err?.message || err);
    if (cache.rates) return cache.rates; // آخر أسعار ناجحة حتى لو قديمة
    return null;
  }
}

// بترجع جنيه لكل وحدة من العملة دي
export async function getEgpPerUnit(code) {
  const c = String(code || 'EGP').trim().toUpperCase();
  if (c === 'EGP') return 1;
  const rates = await loadRates();
  if (rates && Number(rates[c]) > 0 && Number(rates.EGP) > 0) return Number(rates.EGP) / Number(rates[c]);
  return FALLBACK_EGP_PER_UNIT[c] || null;
}

// { amount, currency_code: 'EGP', converted: boolean, original: { amount, currency_code } | null, rate }
export async function convertToEgp(amount, code) {
  const c = String(code || 'EGP').trim().toUpperCase();
  const n = Number(amount);
  if (c === 'EGP' || !Number.isFinite(n)) return { amount: n, currency_code: 'EGP', converted: false, original: null, rate: 1 };
  const rate = await getEgpPerUnit(c);
  if (!rate) return { amount: n, currency_code: c, converted: false, original: null, rate: null }; // عملة مجهولة: نسيبها زي ما هي بدل ما نغلط
  return { amount: Math.round(n * rate * 100) / 100, currency_code: 'EGP', converted: true, original: { amount: n, currency_code: c }, rate };
}

// وصف يوضح المبلغ الأصلي، مثال: "غدا (25 USD ≈ 1200 جنيه)"
export function withOriginalNote(description, conv) {
  if (!conv?.converted || !conv.original) return description;
  const tag = `(${conv.original.amount} ${conv.original.currency_code} ≈ ${Math.round(conv.amount)} جنيه)`;
  const base = String(description || '').trim();
  return base ? `${base} ${tag}` : tag;
}
