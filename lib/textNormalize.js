// ============ تطبيع الأرقام العربية والأرقام المنطوقة باللهجة المصرية ============
// Whisper قد يرجع "مية" أو "ميتين" أو "تلاتمية" بدل 100/200/300،
// لذلك نطبع الأرقام المكتوبة والمنطوقة قبل إرسال النص إلى المصنّف.

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670]/g;
const ARABIC_WORD_CHARS = /[^\u0621-\u063A\u0641-\u064A0-9]/g;

function canonicalArabicWord(word) {
  return String(word || '')
    .normalize('NFKC')
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(ARABIC_WORD_CHARS, '');
}

const NUMBER_WORDS = new Map();
function addNumberWords(type, value, words) {
  for (const word of words) NUMBER_WORDS.set(canonicalArabicWord(word), { type, value });
}

addNumberWords('unit', 0, ['صفر', 'زيرو']);
addNumberWords('unit', 1, ['واحد', 'واحده', 'واحدة']);
addNumberWords('unit', 2, ['اتنين', 'تنين', 'اثنين', 'اثنان', 'اتنان']);
addNumberWords('unit', 3, ['تلاته', 'تلاتة', 'ثلاثه', 'ثلاثة', 'تلات', 'ثلاث']);
addNumberWords('unit', 4, ['اربعه', 'أربعة', 'اربع', 'أربع']);
addNumberWords('unit', 5, ['خمسه', 'خمسة']);
addNumberWords('unit', 6, ['سته', 'ستة', 'سته']);
addNumberWords('unit', 7, ['سبعه', 'سبعة']);
addNumberWords('unit', 8, ['تمانيه', 'ثمانيه', 'تمنيه', 'تمانية', 'تمن']);
addNumberWords('unit', 9, ['تسعه', 'تسعة']);

addNumberWords('ten', 10, ['عشر', 'عشرة']);
addNumberWords('direct', 11, ['حداشر', 'حداشر', 'احداشر', 'احد عشر', 'احدعشر']);
addNumberWords('direct', 12, ['اتناشر', 'اتناشر', 'اتنا عشر', 'اثناشر', 'اثنا عشر']);
addNumberWords('direct', 13, ['تلتاشر', 'تلتاشر', 'تلت عشر', 'تلاتاشر', 'تلات عشر', 'ثلاثتاشر']);
addNumberWords('direct', 14, ['اربعتاشر', 'اربعتاشر', 'اربع عشر', 'أربعة عشر']);
addNumberWords('direct', 15, ['خمستاشر', 'خمستاشر', 'خمس عشر', 'خمسة عشر']);
addNumberWords('direct', 16, ['ستاشر', 'ستاشر', 'ست عشر', 'ستة عشر']);
addNumberWords('direct', 17, ['سبعتاشر', 'سبعتاشر', 'سبع عشر', 'سبعة عشر']);
addNumberWords('direct', 18, ['تمنتاشر', 'تمانتاشر', 'تمانطاشر', 'ثمانتاشر', 'تمن عشر', 'ثمانية عشر']);
addNumberWords('direct', 19, ['تسعتاشر', 'تسعتاشر', 'تسع عشر', 'تسعة عشر']);

addNumberWords('ten', 20, ['عشرين', 'عشرون']);
addNumberWords('ten', 30, ['تلاتين', 'ثلاثين']);
addNumberWords('ten', 40, ['اربعين', 'أربعين']);
addNumberWords('ten', 50, ['خمسين']);
addNumberWords('ten', 60, ['ستين']);
addNumberWords('ten', 70, ['سبعين']);
addNumberWords('ten', 80, ['تمانين', 'تمانين', 'ثمانين']);
addNumberWords('ten', 90, ['تسعين']);

// الكلمات التي تظهر كثيرًا في نطق المئات المصري.
addNumberWords('hundred', 100, ['مية', 'ميه', 'مئه', 'مئة', 'مائه']);
addNumberWords('direct', 200, ['ميتين', 'مئتين', 'مائتين', 'مئتان']);
addNumberWords('direct', 300, ['تلتميه', 'تلت ميه', 'تلاتميه', 'تلات ميه', 'ثلاثميه', 'ثلاث ميه']);
addNumberWords('direct', 400, ['اربعمية', 'اربعميه', 'اربع ميه', 'ربعمية', 'ربعميه', 'ربع ميه']);
addNumberWords('direct', 500, ['خمسمية', 'خمسميه', 'خمس ميه']);
addNumberWords('direct', 600, ['ستمية', 'ستميه', 'ست ميه']);
addNumberWords('direct', 700, ['سبعمية', 'سبعميه', 'سبع ميه']);
addNumberWords('direct', 800, ['تمنمية', 'تمنميه', 'تمانمية', 'تمانميه', 'ثمانمية', 'ثمانميه', 'تمان ميه']);
addNumberWords('direct', 900, ['تسعمية', 'تسعميه', 'تسع ميه']);

