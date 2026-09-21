// lib/smsParser.js
// ============================================================================
// محلل رسائل البنوك والمحافظ (عربي + إنجليزي) بقواعد صريحة — من غير أي AI.
//
// الهدف: تفهم الرسالة "من أول مرة" وبشكل ثابت:
//   - المبلغ الحقيقي للعملية (مش الرصيد، ولا الرسوم، ولا رقم البطاقة/العملية).
//   - الاتجاه (خصم/إيداع/تحويل صادر أو وارد/سحب/استرداد).
//   - الجهة (التاجر أو الشخص/الرقم).
//   - الرصيد والرسوم والمرجع كبيانات إضافية.
// لو الرسالة واضحة (confidence = 'high') بتتسجل مباشرة بدون استدعاء الـ AI (أسرع وأرخص وأدق)،
// ولو غامضة بترجع 'low' مع "hints" بنمرّرها للـ AI عشان يتحقق منها بدل ما يخمّن.
// ============================================================================

// ---------------------------------------------------------------- تطبيع النص
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_INDIC = '۰۱۲۳۴۵۶۷۸۹';

export function cleanSmsText(input) {
  let s = String(input ?? '');
  s = s
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '') // رموز اتجاه/عرض صفري
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // تشكيل + تطويل
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_INDIC.indexOf(d)))
    .replace(/٫/g, '.')
    .replace(/[٬،]/g, (m) => (m === '٬' ? ',' : '،'))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return s;
}

// نسخة للبحث بالكلمات المفتاحية (نفس الطول بالظبط عشان نقدر نستخدم نفس الـ indexes على النص الأصلي).
function searchForm(cleaned) {
  return cleaned
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

// ---------------------------------------------------------------- العملات والمبالغ
const CURRENCY_PATTERNS = [
  ['EGP', '(?<![a-z])(?:egp|e\\.g\\.p\\.?|l\\.e\\.?|le)(?![a-z])|e£|جنيه(?:ا|ات)?(?:\\s*مصري)?|(?<![\\u0621-\\u064a])ج\\.?\\s?م\\.?(?![\\u0621-\\u064a])|(?<![\\u0621-\\u064a])جم(?![\\u0621-\\u064a])'],
  ['USD', '(?<![a-z])usd(?![a-z])|us\\$|\\$|دولار(?:ا|ات)?'],
  ['EUR', '(?<![a-z])eur(?![a-z])|€|يورو'],
  ['SAR', '(?<![a-z])sar(?![a-z])|ريال(?:\\s*سعودي)?'],
  ['AED', '(?<![a-z])aed(?![a-z])|درهم(?:\\s*اماراتي)?'],
  ['GBP', '(?<![a-z])gbp(?![a-z])|£|جنيه\\s*استرليني'],
];
const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,3}))?';

function parseNumber(intPart, fracPart) {
  const int = String(intPart).replace(/,/g, '');
  const value = Number(fracPart ? `${int}.${fracPart}` : int);
  return Number.isFinite(value) ? value : null;
}

function findMoneyMentions(n) {
  const mentions = [];
  const seen = [];
  for (const [code, currencyRx] of CURRENCY_PATTERNS) {
    const before = new RegExp(`(${currencyRx})\\s*[:\\-]?\\s*${NUM}`, 'gi'); // EGP 250.00
    const after = new RegExp(`${NUM}\\s*(?:${currencyRx})`, 'gi'); // 250.00 EGP
    for (const match of n.matchAll(before)) {
      const value = parseNumber(match[2], match[3]);
      if (value === null) continue;
      mentions.push({ value, currency: code, index: match.index, end: match.index + match[0].length, numStart: match.index + match[0].indexOf(match[2], match[1].length) });
    }
    for (const match of n.matchAll(after)) {
      const value = parseNumber(match[1], match[2]);
      if (value === null) continue;
      mentions.push({ value, currency: code, index: match.index, end: match.index + match[0].length, numStart: match.index });
    }
  }
  // إزالة التكرار (نفس الرقم اتلقط مرتين من الاتجاهين)
  mentions.sort((a, b) => a.numStart - b.numStart || a.index - b.index);
  const unique = [];
  for (const m of mentions) {
    if (unique.some((u) => Math.abs(u.numStart - m.numStart) < 2)) continue;
    unique.push(m);
    seen.push(m);
  }
  return unique;
}

