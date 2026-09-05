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

// ============ رموز عملات رقمية معروفة بأسمائها العربي/الإنجليزي — مسار سريع من غير مانحتاج نبحث في CoinGecko ============
const KNOWN_CRYPTO_SYMBOLS = {
  'بيتكوين|bitcoin|\\bbtc\\b': 'BTC',
  'ايثيريوم|إيثيريوم|ethereum|\\beth\\b': 'ETH',
  'usdt|تيثر|tether': 'USDT',
  'bnb|بينانس': 'BNB',
  'سولانا|solana|\\bsol\\b': 'SOL',
  'ريبل|xrp|ripple': 'XRP',
  'دوجكوين|dogecoin|\\bdoge\\b': 'DOGE',
  'كاردانو|cardano|\\bada\\b': 'ADA',
  'لايتكوين|litecoin|\\bltc\\b': 'LTC',
  'ترون|tron|\\btrx\\b': 'TRX',
};

// ============ تحديد نوع الأصل القابل للتسعير التلقائي من اسمه/وصفه (بترجع null لو مش مدعوم) ============
// بنتأكد إن الأصل معلّم فعلاً كذهب/فضة/عملة رقمية قبل ما نحاول نجيب له سعر سوق — عشان منجيبش سعر غلط
// لأصل زي عقار أو كاش أو صندوق (دول مفيش سعر سوق لحظي حقيقي ليهم، وإنت اللي بتحدّث قيمتهم يدويًا).
export function detectPriceableAssetKind(asset) {
  const text = `${asset?.name || ''} ${asset?.sub_label || ''} ${asset?.unit || ''}`.toLowerCase();
  if (/ذهب|دهب|gold/.test(text)) return { kind: 'gold', karat: extractKaratFromText(text) };
  if (/فضة|silver/.test(text)) return { kind: 'silver' };
  for (const [pattern, symbol] of Object.entries(KNOWN_CRYPTO_SYMBOLS)) {
    if (new RegExp(pattern).test(text)) return { kind: 'crypto', symbol };
  }
  // عملة رقمية متسماة صراحةً بس مش من القائمة المعروفة فوق — بندوّر عليها بالاسم عبر CoinGecko
  if (/كريبتو|crypto|عملة رقمية|عملات رقمية|عملة مشفرة|token|coin\b/.test(text)) {
    return { kind: 'crypto-search', query: asset?.name || asset?.sub_label };
  }
  return null;
}

// ============ البحث عن أي عملة رقمية بالاسم (لو مش من القائمة المعروفة) ثم جلب سعرها بالدولار ============
async function coingeckoResolveId(query) {
  return cachedFetch(`cg-id-${String(query).toLowerCase()}`, async () => {
    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('cg-search-failed');
    const data = await res.json();
    return data?.coins?.[0]?.id || null;
  });
}

async function getCryptoPriceEgpByQuery(query) {
  const id = await coingeckoResolveId(query);
  if (!id) return null;
  const usd = await cachedFetch(`cg-usd-${id}`, async () => {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (!res.ok) throw new Error('cg-price-failed');
    const data = await res.json();
    const price = Number(data?.[id]?.usd);
    if (!Number.isFinite(price) || price <= 0) throw new Error('cg-price-invalid');
    return price;
  });
  const egpRate = await getUsdToEgpRate();
  return usd * egpRate;
}

// ============ سعر الوحدة الحالي بالجنيه لأصل معين (بيرجع null لو النوع مش مدعوم أو فشل الجلب) ============
export async function getUnitPriceEgpForAsset(asset) {
  const detection = detectPriceableAssetKind(asset);
  if (!detection) return null;
  try {
    if (detection.kind === 'gold') return await getGoldPriceEgpPerGram(detection.karat);
    if (detection.kind === 'silver') return await getSpotPriceUsd('XAG').then(async (usd) => usd / GRAMS_PER_TROY_OUNCE * await getUsdToEgpRate());
    if (detection.kind === 'crypto') return await getCryptoPriceEgp(detection.symbol);
    if (detection.kind === 'crypto-search') return await getCryptoPriceEgpByQuery(detection.query);
  } catch (err) {
    console.error('getUnitPriceEgpForAsset error:', err?.message || err);
    return null;
  }
  return null;
}