addNumberWords('scale', 1000, ['الف', 'ألف', 'الاف', 'آلاف', 'ألاف', 'ألفًا']);
addNumberWords('scale', 2000, ['الفين', 'ألفين']);
addNumberWords('scale', 1000000, ['مليون', 'ملايين']);
addNumberWords('scale', 2000000, ['مليونين']);
addNumberWords('fraction', 0.5, ['نص', 'نصف']);
addNumberWords('fraction', 0.25, ['ربع']);

function tokenWord(rawToken) {
  return canonicalArabicWord(rawToken);
}

function getTokenEdges(rawToken) {
  const leading = String(rawToken).match(/^[^\u0621-\u063A\u0641-\u064A0-9]*/)?.[0] || '';
  const trailing = String(rawToken).match(/[^\u0621-\u063A\u0641-\u064A0-9]*$/)?.[0] || '';
  return { leading, trailing };
}

function numberPart(rawWord) {
  const word = tokenWord(rawWord);
  const direct = NUMBER_WORDS.get(word);
  if (direct) return { part: direct, conjunction: false };
  if (word.startsWith('و') && NUMBER_WORDS.has(word.slice(1))) {
    return { part: NUMBER_WORDS.get(word.slice(1)), conjunction: true };
  }
  // حرف الجر "ب" (بمعنى "بمبلغ") بيتلزق بالرقم المنطوق جدًا في العامية المصرية: "جبت أكل بتلاتمية"،
  // "اشتريت بخمسمية"، "جبته بميه". من غير الحالة دي، الرقم كان بيضيع بالكامل من الأساس — قبل ما
  // يوصل حتى لتقسيم البنود أو التصنيف، لأنه مش بيتحول لرقم خالص.
  if (word.startsWith('ب') && word.length > 1 && NUMBER_WORDS.has(word.slice(1))) {
    return { part: NUMBER_WORDS.get(word.slice(1)), conjunction: false };
  }
  return null;
}

function parseSpokenNumber(tokens, startIndex) {
  let total = 0;
  let current = 0;
  let index = startIndex;
  let matched = false;
  let lastPartType = null;

  while (index < tokens.length) {
    const word = tokenWord(tokens[index].raw);
    if (!word) break;

    // الواو داخل الرقم: "مية وعشرين"، "خمسة وعشرين".
    if (word === 'و' && matched) {
      const nextWord = tokenWord(tokens[index + 1]?.raw);
      const nextPart = NUMBER_WORDS.get(nextWord);
      // "مية وميتين" = مبلغين منفصلين، بينما "مية وعشرين" = 120.
      // المئات/المبالغ المباشرة بعد الواو تبدأ معاملة رقمية جديدة.
      if (nextPart && (!['hundred', 'direct', 'scale'].includes(nextPart.type) || lastPartType === 'scale')) {
        index += 1;
        continue;
      }
      break;
    }

    const resolved = numberPart(tokens[index].raw);
    if (!resolved) break;
    const { part, conjunction } = resolved;
    // إذا التصقت الواو بمئة/مبلغ مباشر، فهي تفصل مبلغًا جديدًا:
    // "مية وميتين" تُقرأ 100 ثم 200، وليست 300.
    if (conjunction && matched && ['hundred', 'direct', 'scale'].includes(part.type) && lastPartType !== 'scale') break;
    matched = true;
    lastPartType = part.type;

    if (part.type === 'hundred') {
      total += (current || 1) * part.value;
      current = 0;
    } else if (part.type === 'scale') {
      total += (current || 1) * part.value;
      current = 0;
    } else if (part.type === 'direct') {
      current += part.value;
    } else if (part.type === 'ten') {
      current += part.value;
    } else {
      current += part.value;
    }
    index += 1;
  }

  if (!matched) return null;
  const value = total + current;
  if (!Number.isFinite(value) || value < 0 || value > 1000000000) return null;
  return { value, endIndex: index };
}

