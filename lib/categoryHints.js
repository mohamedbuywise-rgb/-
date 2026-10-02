// طبقة تصنيف بالكلمات المفتاحية — بدون أي نداء AI وبدون أي تكلفة توكنز.
//
// المشكلة اللي بتحلها: الموديل كان بيميل يحط كل حاجة في "أكل" أو "مواصلات" أو "تسوق" (الفئات العامة)،
// وكمان لو رجّع فئة مش في القايمة كنا بنحطها "أكل" بالغلط (CATEGORIES[0]).
// الحل: لو الفئة اللي رجعت عامة وفي النص كلمة واضحة بتدل على فئة أدق (بنزين، قهوة، خضار، كارت شحن...)
// نستبدلها بالفئة الأدق. لو الموديل اختار فئة محددة أصلًا (صحة، تعليم، ملابس...) منلمسهاش.

import { CATEGORIES } from './config.js';

const DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g;

// توحيد الحروف العربية عشان «بنزينة/البنزين/بالبنزين» و«قهوة/قهوه» يتطابقوا.
export function normalizeForMatch(input) {
  return String(input || '')
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// سوابق عربية شائعة بتلزق في الكلمة: و/ب/ل/ف/ال/بال/لل/وال...
const PREFIXES = ['وبال', 'ولل', 'وال', 'بال', 'لل', 'ال', 'و', 'ب', 'ل', 'ف'];

function tokenVariants(token) {
  const out = [token];
  for (const prefix of PREFIXES) {
    if (token.startsWith(prefix) && token.length - prefix.length >= 3) out.push(token.slice(prefix.length));
  }
  return out;
}

// الترتيب هنا = الأولوية. الأدق أولًا (بنزين قبل مواصلات، شحن رصيد قبل فواتير...).
// الكلمات المفردة بتتطابق ككلمة كاملة (مع تجاهل السوابق)، والعبارات (فيها مسافة) بتتطابق كعبارة.
const RULES = [
  ['بنزين وسيارة', [
    'بنزين', 'بنزينه', 'سولار', 'وقود', 'محطه وقود', 'محطه بنزين', 'غسيل عربيه', 'غسيل سياره', 'غسيل العربيه',
    'جراج', 'ركنه', 'ونش', 'زيت موتور', 'تغيير زيت', 'تغيير الزيت', 'كاوتش', 'اطارات', 'ميكانيكي', 'ميكانيكا',
    'تصليح عربيه', 'صيانه عربيه', 'صيانه سياره', 'مخالفه مرور', 'رخصه عربيه', 'توتال', 'وطنيه',
    'petrol', 'fuel', 'diesel', 'gasoline', 'gas station', 'car wash', 'parking', 'oil change', 'tires', 'tyres',
  ]],
  ['اتصالات وإنترنت', [
    'كارت شحن', 'شحن رصيد', 'شحن كارت', 'شحن موبايل', 'شحن خط', 'شحن نت', 'رصيد موبايل', 'رصيد خط',
    'باقه', 'باقه نت', 'نت', 'انترنت', 'واي فاي', 'فودافون', 'اتصالات مصر', 'فاتوره موبايل', 'فاتوره الموبايل',
    'فاتوره تليفون', 'فاتوره التليفون', 'فاتوره خط', 'فاتوره نت', 'فاتوره انترنت',
    'recharge', 'topup', 'top up', 'wifi', 'internet', 'vodafone', 'etisalat', 'data bundle',
  ]],
  ['مشروبات', [
    'قهوه', 'نسكافيه', 'كابتشينو', 'لاتيه', 'اسبريسو', 'شاي', 'عصير', 'عصاير', 'مشروب', 'مشروبات', 'مشروب غازي',
    'بيبسي', 'كوكاكولا', 'كولا', 'ريد بول', 'ريدبول', 'سموذي', 'ميلك شيك', 'ملك شيك', 'كافيه', 'ستاربكس', 'كوستا',
    'سيلانترو', 'قهوجي', 'ينسون', 'عرقسوس', 'سحلب',
    'coffee', 'tea', 'juice', 'latte', 'cappuccino', 'espresso', 'smoothie', 'soda', 'pepsi', 'coca cola', 'red bull',
    'milkshake', 'cafe', 'drink', 'drinks', 'starbucks', 'costa',
  ]],
  ['بقالة وسوبر ماركت', [
    'بقاله', 'بقال', 'سوبر ماركت', 'سوبرماركت', 'هايبر', 'هايبر ماركت', 'كارفور', 'سبينس', 'خير زمان', 'اولاد رجب',
    'رجب سنونز', 'سعودي ماركت', 'كازيون', 'ميترو ماركت', 'مقاضي', 'خضار', 'خضروات', 'فاكهه', 'فراخ', 'لحمه', 'لحوم',
    'سمك', 'جبنه', 'لبن', 'عيش', 'بيض', 'رز', 'سكر', 'زيت', 'مكرونه', 'منظفات', 'طلبات البيت', 'مشتريات البيت',
    'grocery', 'groceries', 'supermarket', 'hypermarket', 'carrefour', 'spinneys', 'vegetables', 'fruits', 'meat', 'chicken',
  ]],
];

const COMPILED = RULES
  .filter(([category]) => CATEGORIES.includes(category))
  .map(([category, words]) => {
    const singles = new Set();
    const phrases = [];
    for (const word of words) {
      const normalized = normalizeForMatch(word);
      if (!normalized) continue;
      if (normalized.includes(' ')) phrases.push(` ${normalized} `);
      else singles.add(normalized);
    }
    return { category, singles, phrases };
  });

// بترجّع أدق فئة مناسبة للنص، أو null لو مفيش كلمة واضحة.
export function guessCategory(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return null;
  const padded = ` ${normalized} `;
  const variants = new Set(normalized.split(' ').flatMap(tokenVariants));
  for (const rule of COMPILED) {
    if (rule.phrases.some((phrase) => padded.includes(phrase))) return rule.category;
    for (const variant of variants) if (rule.singles.has(variant)) return rule.category;
  }
  return null;
}

// فئات عامة بنقبل نستبدلها بفئة أدق لو النص بيدل على كده.
// (صحة/تعليم/ملابس/ترفيه... فئات محددة أصلًا، فمنلمسهاش.)
const GENERIC_CATEGORIES = new Set(['أكل', 'تسوق', 'مواصلات', 'فواتير', 'منزل وأثاث', 'مصروف عام', 'أخرى', 'other', '']);

// modelCategory = اللي الموديل اختاره، text = وصف الصنف/المحل/الملاحظة.
// - فئة عامة + كلمة أدق في النص → الفئة الأدق.
// - فئة غير موجودة في القايمة → الفئة الأدق لو لقيناها، وإلا fallback (لو اتبعت) أو نفس اللي رجع.
export function resolveCategory(modelCategory, text, { fallback } = {}) {
  const current = String(modelCategory || '').trim();
  const guessed = guessCategory(text);
  const isKnown = CATEGORIES.includes(current);
  if (!isKnown) return guessed || fallback || current;
  if (guessed && guessed !== current && GENERIC_CATEGORIES.has(current)) return guessed;
  return current;
}
