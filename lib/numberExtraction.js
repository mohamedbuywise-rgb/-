// ============ طبقة استخراج الأرقام (منفصلة تمامًا عن الـ LLM) ============
// الهدف: نطلع كل الأرقام المذكورة في جملة (عربي/إنجليزي/أرقام منطوقة بالعامية المصرية)
// بشكل حتمي (deterministic) — من غير ما نعتمد على الموديل يفهمها صح كل مرة. بنستخدمها
// كطبقة تحقّق (cross-check) فوق المبلغ اللي الموديل استخرجه: لو الاتنين متفقين، ثقتنا
// عالية. لو مختلفين أو الـ regex مفيش حاجة، ثقتنا واطية ولازم نأكّد مع المستخدم.

// ---- تحويل الأرقام العربية (Eastern Arabic-Indic) للأرقام الإنجليزية ----
const ARABIC_INDIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
function normalizeDigits(text) {
  return String(text || '').replace(/[٠-٩]/g, (d) => ARABIC_INDIC_DIGITS[d] ?? d);
}

// ---- قاموس المئات (مية لحد تسعمية) ----
const HUNDREDS = {
  'مية': 100, 'ميه': 100, 'مائة': 100, 'مئة': 100,
  'ميتين': 200,
  'تلتمية': 300, 'تلتميه': 300, 'ثلاثمية': 300, 'ثلاثمائة': 300,
  'ربعمية': 400, 'ربعميه': 400, 'اربعمية': 400, 'أربعمية': 400,
  'خمسمية': 500, 'خمسميه': 500,
  'ستمية': 600, 'ستميه': 600,
  'سبعمية': 700, 'سبعميه': 700,
  'تمنمية': 800, 'تمنميه': 800, 'تمانمية': 800, 'ثمانمية': 800,
  'تسعمية': 900, 'تسعميه': 900,
};
// ---- قاموس العشرات (عشرين لحد تسعين) ----
const TENS = {
  'عشرين': 20, 'تلاتين': 30, 'ثلاثين': 30, 'اربعين': 40, 'أربعين': 40,
  'خمسين': 50, 'ستين': 60, 'سبعين': 70, 'تمانين': 80, 'ثمانين': 80, 'تسعين': 90,
};
// ---- قاموس الآحاد (لتركيبات زي "خمسة وعشرين") ----
const ONES = {
  'واحد': 1, 'اتنين': 2, 'إتنين': 2, 'اثنين': 2,
  'تلاتة': 3, 'ثلاثة': 3, 'اربعة': 4, 'أربعة': 4,
  'خمسة': 5, 'ستة': 6, 'سبعة': 7, 'تمانية': 8, 'ثمانية': 8, 'تسعة': 9,
};
// ---- الآلاف ----
const SCALES = { 'ألف': 1000, 'الف': 1000, 'ألفين': 2000, 'الفين': 2000, 'آلاف': 1000, 'الاف': 1000, 'تلاف': 1000 };
// ---- مضاعفات الآلاف ("تلات تلاف"، "خمسة آلاف") — نفس آحاد لكن قبل كلمة آلاف/تلاف ----
const THOUSAND_MULTIPLIERS = {
  'اتنين': 2, 'إتنين': 2, 'اثنين': 2,
  'تلات': 3, 'تلاتة': 3, 'ثلاثة': 3, 'اربع': 4, 'أربع': 4, 'اربعة': 4, 'أربعة': 4,
  'خمس': 5, 'خمسة': 5, 'ست': 6, 'ستة': 6, 'سبع': 7, 'سبعة': 7,
  'تمن': 8, 'تمان': 8, 'ثمانية': 8, 'تسع': 9, 'تسعة': 9, 'عشر': 10, 'عشرة': 10,
};

const ALL_WORD_DICTS = [HUNDREDS, TENS, ONES, SCALES, THOUSAND_MULTIPLIERS];
function lookupWord(word) {
  for (const dict of ALL_WORD_DICTS) {
    if (word in dict) return { value: dict[word], dict };
  }
  return null;
}

// ============ تفكيك كل كلمة لجذرها بعد شيل أي بادئة ملزوقة (و/ب/ل/ف) ============
// العامية بتلزّق حروف الجر وحرف العطف في أول الكلمة زي "بألف" أو "وميتين" أو "لخمسين".
// بنجرب الكلمة زي ما هي الأول، ولو مفيش تطابق نجرب نشيل أول حرف (لو من الحروف دي) ونعيد
// المحاولة.
function resolveToken(rawWord) {
  const direct = lookupWord(rawWord);
  if (direct) return direct;

  const prefixes = ['و', 'ب', 'ل', 'ف'];
  if (rawWord.length > 1 && prefixes.includes(rawWord[0])) {
    const stripped = rawWord.slice(1);
    const found = lookupWord(stripped);
    if (found) return found;
  }
  return null;
}