export function normalizeEgyptianNumberWords(text) {
  let source = String(text || '');
  // بعض صيغ Whisper تأتي ككلمتين: "تلت ميه" بدل "تلت مية".
  // نطبعها أولًا كقيمة واحدة حتى لا تُفهم 3 + 100 كأنها 1300.
  const spacedHundreds = [
    [/تلت\s+(?:ميه|مية|مئه|مئة)/gu, '300'],
    [/تلات\s+(?:ميه|مية|مئه|مئة)/gu, '300'],
    [/ثلاث\s+(?:ميه|مية|مئه|مئة)/gu, '300'],
    [/اربع\s+(?:ميه|مية|مئه|مئة)/gu, '400'],
    [/ربع\s+(?:ميه|مية|مئه|مئة)/gu, '400'],
    [/خمس\s+(?:ميه|مية|مئه|مئة)/gu, '500'],
    [/ست\s+(?:ميه|مية|مئه|مئة)/gu, '600'],
    [/سبع\s+(?:ميه|مية|مئه|مئة)/gu, '700'],
    [/(?:تمن|تمان|ثمان)\s+(?:ميه|مية|مئه|مئة)/gu, '800'],
    [/تسع\s+(?:ميه|مية|مئه|مئة)/gu, '900'],
  ];
  for (const [pattern, replacement] of spacedHundreds) source = source.replace(pattern, replacement);
  const tokens = [...source.matchAll(/\S+/g)].map((match) => ({ raw: match[0], index: match.index }));
  if (!tokens.length) return source;

  let output = '';
  let cursor = 0;
  let tokenIndex = 0;

  while (tokenIndex < tokens.length) {
    const parsed = parseSpokenNumber(tokens, tokenIndex);
    if (!parsed) {
      tokenIndex += 1;
      continue;
    }

    const first = tokens[tokenIndex];
    const last = tokens[parsed.endIndex - 1];
    const firstEdges = getTokenEdges(first.raw);
    const lastEdges = getTokenEdges(last.raw);
    const firstNumberPart = numberPart(first.raw);
    const conjunctionPrefix = firstNumberPart?.conjunction ? 'و' : '';
    const replacement = `${firstEdges.leading}${conjunctionPrefix}${parsed.value}${lastEdges.trailing}`;

    output += source.slice(cursor, first.index);
    output += replacement;
    cursor = last.index + last.raw.length;
    tokenIndex = parsed.endIndex;
  }

  return output + source.slice(cursor);
}

export function normalizeDigits(text) {
  const digitNormalized = String(text || '')
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)));
  return normalizeEgyptianNumberWords(digitNormalized);
}

