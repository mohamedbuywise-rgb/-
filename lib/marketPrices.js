// ============ أسعار السوق اللحظية (ذهب / عملات رقمية) لتحديث المحفظة الاستثمارية أوتوماتيك ============
// بيستخدم APIs عامة ومجانية مفيهاش مفتاح، فمفيش إعداد إضافي مطلوب.
// بيعمل كاش بسيط في الذاكرة لمدة 15 دقيقة عشان ميضربش الـ API في كل طلب.

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 دقيقة
const cache = new Map(); // key -> { value, expiresAt }

async function cachedFetch(key, fetcher) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fetcher();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// ============ سعر صرف الدولار مقابل الجنيه المصري ============
export async function getUsdToEgpRate() {
  return cachedFetch('usd-egp', async () => {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) throw new Error('exchange-rate-fetch-failed');
    const data = await res.json();
    const rate = Number(data?.rates?.EGP);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('exchange-rate-invalid');
    return rate;
  });
}

// ============ سعر أونصة/وحدة بالدولار لأي رمز (XAU للذهب، BTC، ETH...) ============
export async function getSpotPriceUsd(symbol) {
  return cachedFetch(`spot-${symbol}`, async () => {
    const res = await fetch(`https://api.gold-api.com/price/${encodeURIComponent(symbol)}`);
    if (!res.ok) throw new Error('spot-price-fetch-failed');
    const data = await res.json();
    const price = Number(data?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error('spot-price-invalid');
    return price;
  });
}

const GRAMS_PER_TROY_OUNCE = 31.1034768;

// ============ سعر جرام الذهب بالجنيه المصري، حسب العيار (24 افتراضيًا) ============
export async function getGoldPriceEgpPerGram(karat = 24) {
  const [ounceUsd, egpRate] = await Promise.all([getSpotPriceUsd('XAU'), getUsdToEgpRate()]);
  const purity = Math.min(Math.max(Number(karat) || 24, 1), 24) / 24;
  return (ounceUsd / GRAMS_PER_TROY_OUNCE) * purity * egpRate;
}

// ============ سعر وحدة عملة رقمية (BTC/ETH...) بالجنيه المصري ============
export async function getCryptoPriceEgp(symbol) {
  const [priceUsd, egpRate] = await Promise.all([getSpotPriceUsd(symbol), getUsdToEgpRate()]);
  return priceUsd * egpRate;
}

// ============ استخراج العيار من اسم/وصف الأصل، زي "عيار 21" أو "24k" — 24 لو مفيش تحديد ============
export function extractKaratFromText(text) {
  const s = String(text || '');
  const m = s.match(/عيار\s*(\d{1,2})|(\d{1,2})\s*k\b/i);
  const karat = Number(m?.[1] || m?.[2]);
  return Number.isFinite(karat) && karat >= 8 && karat <= 24 ? karat : 24;
}

// ============ تحديد نوع الأصل القابل للتسعير التلقائي من اسمه/وصفه (بترجع null لو مش مدعوم) ============
export function detectPriceableAssetKind(asset) {
  const text = `${asset?.name || ''} ${asset?.sub_label || ''} ${asset?.unit || ''}`.toLowerCase();
  if (/ذهب|دهب|gold/.test(text)) return { kind: 'gold', karat: extractKaratFromText(text) };
  if (/بيتكوين|bitcoin|\bbtc\b/.test(text)) return { kind: 'crypto', symbol: 'BTC' };
  if (/ايثيريوم|إيثيريوم|ethereum|\beth\b/.test(text)) return { kind: 'crypto', symbol: 'ETH' };
  return null;
}

// ============ سعر الوحدة الحالي بالجنيه لأصل معين (بيرجع null لو النوع مش مدعوم أو فشل الجلب) ============
export async function getUnitPriceEgpForAsset(asset) {
  const detection = detectPriceableAssetKind(asset);
  if (!detection) return null;
  try {
    if (detection.kind === 'gold') return await getGoldPriceEgpPerGram(detection.karat);
    if (detection.kind === 'crypto') return await getCryptoPriceEgp(detection.symbol);
  } catch (err) {
    console.error('getUnitPriceEgpForAsset error:', err?.message || err);
    return null;
  }
  return null;
}