const LABEL_BALANCE = /(الرصيد|رصيدك|رصيد|balance|\bbal\b|\bavl\b|available|المتاح|متاح)/;
const LABEL_FEE = /(رسوم|عموله|مصاريف|مصروفات\s*الخدمه|\bfees?\b|\bcharges?\b|commission|ضريبه|\bvat\b|\btax\b|service\s*fee)/;
const LABEL_LIMIT = /(الحد\s*(?:اليومي|الشهري|الاقصي)?|\blimit\b|سقف)/;

function sentenceStart(cleaned, index) {
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = cleaned[i];
    if (ch === '\n' || ch === ';' || ch === '؛') { start = i + 1; break; }
    if ((ch === '.' || ch === '!') && /\s/.test(cleaned[i + 1] || ' ') && !/\d/.test(cleaned[i - 1] || '')) { start = i + 1; break; }
  }
  return start;
}

function classifyMention(n, cleaned, mention) {
  const start = Math.max(sentenceStart(cleaned, mention.index), mention.index - 34);
  const window = n.slice(start, mention.index).replace(/(?:شحن|تعبئه|اضافه|زياده|recharge|top[-\s]?up)\s*(?:ال)?(?:رصيد|balance)?/g, ' شحن ');
  if (LABEL_BALANCE.test(window)) return 'balance';
  if (LABEL_FEE.test(window)) return 'fee';
  if (LABEL_LIMIT.test(window)) return 'limit';
  // "المبلغ 250 EGP رسوم 1 EGP": الرسوم قد تجي بعد الرقم مباشرة بكلمة "رسوم"
  return 'main';
}

// ---------------------------------------------------------------- القواعد العامة
const RX = {
  otp: /(\botp\b|رمز\s*(?:التحقق|التاكيد|الامان|سري|الدخول)|كلمه\s*(?:المرور|السر)\s*(?:المؤقته|لمره|الموقته)|verification\s*code|one[-\s]?time|do\s*not\s*share|لا\s*تشارك|لا\s*تخبر|\bcvv\b|رمز\s*تفعيل|activation\s*code|passcode)/,
  failed: /(تم\s*رفض|مرفوض|رفض\s*(?:العمليه|المعامله)|فشل[تة]?\s*(?:العمليه|المعامله)?|لم\s*تتم|لم\s*يتم\s*(?:تنفيذ|خصم)|غير\s*ناجح|\bdeclined\b|\bfailed\b|unsuccessful|\brejected\b|insufficient\s*(?:funds|balance)|رصيد\s*غير\s*كاف|لا\s*يوجد\s*رصيد\s*كاف|تم\s*الغاء|cancel(?:l)?ed|not\s*completed)/,
  inquiry: /(استعلام\s*عن\s*(?:الرصيد|رصيد)|balance\s*inquiry|balance\s*enquiry|your\s*balance\s*is|رصيدك\s*الحالي\s*هو|كشف\s*حساب\s*مختصر|mini\s*statement)/,
  completion: /(تم\s*(?:خصم|ايداع|سحب|تحويل|استلام|دفع|اضافه|شراء|رد|استرداد|استرجاع|صرف|شحن|سداد|قيد|تنفيذ)|قمت\s*ب|استلمت|حولت|دفعت|سحبت|was\s*(?:charged|debited|credited|deducted)|has\s*been\s*(?:debited|credited|deducted|added|processed)|debited|credited|purchase|withdrawal|withdrawn|payment\s*of|you\s*(?:have\s*)?(?:received|sent|paid|transferred|withdrew|deposited|purchased)|received|sent\s+egp|transferred|deposited|refund|cash\s*(?:in|out)|تحويل\s*(?:صادر|وارد)|خصم\s*(?:مبلغ|من|ب)|ايداع\s*(?:مبلغ|في)|سحب\s*(?:مبلغ|نقدي|من)|مبلغ\s*\d)/,
  promo: /(\d+\s*%|احصل\s*علي|اطلب\s*الان|قسط\s*بدون|عرض\s*خاص|بدون\s*فوايد|تقدم\s*الان|apply\s*now|special\s*offer|limited\s*offer|click\s*(?:here|the\s*link)|اضغط\s*علي\s*الرابط|win\s*a\s*prize|ربحت\s*جايزه)/,
  refund: /(استرداد|استرجاع|رد\s*مبلغ|رد\s*قيمه|\brefund(?:ed)?\b|reversal|reversed|تم\s*عكس)/,
  salary: /(مرتب|راتب|salary|payroll|(?<![\u0621-\u064a])اجر(?![\u0621-\u064a]))/,
  atm: /(\batm\b|صراف|ماكينه\s*(?:atm|صرف|سحب)|سحب\s*نقدي|cash\s*withdrawal|cash\s*out|سحب\s*من\s*وكيل|من\s*وكيل|agent)/,
  cashIn: /(cash\s*in|ايداع\s*نقدي|ايداع\s*(?:من\s*)?وكيل|ايداع\s*كاش)/,
  transferWord: /(تحويل|حوالي?|transfer|instapay|انستاباي|انستا\s*باي|send\s*money|money\s*transfer|ارسال\s*(?:اموال|مبلغ))/,
  topup: /(شحن|recharge|top[-\s]?up|تعبئه\s*رصيد|كارت\s*شحن)/,
  bill: /(فاتوره|فواتير|\bbill\b|سداد|utility|كهرباء|ميه|مياه|غاز|انترنت|تليفون\s*ارضي)/,
};