// لو نموذج التصنيف رجّع unknown رغم أن النص فيه مبلغ واضح، نقدر نسجّل مسودة مصروف آمنة
// بدل رسالة "محتاج مبلغ واضح". الفallback مقيد بعلامات المصروف ولا يتدخل في جمل الديون.
const EXPENSE_CATEGORY_HINTS = [
  { category: 'أكل', words: ['اكل', 'أكل', 'غذا', 'غدا', 'غذاء', 'غداء', 'فطار', 'فطور', 'عشا', 'عشاء', 'مطعم', 'كشري', 'قهوة', 'كافيه', 'حلويات', 'سوبر ماركت', 'بقاله', 'food', 'breakfast', 'lunch', 'dinner', 'groceries', 'restaurant'] },
  { category: 'مواصلات', words: ['مواصلات', 'تاكسي', 'اوبر', 'أوبر', 'بنزين', 'مترو', 'ميكروباص', 'اتوبيس', 'أتوبيس', 'transport', 'transportation', 'uber', 'taxi', 'fuel', 'metro'] },
  { category: 'تسوق', words: ['اشتريت', 'هدوم', 'ملابس', 'جزمه', 'جزمة', 'مشتريات', 'تلكرت', 'شحن خط', 'كارت شحن', 'امازون', 'أمازون', 'اونلاين', 'أونلاين', 'طلبات', 'shopping', 'clothes', 'purchase', 'amazon', 'online order'] },
  { category: 'فواتير', words: ['فاتوره', 'فاتورة', 'كهربا', 'كهرباء', 'مياه', 'غاز', 'نت', 'انترنت', 'إنترنت', 'bill', 'electricity', 'water', 'internet'] },
  { category: 'صحة', words: ['دكتور', 'دواء', 'علاج', 'صيدليه', 'صيدلية', 'كشف', 'health', 'medicine', 'doctor', 'protein', 'بروتين'] },
  { category: 'شخصي وعناية', words: ['حلاق', 'حلاقة', 'قص شعر', 'كوافير', 'personal care', 'barber'] },
  { category: 'ترفيه', words: ['سينما', 'فيلم', 'خروجه', 'خروجة', 'لعب', 'entertainment', 'cinema', 'movie', 'games'] },
  { category: 'اشتراكات', words: ['اشتراك', 'اشتراكات', 'نتفليكس', 'سبوتيفاي', 'شاهد', 'subscription', 'netflix', 'spotify'] },
  { category: 'هدايا وتبرعات', words: ['هدية', 'هدايا', 'تبرع', 'تبرعات', 'نفحة', 'نفح', 'صدقة', 'زكاة', 'gift', 'donation', 'charity'] },
  { category: 'تعليم', words: ['مدرسة', 'مدرسه', 'جامعة', 'جامعه', 'كورس', 'دروس', 'مصاريف دراسية', 'school', 'course', 'tuition'] },
  { category: 'منزل وأثاث', words: ['اثاث', 'أثاث', 'عفش', 'صيانة', 'صيانه', 'furniture', 'maintenance'] },
  { category: 'ملابس', words: ['هدوم', 'ملابس', 'جزمه', 'جزمة', 'clothes', 'shoes'] },
];

const INCOME_INTENT_WORDS = [
  'ربحت', 'كسبت', 'بعت', 'قبضت', 'استلمت', 'دخل لي', 'دخلتلي', 'إيراد', 'دخل',
  'earned', 'made', 'sold', 'received', 'income', 'revenue', 'salary', 'paycheck',
];

const EXPENSE_INTENT_WORDS = [
  'صرفت', 'دفعت', 'اشتريت', 'حجزت', 'غذا', 'غدا', 'غذاء', 'غداء', 'اكل', 'أكل', 'فطار', 'فطور', 'عشا', 'عشاء',
  'مواصلات', 'تاكسي', 'اوبر', 'أوبر', 'بنزين', 'مطعم', 'قهوة', 'فاتورة', 'كهربا', 'دواء', 'بروتين',
  'spent', 'paid', 'bought', 'purchase', 'breakfast', 'lunch', 'dinner', 'food', 'transport', 'transportation', 'uber', 'taxi', 'fuel', 'bill', 'medicine', 'groceries',
];

const CURRENCY_ALIASES = [
  { code: 'USD', words: ['دولار', 'دولارات', 'دولارا', 'دولارين', 'usd', 'us dollar', 'us dollars', 'dollar', 'dollars', '$'] },
  { code: 'EGP', words: ['جنيه', 'جنية', 'ج.م', 'جم', 'egp', 'egyptian pound', 'egyptian pounds'] },
  { code: 'EUR', words: ['يورو', 'euros', 'eur', 'euro', '€'] },
  { code: 'GBP', words: ['استرليني', 'جنيه استرليني', 'باوند', 'gbp', 'pound sterling', 'pounds sterling', '£'] },
  { code: 'SAR', words: ['ريال سعودي', 'ريال', 'sar', 'saudi riyal', 'saudi riyals'] },
  { code: 'AED', words: ['درهم اماراتي', 'درهم إماراتي', 'درهم', 'aed', 'uae dirham', 'dirhams'] },
  { code: 'KWD', words: ['دينار كويتي', 'دينار', 'kwd', 'kuwaiti dinar'] },
  { code: 'QAR', words: ['ريال قطري', 'qar', 'qatari riyal'] },
];

