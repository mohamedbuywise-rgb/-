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

// ============ رموز أسهم بورصة مصر الشائعة، بالاسم العربي/الإنجليزي → رمز ياهو فايننس (بورصة القاهرة = لاحقة .CA) ============
const KNOWN_EGX_STOCKS = {
  'commercial international bank|\\bcib\\b|البنك التجاري الدولي': 'COMI.CA',
  'efg hermes|efg holding|\\befg\\b|إي.?إف.?جي|هيرمس': 'HRHO.CA',
  'telecom egypt|المصرية للاتصالات|اتصالات مصر': 'ETEL.CA',
  'elsewedy|السويدي': 'SWDY.CA',
  'eastern company|الشرقية للدخان|إيسترن': 'EAST.CA',
  'orascom construction|أوراسكوم للإنشاء': 'ORAS.CA',
  'tmg holding|talaat moustafa|طلعت مصطفى': 'TMGH.CA',
  'abu qir|أبو قير للأسمدة': 'ABUK.CA',
  'e-?finance|إي.?فاينانس': 'EFIH.CA',
  'juhayna|جهينة': 'JUFO.CA',
  'oriental weavers|النساجون الشرقيون': 'ORWE.CA',
  'madinet nasr|مدينة نصر للإسكان': 'MNHD.CA',
  'palm hills|بالم هيلز': 'PHDC.CA',
  'sidi kerir|سيدي كرير للبتروكيماويات': 'SKPC.CA',
  'qnb.*مصر|qnb alahli': 'QNBA.CA',
  'حديد عز|ezz steel': 'ESRS.CA',
  'fawry|فوري': 'FWRY.CA',
};

// ============ استخراج رمز سهم من اسم/وصف/رمز الأصل — بيتعرف على أسهم بورصة مصر المشهورة، أو أي تيكر عالمي مكتوب صراحة (زي AAPL أو TSLA) ============
export function extractStockSymbol(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const [pattern, symbol] of Object.entries(KNOWN_EGX_STOCKS)) {
    if (new RegExp(pattern, 'i').test(lower)) return symbol;
  }
  // تيكر عالمي مكتوب صراحة بأحرف كبيرة (AAPL, TSLA, COMI.CA...) — من 1 لـ 6 حروف + لاحقة بورصة اختيارية
  const explicit = raw.match(/\b([A-Z]{1,6}(?:\.[A-Z]{1,3})?)\b/);
  return explicit ? explicit[1] : null;
}

// ============ سعر سهم بالجنيه المصري — من Yahoo Finance (endpoint عام مجاني، من غير مفتاح API) ============
// بيدعم أي سهم عالمي أو أسهم بورصة مصر المعروفة في KNOWN_EGX_STOCKS أعلاه.
// لو عملة السهم مش جنيه أو دولار (زي يورو مثلاً) بنرفض بدل ما نديله رقم غلط.
export async function getStockPriceEgp(symbol) {
  return cachedFetch(`stock-${symbol}`, async () => {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DabbarBot/1.0)' },
    });
    if (!res.ok) throw new Error('stock-price-fetch-failed');
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const currency = String(meta?.currency || '').toUpperCase();
    if (!Number.isFinite(price) || price <= 0) throw new Error('stock-price-invalid');
    if (currency === 'EGP') return price;
    if (currency === 'USD') return price * (await getUsdToEgpRate());
    throw new Error(`stock-currency-unsupported:${currency}`);
  });
}

// ============ تحديد نوع الأصل القابل للتسعير التلقائي من اسمه/وصفه (بترجع null لو مش مدعوم) ============
// بنتأكد إن الأصل معلّم فعلاً كذهب/فضة/عملة رقمية/سهم قبل ما نحاول نجيب له سعر سوق — عشان منجيبش سعر غلط
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
  // سهم — أي أصل تحديدًا بيبقى: الوحدة (unit) نفسها رمز سهم واضح (زي AAPL أو COMI.CA)، أو اسم/وصف الأصل بيتطابق مع شركة معروفة في بورصة مصر
  const unitLooksLikeTicker = /^[A-Z]{1,6}(\.[A-Z]{1,3})?$/.test(String(asset?.unit || '').trim());
  if (unitLooksLikeTicker) return { kind: 'stock', symbol: String(asset.unit).trim() };
  const egxMatch = Object.entries(KNOWN_EGX_STOCKS).find(([pattern]) => new RegExp(pattern, 'i').test(text));
  if (egxMatch) return { kind: 'stock', symbol: egxMatch[1] };
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
    if (detection.kind === 'stock') return await getStockPriceEgp(detection.symbol);
  } catch (err) {
    console.error('getUnitPriceEgpForAsset error:', err?.message || err);
    return null;
  }
  return null;
}