const OUT_PATTERNS = [
  [/تحويل\s*صادر/, 3], [/تم\s*تحويل/, 2], [/حولت/, 2], [/you\s*(?:have\s*)?(?:sent|transferred|paid|withdrew|purchased)/, 3],
  [/\bsent\b\s+(?:egp|usd|eur|sar|aed|\d)/, 2], [/(?:transfer(?:red)?|sent).{0,40}\bto\b/, 2],
  [/من\s*(?:حسابك|محفظتك|رصيدك|بطاقتك|كارتك)/, 2], [/\bخصم\b/, 3], [/مدين/, 3], [/\bdebit(?:ed)?\b/, 3],
  [/\bpurchase\b|\bpos\b/, 3], [/شراء|مشتريات/, 3], [/سحب|\bwithdraw/, 3], [/دفع|سداد|صرف/, 3],
  [/\bpaid\b|\bpayment\b/, 2], [/\bcharged\b/, 3], [/cash\s*out/, 3], [/\bspent\b/, 3], [/شحن|recharge|top[-\s]?up/, 2],
  [/\bdeducted\b/, 3],
];
const IN_PATTERNS = [
  [/تحويل\s*وارد/, 3], [/استلام|استلمت|\breceived?\b/, 3], [/ايداع/, 3], [/\bdeposit(?:ed)?\b/, 3],
  [/اضافه|تمت\s*اضافه|\badded\b/, 2], [/دائن/, 3], [/\bcredit(?:ed)?\b/, 3], [/استرداد|استرجاع|رد\s*مبلغ|\brefund/, 3],
  [/مرتب|راتب|\bsalary\b/, 2], [/cash\s*in/, 3], [/\bcashback\b/, 3], [/(?:الي|الى|to)\s*(?:حسابك|محفظتك|your\s*(?:account|wallet))/, 3],
];

function score(n, patterns) {
  let total = 0;
  const hits = [];
  for (const [rx, weight] of patterns) {
    if (rx.test(n)) { total += weight; hits.push(rx.source); }
  }
  return { total, hits };
}

// ---------------------------------------------------------------- التاجر / الطرف الآخر
const STOP_WORDS = /\s+(?:بتاريخ|تاريخ|الساعه|الساعة|بمبلغ|مبلغ|رقم|الرصيد|رصيدك|بطاقه|بطاقتك|كارت|عبر|بنجاح|رسوم|من\s*حسابك|من\s*محفظتك|on|with|card|ref|reference|balance|avl|available|date|time|using|via|for|thank|thanks|successfully|fee|fees|txn|trn)(?![a-z\u0621-\u064a])/i;