// ============ استخراج كل الأرقام (رقمية + منطوقة) من نص واحد ============
export function extractAmounts(rawText) {
  const text = normalizeDigits(String(rawText || ''));
  const amounts = [];

  // ---- 1) أرقام رقمية صريحة (بعد تحويل الأرقام العربية) — بتاخد أولوية لأنها الأوضح ----
  const digitMatches = text.matchAll(/\d+(?:[.,]\d+)?/g);
  for (const m of digitMatches) {
    const value = Number(String(m[0]).replace(',', ''));
    if (!Number.isNaN(value) && value > 0) amounts.push(value);
  }
  if (amounts.length > 0) return amounts;

  // ---- 2) أعداد منطوقة (مفيش أرقام رقمية صريحة في الجملة) ----
  const words = text.split(/\s+/).filter(Boolean);
  let combo = 0;
  let hasCombo = false;

  const flushCombo = () => {
    if (hasCombo && combo > 0) amounts.push(combo);
    combo = 0;
    hasCombo = false;
  };

  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w === 'و') { i += 1; continue; } // "و" لوحدها بتوصل، متكسرش التركيب

    // ---- "تلات تلاف" / "خمسة آلاف": مضاعف آلاف متبوع بكلمة "ألف/آلاف/تلاف" ----
    const nextWordStripped = i + 1 < words.length ? (words[i + 1][0] === 'و' ? words[i + 1].slice(1) : words[i + 1]) : null;
    if (w in THOUSAND_MULTIPLIERS && nextWordStripped && nextWordStripped in SCALES) {
      combo += THOUSAND_MULTIPLIERS[w] * SCALES[nextWordStripped];
      hasCombo = true;
      i += 2;
      continue;
    }

    const resolved = resolveToken(w);
    if (resolved) {
      combo += resolved.value;
      hasCombo = true;
      i += 1;
      continue;
    }

    // كلمة مش رقم — لو كنا في نص تركيب رقم، اقفله وابدأ من جديد
    flushCombo();
    i += 1;
  }
  flushCombo();

  return amounts;
}

// ============ أقرب رقم مستخرج للمبلغ اللي رجّعه الموديل، عشان نتحقق منه ============
export function amountConfirmedByText(modelAmount, rawText) {
  const found = extractAmounts(rawText);
  if (found.length === 0) return { confirmed: false, found };
  const match = found.some((n) => Math.abs(n - Number(modelAmount)) < 0.01);
  return { confirmed: match, found };
}

// ============ كشف "تعارض حجم الرقم" (magnitude conflict) — أخطار تفريغ صوتي كلاسيكية ============
// أخطر أنواع غلط الـ ASR في المبالغ مش أي فرق عشوائي، هو تحديدًا لما الرقم يتزوّد أو يتنقص
// بعامل 10 أو 100 (100↔1000، 500↔5000، 1500↔150، إلخ) — لأنه غالبًا غلطة "صفر زيادة/ناقص"
// في التفريغ نفسه، مش خلاف في الفهم. بنرصدها هنا بالذات (مش بس "مش متطابقين") عشان نقدر
// نعرض على المستخدم الاختيار الصريح ("تقصد 100 ولا 1000؟") بدل رفض عمومي.
const DANGEROUS_RATIOS = [10, 100, 0.1, 0.01];
function isMagnitudeConflict(a, b) {
  if (!a || !b) return false;
  const ratio = a / b;
  return DANGEROUS_RATIOS.some((r) => Math.abs(ratio - r) < 0.01);
}

// ============ محرك الثقة الموحّد للمبلغ — بيجمع رأي الموديل (AI) + الاستخراج الحتمي (Check A/B) ============
// دي نقطة الحقيقة الواحدة (single source of truth) لقرار "نتنفذ العملية على طول ولا نسأل
// المستخدم" — مستخدمة في مسار الداشبورد (api/record-expense-voice.js) ومسار بوت تليجرام
// (api/telegram-webhook.js) بنفس المنطق بالظبط، عشان مفيش فرق سلوك بين الاتنين.
//
// قاعدة أساسية: مبلغ الفلوس متتخمنش أبدًا. لو فيه تعارض حقيقي بين رأي الموديل والاستخراج
// الحتمي، أو الموديل نفسه مش واثق، بنطلب تأكيد بدل ما ننفّذ.
export function resolveAmountConfidence(modelAmount, modelConfidence, rawText) {
  const amount = Number(modelAmount);
  const { confirmed, found } = amountConfirmedByText(amount, rawText);
  const llmConf = typeof modelConfidence === 'number' ? modelConfidence : 0.7;

  // ---- Check A/B اتفقوا (نفس الرقم بالظبط) ----
  if (confirmed) {
    return {
      amountConfidence: Math.max(llmConf, 0.85),
      requiresConfirmation: false,
      magnitudeConflict: false,
      deterministicAmounts: found,
    };
  }

  // ---- مفيش أرقام حتمية في النص خالص (نادر) — نسيب رأي الموديل لوحده، بس منديش ثقة عمياء ----
  if (found.length === 0) {
    return {
      amountConfidence: llmConf,
      requiresConfirmation: llmConf < 0.6,
      magnitudeConflict: false,
      deterministicAmounts: [],
    };
  }

  // ---- فيه أرقام حتمية بس مش متطابقة مع رأي الموديل — تعارض واضح ----
  const magnitudeConflict = found.some((n) => isMagnitudeConflict(amount, n));
  return {
    // تعارض الحجم (10x/100x) خطر أكبر من أي تعارض تاني، فثقته أوطى بغض النظر عن ثقة الموديل.
    amountConfidence: magnitudeConflict ? Math.min(llmConf, 0.2) : Math.min(llmConf, 0.4),
    requiresConfirmation: true,
    magnitudeConflict,
    deterministicAmounts: found,
  };
}