export function detectCurrency(text) {
  // نطبّع الفواصل حول العملة حتى نلتقط «300 دولار» و«300 USD» و«300$»
  // بدون أن يلتقط رمز $ الفارغ بقية النص ويحوّله خطأً إلى USD.
  const source = ` ${String(text || '').toLowerCase().replace(/[^\p{L}\p{N}$€£]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
  for (const currency of CURRENCY_ALIASES) {
    if (currency.words.some((word) => {
      const normalizedWord = String(word).toLowerCase().replace(/[^\p{L}\p{N}$€£]+/gu, ' ').replace(/\s+/g, ' ').trim();
      return normalizedWord && source.includes(` ${normalizedWord} `);
    })) return currency.code;
  }
  return 'EGP';
}

export function normalizeCurrencyCode(value, sourceText = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (/^[a-z]{3}$/i.test(raw)) return raw.toUpperCase();
  for (const currency of CURRENCY_ALIASES) {
    if (currency.words.some((word) => raw === String(word).toLowerCase() || raw.includes(String(word).toLowerCase()))) return currency.code;
  }
  return detectCurrency(sourceText);
}

export function coerceAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = normalizeDigits(String(value || '')).replace(/,/g, '');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

export function normalizeFinancialTransaction(transaction, sourceText = '') {
  const tx = transaction && typeof transaction === 'object' ? transaction : {};
  const amount = coerceAmount(tx.amount ?? tx.value ?? tx.total);
  const currency_code = normalizeCurrencyCode(tx.currency_code ?? tx.currencyCode ?? tx.currency ?? tx.currency_name, sourceText);
  return { ...tx, amount, currency_code, raw_text: tx.raw_text || String(sourceText || '').slice(0, 1200) };
}

export function reconcileSingleTransaction(transactions, sourceText = '') {
  if (!Array.isArray(transactions) || transactions.length !== 1) return transactions;
  const existing = transactions[0];
  const hint = extractDeterministicExpense(sourceText);
  if (!hint || !Number.isFinite(hint.amount)) return transactions;
  const knownType = ['expense', 'income', 'purchase', 'asset', 'transfer', 'refund', 'debt', 'settlement'].includes(existing.type);
  const repairedType = hint.type === 'income' ? 'income' : (knownType ? existing.type : hint.type);
  return [{
    ...existing,
    type: repairedType,
    amount: hint.amount,
    currency_code: hint.currency_code || existing.currency_code || 'EGP',
    category: (existing.type === 'expense' || !knownType) && hint.category !== 'مصروف عام' ? hint.category : existing.category,
    note: existing.note || hint.note,
    raw_text: existing.raw_text || String(sourceText || '').slice(0, 1200),
  }];
}

export function currencyLabel(code = 'EGP') {
  return ({ USD: 'دولار أمريكي', EGP: 'جنيه مصري', EUR: 'يورو', GBP: 'جنيه إسترليني', SAR: 'ريال سعودي', AED: 'درهم إماراتي', KWD: 'دينار كويتي', QAR: 'ريال قطري' })[String(code).toUpperCase()] || String(code).toUpperCase();
}

function containsWholePhrase(source, phrase) {
  const normalizedSource = String(source || '').toLowerCase();
  const normalizedPhrase = String(phrase || '').toLowerCase().trim();
  if (!normalizedPhrase) return false;
  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&').replace(/\\s+/g, '\\s+');
  return new RegExp(`(?:^|[\\s،,؛:!?()\\[\\]"'])(?:${escaped})(?=$|[\\s،,؛:!?()\\[\\]"'])`, 'iu').test(normalizedSource);
}

function containsAnyWholePhrase(source, phrases) {
  return phrases.some((phrase) => containsWholePhrase(source, phrase));
}

const DEBT_INTENT_WORDS = ['عطيت', 'اديت', 'أديت', 'سلفت', 'استلفت', 'اخدت', 'أخدت', 'واصل', 'دين', 'سددت دين', 'رجعت دين'];

export function correctDebtDirections(text, transactions) {
  const source = normalizeDigits(text);
  if (!Array.isArray(transactions) || transactions.length !== 1) return transactions;
  const only = transactions[0];
  if (!only || only.type !== 'debt') return transactions;

  // هذه العبارات تحدد صاحب الحق صراحة، فتتغلب على تخمين النموذج.
  // lent = المستخدم أخرج الفلوس، إذن له فلوس عند الشخص.
  const owedToUser = [
    /لي[\u064B-\u065F]*[اأإآيى]?\s*عند/iu,
    /واصل\s+(?:إلى|الى|ل|لي)(?:\s+عند)?\s+/iu,
    /عليه\s+لي/iu,
    /استلف\s+مني/iu,
    /خد(?:ت)?\s+مني/iu,
    /اخد(?:ت)?\s+مني/iu,
    /(?:سلفت|أديت|اديت|عطيت|ديت|دفعت|حولت)\s+(?!من\b)(?:ل(?:ـ)?|إلى|الى)?\s*\S+/iu,
    /محمد\s+(?:خد|اخد|استلف)\s+مني/iu,
  ].some((pattern) => pattern.test(source));
  // borrowed = الفلوس جاءت للمستخدم من الشخص، إذن عليه فلوس له.
  const owedByUser = [
    /علي[اىّ]?\s+(?:ل|عند)/iu,
    /واصل\s+(?:من|له\s+عندي)\s+/iu,
    /واصل\s+له\s+من[يّي]/iu,
    /استلفت\s+من/iu,
    /خد(?:ت)?\s+من/iu,
    /اخد(?:ت)?\s+من/iu,
    /(?:فلان|محمد|أحمد|احمد|الشخص)\s+(?:اداني|أداني|عطاني|أعطاني|سلفني)/iu,
    /(?:اداني|أداني|عطاني|أعطاني|سلفني)\b/iu,
  ].some((pattern) => pattern.test(source));

  if (owedToUser && !owedByUser) return [{ ...only, direction: 'lent' }];
  if (owedByUser && !owedToUser) return [{ ...only, direction: 'borrowed' }];
  return transactions;
}

export function extractDeterministicExpense(text) {
  const source = normalizeDigits(text);
  if (!source) return null;

  // يدعم: «أكل 500»، «مواصلات 300»، «فطار 100 جنيه»، وكذلك: «food 500 USD» و«transportation 300 dollars».
  // ومهم كمان: «120 مواصلات» (الرقم قبل الفئة، مش بعدها) — عشان كده الـ lookahead هنا مسموح فيه
  // كمان إن الرقم يكون متبوع بحرف عربي عادي (يعني كلمة فئة جاية بعده على طول)، مش بس نهاية الجملة
  // أو كلمة عملة. من غير ده، جملة زي "مية وعشرين مواصلات وتلاتمية اكل" كانت بترجع فاضية بالكامل.
  const amountMatch = source.match(/(?:^|[\s،,])([0-9]+(?:[.][0-9]+)?)(?=[\s]*(?:$|[،,]|جنيه|جنية|ج\.?م|جم|دولار|usd|\$|يورو|eur|€|باوند|gbp|£|ريال|sar|درهم|aed|دينار|kwd|qar|pounds?|dollars?|euros?|[\u0621-\u064A]))/iu);
  if (!amountMatch) return null;

  const hasCurrency = detectCurrency(source) !== 'EGP' || /(?:جنيه|جنية|ج\.?م|جم|egp)/iu.test(source);
  const hasExpenseIntent = containsAnyWholePhrase(source, EXPENSE_INTENT_WORDS);
  const hasIncomeIntent = containsAnyWholePhrase(source, INCOME_INTENT_WORDS);
  // مطابقة كلمة كاملة مهمة: «واصل» لا يجب أن تلتقط «مواصلات» وتحوّلها إلى دين.
  const hasDebtIntent = containsAnyWholePhrase(source, DEBT_INTENT_WORDS);
  const categoryHint = EXPENSE_CATEGORY_HINTS.find(({ words }) => words.some((word) => source.toLowerCase().includes(word.toLowerCase())));
  // كلمة فئة معروفة زي "حلويات" أو "سوبر ماركت" كافية لوحدها كإشارة مصروف، حتى لو الجملة مالهاش
  // فعل صريح زي "دفعت/اشتريت" (مهم للفويس اللي بيوصف البند من غير ما يقول فعل الشراء صراحة،
  // زي "وكمان شراء حلويات 500" — "شراء" مش موجودة في EXPENSE_INTENT_WORDS بس "حلويات" في الفئات).
  if (hasDebtIntent || (!hasCurrency && !hasExpenseIntent && !hasIncomeIntent && !categoryHint)) return null;

  const amount = Number(amountMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) return null;

  const currency_code = detectCurrency(source);
  const note = source
    .replace(amountMatch[0], ' ')
    .replace(/جنيه|جنية|ج\.?م|جم|egp|دولار|usd|\$|يورو|eur|€|باوند|gbp|£|ريال|sar|درهم|aed|دينار|kwd|qar/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (hasIncomeIntent) {
    const onlineIncome = /youtube|يوتيوب|online|اونلاين|أونلاين|freelance|فريلانس/iu.test(source);
    return { type: 'income', amount, currency_code, category: onlineIncome ? 'دخل/أونلاين' : 'دخل', note, raw_text: String(text || '').slice(0, 1200) };
  }

  const category = categoryHint?.category || 'مصروف عام';
  return { type: 'expense', amount, category, currency_code, note, raw_text: String(text || '').slice(0, 1200) };
}

// نسخة بتدعم أكتر من بند في نفس الرسالة، دي شبكة الأمان اللي بتشتغل لو تصنيف Groq فشل بالكامل
// (classifyMessage رجعت unknown). extractDeterministicExpense الأصلية بتلقط أول رقم في الجملة كلها
// وبس، فلو الرسالة فيها "أكل 100 ومواصلات 200 وقهوة 50" كانت بتاخد الـ 100 وتسيب الباقي.
// هنا بنقسّم الجملة على أدوات الربط الشائعة (و/وكمان/,/،) ونجرب نستخرج مصروف من كل جزء لوحده،
// فكل بند بياخد رقمه وفئته الصح بدل ما ياخدوا كلهم نفس الرقم أو يضيعوا.
// "و" في العامية المصرية دايمًا تقريبًا بتتلزق بالكلمة اللي بعدها من غير مسافة (ومواصلات، وكمان، و300).
// أول نسخة من التقسيم كانت بتشترط إن الرقم يجي قريب من الـ"و" على طول، لكن في الكلام الحقيقي
// (خصوصًا الفويس) بيبقى فيه كلمات حشو كتير بين الفئة والرقم ("وكمان طلبات من السوبر ماركت 300").
// فبدل ما نستنى الرقم، بنقسّم على أي "و" ملزوقة ببداية كلمة جديدة (سواء حرف أو رقم بعدها)،
// وبعدين كل قطعة بتتفحص لوحدها وبيتشال منها لو مفيهاش رقم فعلي.
const SEGMENT_SPLIT_PATTERN = /\s+(?=و[\u0621-\u064A0-9])|[,،؛]\s*/giu;

// ============ عدّاد تقريبي لعدد المبالغ المذكورة فعليًا في النص ============
// بيتستخدم كـ"مرجع" نتأكد بيه إن عدد المعاملات اللي رجعها Groq مايقلّش عن عدد الأرقام
// الحقيقي في الرسالة (زي فويس فيه 6 بنود لازم يطلع 6 معاملات مش 3). بيحول الأرقام
// المنطوقة (تلاتمية، خمسين...) لأرقام فعلية الأول، وبعدين يعد كل رقم مستقل في النص.
export function countExpectedAmounts(text) {
  const normalized = normalizeDigits(normalizeEgyptianNumberWords(String(text || '')));
  const matches = normalized.match(/\d+(?:\.\d+)?/g);
  return matches ? matches.length : 0;
}

export function extractDeterministicExpenses(text) {
  const source = normalizeDigits(text);
  if (!source) return [];

  const segments = source.split(SEGMENT_SPLIT_PATTERN).map((s) => s.trim()).filter(Boolean);
  if (segments.length <= 1) {
    const single = extractDeterministicExpense(source);
    return single ? [single] : [];
  }

  // بعد التقسيم، القطع اللي بعد الأولى بتبدأ غالبًا بـ"و" ملزوقة ("ومواصلات 200")، وده بيمنع
  // extractDeterministicExpense من التعرف على "مواصلات" ككلمة كاملة (مش مسبوقة بمسافة/بداية جملة).
  // نشيل الـ"و" الملزوقة من أول القطعة قبل التحليل، وده أأمن من إننا نغيّر شرط "الكلمة الكاملة"
  // نفسه في كل مكان تاني بالملف.
  const results = segments
    .map((segment) => segment.replace(/^و(?=[\u0621-\u064A0-9])/u, ''))
    .map((segment) => extractDeterministicExpense(segment))
    .filter(Boolean);
  // لو التقسيم كسّر الجملة وما لقيناش حاجة في القطع المنفصلة (مثلاً الفئة اتقالت مرة واحدة
  // في الأول وبتنطبق على كل الأرقام اللي بعدها)، نرجع لمحاولة الجملة كاملة كـ بند واحد
  // بدل ما نرجع مصفوفة فاضية بالكامل.
  if (results.length === 0) {
    const single = extractDeterministicExpense(source);
    return single ? [single] : [];
  }
  return results;
}