function trimEntity(value) {
  let v = String(value || '').split(/\n|\.\s+/)[0].trim();
  const stop = v.search(STOP_WORDS);
  if (stop > 0) v = v.slice(0, stop);
  v = v.replace(/[\s.,،:;'"()\-]+$/g, '').replace(/^[\s.,،:;'"()\-]+/g, '').replace(/\s{2,}/g, ' ').trim();
  return v.slice(0, 60);
}

function extractMerchant(cleaned) {
  const patterns = [
    /(?:لدى|لدي|عند|لدى\s*التاجر|بمتجر|من\s*متجر|فى|في)\s+([A-Za-z0-9&*'’\-][A-Za-z0-9&*'’.\- ]{1,45}|[\u0600-\u06FF][\u0600-\u06FF0-9 ]{1,30})/,
    /(?:\bat\s+|@\s*|\bmerchant[:\s]+|\bmerchant\s*name[:\s]+)([A-Za-z0-9&*'’][A-Za-z0-9&*'’.\- ]{1,45})/i,
    /(?:paid\s+to|payment\s+to|تم\s*الدفع\s*(?:الي|الى|ل))\s+([A-Za-z0-9&*'’\u0600-\u06FF][A-Za-z0-9&*'’.\u0600-\u06FF\- ]{1,45})/i,
  ];
  for (const rx of patterns) {
    const m = cleaned.match(rx);
    if (!m) continue;
    const value = trimEntity(m[1]);
    // نتجاهل قيم مش اسم تاجر: تواريخ/أرقام بطاقة/كلمات عامة
    if (!value || /^(?:agent|atm|branch|kiosk|وكيل|ماكينه|ماكينة|صراف|فرع)(?![\u0621-\u064aA-Za-z])/i.test(value) || /^\d[\d/\-:. ]*$/.test(value) || /^(?:حسابك|حسابكم|محفظتك|محفظتكم|بطاقتك|بطاقتكم|رصيدك|كارتك|your|the|account|card|wallet)(?![\u0621-\u064aA-Za-z])/i.test(value)) continue;
    return value;
  }
  return '';
}

const PHONE_RX = /(?:\+?20|0)?1[0125][\d*x]{8}/i;

const AR_L = '(?<![\\u0621-\\u064a])';
const AR_R = '(?![\\u0621-\\u064a])';

function extractCounterparty(cleaned, kind) {
  const phone = cleaned.match(PHONE_RX)?.[0] || '';
  const toRx = new RegExp(`(?:${AR_L}(?:الي|الى|إلى|لصالح)${AR_R}|\\bto\\b|\\bfor\\b)\\s+(?:محفظه\\s*)?([A-Za-z\\u0600-\\u06FF][A-Za-z\\u0600-\\u06FF ]{2,40})`, 'i');
  const fromRx = new RegExp(`(?:${AR_L}من${AR_R}|\\bfrom\\b)\\s+([A-Za-z\\u0600-\\u06FF][A-Za-z\\u0600-\\u06FF ]{2,40})`, 'i');
  const own = new RegExp(`^(?:حسابك|حسابكم|محفظتك|محفظتكم|رصيدك|بطاقتك|بطاقتكم|كارتك|your|my|account|wallet|card)${AR_R}`, 'i');
  const junk = new RegExp(`^(?:محفظه|محفظتك|رقم|حساب|instapay|انستاباي|انستا|فودافون|اتصالات|اورنج|number|الاهلي|بنك)${AR_R}`, 'i');
  let name = '';
  const rx = kind === 'in' ? fromRx : toRx;
  const m = cleaned.match(rx);
  if (m) {
    const v = trimEntity(m[1]);
    if (v && !own.test(v) && !junk.test(v) && !/\d{4,}/.test(v) && v.split(' ').length <= 5) name = v;
  }
  return { phone, name };
}

// ---------------------------------------------------------------- تصنيف الفئة للمصروف
const CATEGORY_RULES = [
  ['اشتراكات', /(netflix|spotify|shahid|شاهد|youtube|apple\.com|itunes|google\s*(?:play|one)|icloud|disney|osn|anghami|انغامي|subscription|اشتراك|prime\s*video|chatgpt|openai|adobe|microsoft|canva)/],
  ['أكل', /(restaurant|مطعم|cafe|coffee|كافيه|قهوه|starbucks|mcdonald|kfc|burger|pizza|بيتزا|talabat|طلبات|elmenus|المنيو|hungerstation|mrsool|كنتاكي|ماكدونالدز|زاد|cilantro|costa|tim\s*hortons|papa\s*john|domino|hardees|chili|bakery|مخبز|حلويات|مشويات|فطير|koshary|كشري)/],
  ['مواصلات', /(uber|careem|indrive|in\s*drive|swvl|bus|petrol|gas\s*station|محطه\s*(?:وقود|بنزين)|بنزين|وقود|total(?:energies)?|misr\s*petroleum|mobil|chillout|wataniya|وطنيه|cooperation|تعاون|parking|جراج|toll|رسوم\s*طريق|قطار|metro|مترو|egyptair|مصر\s*للطيران|ticket\s*(?:train|flight))/],
  ['فواتير', /(electric|كهرباء|water|مياه|ميه|gas\b|غاز|internet|انترنت|telecom|vodafone|orange|etisalat|we\s*egypt|فاتوره|bill|utility|fawry|فوري|mobile\s*(?:bill|recharge)|شحن|recharge|top[-\s]?up|رسوم|fee|insurance|تامين)/],
  ['صحة', /(pharmacy|صيدليه|seif|صيدليات|el\s*ezaby|العزبي|hospital|مستشفي|clinic|عياده|lab\b|معمل|طبيب|dr\.|doctor|dental|اسنان|vezeeta|فيزيتا|optic|نظارات|medical)/],
  ['تعليم', /(school|مدرسه|university|جامعه|academy|اكاديميه|course|كورس|udemy|coursera|tuition|مصاريف\s*دراسيه|nursery|حضانه|books|كتب|library|مكتبه)/],
  ['ترفيه', /(cinema|سينما|vox|movie|فيلم|game|gaming|playstation|steam|xbox|park|حديقه|club|نادي|theater|مسرح|gym|جيم|fitness|casino|concert|حفله)/],
  ['ملابس', /(zara|h&m|defacto|lc\s*waikiki|adidas|nike|puma|ملابس|clothes|fashion|shoes|احذيه|حذاء|mango|pull\s*&?\s*bear|bershka|american\s*eagle|max\s*fashion|town\s*team)/],
  ['منزل وأثاث', /(ikea|اثاث|furniture|home\s*centre|home\s*center|b\.?tech|بي\s*تك|raya|رايه|electronics|اجهزه\s*منزليه|tornado|sharp|kitchen|مطبخ|hardware|ادوات\s*منزليه|ace\s*hardware)/],
  ['هدايا وتبرعات', /(donation|تبرع|charity|جمعيه|خيري|57357|مستشفي\s*57357|resala|رساله|orman|gift|هديه|flowers|ورد)/],
  ['شخصي وعناية', /(salon|صالون|barber|حلاق|spa|beauty|تجميل|cosmetic|makeup|عطور|perfume|body\s*shop|nail)/],
  ['تسوق', /(carrefour|كارفور|hyper|هايبر|spinneys|سبينس|metro\s*market|مترو\s*ماركت|kazyon|كازيون|mall|مول|supermarket|سوبر\s*ماركت|market|ماركت|amazon|noon|jumia|جوميا|talabat\s*mart|seoudi|سعودي|fathalla|فتح\s*الله|awlad\s*ragab|اولاد\s*رجب|bim|بيم|abu\s*auf|store|shop|متجر|محل|breadfast|brimore|instashop)/],
];

function guessCategory(haystack, fallback = 'تسوق') {
  const text = String(haystack || '').toLowerCase();
  for (const [category, rx] of CATEGORY_RULES) {
    if (rx.test(searchForm(text))) return category;
  }
  return fallback;
}

// ---------------------------------------------------------------- المحلل الرئيسي
function emptyResult(extra = {}) {
  return { skip: null, confidence: 'none', items: [], meta: {}, hints: {}, ...extra };
}

export function parseBankSms(rawText, { sender = '' } = {}) {
  const cleaned = cleanSmsText(rawText);
  const n = searchForm(cleaned);
  if (!cleaned) return emptyResult({ skip: 'empty' });

  // ---- رسائل لازم نتجاهلها فورًا
  if (RX.otp.test(n)) return emptyResult({ skip: 'otp' });
  if (RX.failed.test(n) && !/(?:تم|was)\s*(?:خصم|charged|debited)/.test(n)) return emptyResult({ skip: 'failed_transaction' });

  const mentions = findMoneyMentions(n);
  if (!mentions.length) return emptyResult({ skip: 'no_amount' });

  const enriched = mentions.map((m) => ({ ...m, kind: classifyMention(n, cleaned, m) }));
  const main = enriched.find((m) => m.kind === 'main');
  const balanceMention = enriched.find((m) => m.kind === 'balance');
  const feeMention = enriched.find((m) => m.kind === 'fee');

  const hasCompletion = RX.completion.test(n);
  if (!main) {
    // كل الأرقام رصيد/رسوم/حد → استعلام رصيد أو رسالة عامة
    return emptyResult({ skip: RX.inquiry.test(n) || balanceMention ? 'balance_only' : 'no_main_amount', meta: { balance: balanceMention?.value ?? null } });
  }
  if (RX.inquiry.test(n) && !hasCompletion) return emptyResult({ skip: 'balance_inquiry' });
  if (RX.promo.test(n) && !hasCompletion) return emptyResult({ skip: 'promotional' });
  if (!hasCompletion) return emptyResult({ skip: 'no_transaction_verb', hints: { amount: main.value, currency: main.currency } });

  const currency = main.currency || 'EGP';
  const amount = main.value;
  if (!(amount > 0)) return emptyResult({ skip: 'invalid_amount' });

  const reference = (cleaned.match(/(?:رقم\s*(?:العمليه|العملية|المرجع|المعامله)|ref(?:erence)?(?:\s*no\.?)?|txn(?:\s*id)?|trn|transaction\s*(?:id|no\.?)|auth(?:orization)?\s*code)\s*[:#\-]?\s*([A-Za-z0-9\-]{5,24})/i) || [])[1] || '';
  const cardLast4 = (cleaned.match(/(?:\*{2,}|x{2,}|ending\s*(?:in|with)?\s*|رقم\s*)(\d{4})\b/i) || [])[1] || '';

  const out = score(n, OUT_PATTERNS);
  const inn = score(n, IN_PATTERNS);
  const isRefund = RX.refund.test(n);
  const isSalary = RX.salary.test(n);
  const isAtm = RX.atm.test(n);
  const isCashIn = RX.cashIn.test(n);
  const hasTransferWord = RX.transferWord.test(n);
  const isTopup = RX.topup.test(n);

  let direction = null; // 'in' | 'out'
  if (isRefund) direction = 'in';
  else if (out.total > inn.total) direction = 'out';
  else if (inn.total > out.total) direction = 'in';

  const merchant = extractMerchant(cleaned);
  const cp = extractCounterparty(cleaned, direction === 'in' ? 'in' : 'out');
  const counterparty = cp.phone || cp.name;

  const meta = {
    balance: balanceMention?.value ?? null,
    fee: feeMention?.value ?? null,
    reference,
    card_last4: cardLast4,
    merchant,
    direction,
    scores: { out: out.total, in: inn.total },
  };
  const base = { currency_code: currency, raw_text: cleaned };
  const feeNote = meta.fee ? ` (رسوم ${meta.fee})` : '';

  const done = (item, confidence = 'high', reason = '') => ({
    skip: null,
    confidence,
    items: [{ ...base, ...item, balance: meta.balance, fee: meta.fee, reference, card_last4: cardLast4 }],
    meta: { ...meta, reason },
    hints: { amount, currency, direction, merchant, counterparty },
  });

  // ---- لو الاتجاهين متعادلين أو مفيش اتجاه واضح → مش واثقين
  if (!direction) {
    return { ...emptyResult(), confidence: 'low', meta, hints: { amount, currency, merchant, counterparty }, skip: null, items: [] };
  }

  // ---- استرداد
  if (isRefund && direction === 'in') {
    return done({ type: 'refund', amount, category: guessCategory(`${merchant} ${cleaned}`), note: merchant ? `استرداد من ${merchant}` : 'استرداد مبلغ' }, 'high', 'refund');
  }

  // ---- سحب نقدي
  if (direction === 'out' && isAtm && !merchant) {
    const source = /atm|صراف/.test(n) ? 'سحب من ATM' : /وكيل|agent/.test(n) ? 'سحب من وكيل' : 'سحب نقدي';
    return done({ type: 'withdrawal', amount, note: `${source}${feeNote}` }, 'high', 'withdrawal');
  }
  // ---- إيداع نقدي / إيداع
  if (direction === 'in' && (isCashIn || /ايداع|deposit/.test(n)) && !hasTransferWord && !isSalary) {
    return done({ type: 'deposit', amount, note: isCashIn ? 'إيداع نقدي' : 'إيداع في الحساب' }, 'high', 'deposit');
  }
  // ---- مرتب/راتب
  if (direction === 'in' && isSalary) {
    return done({ type: 'income', amount, category: 'راتب', note: 'مرتب' }, 'high', 'salary');
  }

  // ---- تحويل (شخص/رقم/حساب) — بيتسجل كحركة بنكية محايدة (مش مصروف)
  const ownToOwn = /(?:من)\s*(?:حسابك|محفظتك)/.test(n) && /(?:الي|الى|to)\s*(?:حسابك|محفظتك)/.test(n);
  if (ownToOwn) {
    return done({ type: 'transfer', amount, direction: 'neutral', counterparty: '', needs_review: false, note: `تحويل بين حساباتك${feeNote}` }, 'high', 'own_transfer');
  }
  const person = Boolean(cp.phone || cp.name);
  const peerVerb = /استلام|استلمت|\breceived?\b|\bsent\b|ارسال|ارسلت/.test(n);
  const looksLikeTransfer = ((hasTransferWord && (counterparty || /instapay|انستاباي|send\s*money|transfer|تحويل/.test(n))) || (peerVerb && person)) && !merchant && !isTopup;
  if (looksLikeTransfer) {
    const label = direction === 'in' ? 'تحويل وارد' : 'تحويل صادر';
    const who = counterparty ? (direction === 'in' ? ` من ${counterparty}` : ` إلى ${counterparty}`) : '';
    const viaInsta = /instapay|انستاباي|انستا\s*باي/.test(n) ? ' عبر انستاباي' : '';
    return done({
      type: 'transfer',
      amount,
      direction,
      counterparty: counterparty || '',
      needs_review: Boolean(counterparty),
      note: `${label}${who}${viaInsta}${feeNote}`,
    }, counterparty ? 'high' : 'low', 'transfer');
  }

  // ---- مصروف (شراء/فاتورة/دفع/شحن)
  if (direction === 'out') {
    const haystack = `${merchant} ${cleaned}`;
    let category;
    let note;
    if (isTopup) { category = 'فواتير'; note = merchant ? `شحن رصيد (${merchant})` : 'شحن رصيد'; }
    else if (RX.bill.test(n) && !merchant) { category = guessCategory(haystack, 'فواتير'); note = 'سداد فاتورة'; }
    else { category = guessCategory(haystack, 'تسوق'); note = merchant || 'شراء بالبطاقة'; }
    const confident = Boolean(merchant) || isTopup || RX.bill.test(n) || /purchase|شراء|pos|مشتريات/.test(n);
    return done({ type: 'expense', amount, category, note, item: merchant }, confident ? 'high' : 'low', 'expense');
  }

  // ---- دخول غير مصنف (إضافة/دائن)
  if (direction === 'in') {
    return done({ type: 'deposit', amount, note: counterparty ? `إضافة من ${counterparty}` : 'إضافة للحساب' }, 'low', 'generic_credit');
  }

  return { ...emptyResult(), confidence: 'low', meta, hints: { amount, currency, merchant, counterparty } };
}

// أرقام النص الفعلية (لمراجعة ناتج الـ AI: المبلغ لازم يكون موجود فعلًا في الرسالة)
export function numbersInText(rawText) {
  const n = cleanSmsText(rawText);
  const values = [];
  for (const match of n.matchAll(new RegExp(NUM, 'g'))) {
    const v = parseNumber(match[1], match[2]);
    if (v !== null) values.push(v);
  }
  return values;
}

// نص "منظّف" نرسله للـ AI: بنشيل رقم الرصيد/الحد/الرسوم عشان ما يتلخبطش بينهم وبين المبلغ الحقيقي.
export function stripNoiseForAi(rawText) {
  const cleaned = cleanSmsText(rawText);
  const n = searchForm(cleaned);
  const mentions = findMoneyMentions(n).map((m) => ({ ...m, kind: classifyMention(n, cleaned, m) }));
  let result = cleaned;
  for (const m of mentions.filter((x) => x.kind !== 'main').sort((a, b) => b.index - a.index)) {
    result = `${result.slice(0, m.index)}[${m.kind === 'balance' ? 'BALANCE' : m.kind === 'fee' ? 'FEE' : 'LIMIT'}]${result.slice(m.end)}`;
  }
  return result;
}
