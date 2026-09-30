/**
 * lib/localClassifier.js  —  دبّر: Rule-Based Classifier + AI Fallback
 *
 * بيحلل الرسالة محليًا (مبلغ + نوع العملية + فئة + طرف الدين + تاريخ) من غير أي AI.
 * لو الثقة واطية بيرجّع route:'ai' مع السبب، وانت وقتها تبعت الرسالة للـ AI الحالي.
 *
 *   const { classifyMessage } = require('../lib/localClassifier.js');
 *   const r = classifyMessage(text, { userMap });
 *   if (r.route === 'local') save(r.transactions);   // بدون AI
 *   else callGroq(text, r.reason);                   // fallback
 *
 * بدون أي dependencies. شغال على Node 16+.
 */

/* ============================== الإعدادات ============================== */
const CONFIG = {
  LOCAL_THRESHOLD: 80,              // أقل نقاط للحفظ المحلي (من 100)
  MAX_AMOUNT: 100000000,
  FOREIGN_CURRENCY_TO_AI: true,     // عملة غير الجنيه -> AI
  DEFAULT_CURRENCY: 'EGP',
  DEFAULT_DIALECTS: ['eg', 'en', 'gulf', 'levant', 'maghreb'],
};

// أسماء الفئات اللي بترجع للتطبيق. عدّلها لتطابق فئات دبّر عندك بالظبط.
const LABELS = {
  food: 'أكل',
  drinks: 'مشروبات وقهوة',
  transport: 'مواصلات',
  fuel: 'بنزين',
  grocery: 'بقالة ومستلزمات غذائية',
  bills: 'فواتير',
  housing: 'إيجار وسكن',
  home: 'منزل وصيانة',
  health: 'صحة',
  education: 'تعليم',
  fun: 'ترفيه',
  subs: 'اشتراكات',
  shopping: 'تسوق',
  gifts: 'هدايا',
  care: 'عناية شخصية',
  car: 'صيانة سيارة',
  gameya: 'جمعية وأقساط',
  // دخل (نفس القيم اللي textNormalize بيستخدمها)
  salary: 'مرتب',
  freelance: 'بيع خدمة',
  bonus: 'أرباح استثمار',
  transfer: 'دخل متنوع',
  sales: 'دخل متنوع',
  rentIncome: 'دخل متنوع',
  otherIncome: 'دخل متنوع',
};

// أنواع العمليات اللي بترجع. عدّلها لتطابق اللي التطبيق بيستخدمه.
const TYPES = {
  expense: 'expense',
  income: 'income',
  debt_lent: 'debt_lent',               // سلفت حد / حد ليّا عنده
  debt_borrowed: 'debt_borrowed',       // استلفت من حد / عليا لحد
  debt_repay_out: 'debt_repay_out',     // رجّعت/سدّدت لحد
  debt_repay_in: 'debt_repay_in',       // حد رجّعلي / سدّد لي
};

/* ============================== التطبيع ============================== */
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function normalize(input) {
  let s = String(input == null ? '' : input);
  try { s = s.normalize('NFKC'); } catch (e) { /* ignore */ }
  s = s.toLowerCase();
  s = s.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u200c\u200d\u200e\u200f\u061c]/g, ''); // تشكيل + رموز خفية
  s = s.replace(/\u0640/g, '');                                                         // تطويل
  s = s.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  s = s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));
  s = s.replace(/٫/g, '.').replace(/٬/g, ',');
  s = s.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  s = s.replace(/\$/g, ' usd ').replace(/£/g, ' egp ').replace(/€/g, ' eur ');
  s = s.replace(/(\d)\s*l\.?\s?e\b\.?/g, '$1 egp ');
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');                 // 1,500 -> 1500
  s = s.replace(/(\p{L})(\d)/gu, '$1 $2').replace(/(\d)(\p{L})/gu, '$1 $2');
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  s = s.replace(/؟/g, ' ? ').replace(/\?/g, ' ? ');
  s = s.replace(/[^\p{L}\p{N}.\s?\n;؛،,+]/gu, ' ');
  return s.split('\n').map((l) => l.replace(/[ \t\r\f\v\u00a0]+/g, ' ').trim()).join('\n').trim();
}
const nw = (w) => normalize(w).replace(/\s+/g, ' ').trim();
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ============================== القاموس (طبقات لهجات) ============================== */
// كل طبقة تضيف على اللي قبلها. ضيف كلمات هنا من غير ما تلمس الكود.
const LAYERS = {
  /* ---------- مصري (الأساس) ---------- */
  eg: {
    expenseVerbs: ['دفعت', 'دفع', 'دفعنا', 'صرفت', 'صرفنا', 'صرف', 'اشتريت', 'اشترينا', 'شريت', 'حاسبت', 'حاسبني', 'حاسبوني',
      'اتحاسبت', 'اتخصم', 'اتخصمت', 'خصموا', 'خد مني', 'خدو مني', 'اخد مني', 'اتغديت', 'اتعشيت', 'تغديت', 'تعشيت',
      'فطرت', 'اكلت', 'كلت', 'شربت', 'ركبت', 'حجزت', 'اتصرفت', 'اتصرف', 'اتدفعت', 'اتدفع', 'انصرفت', 'اشتركت', 'جددت', 'شحنت', 'عبيت'],
    recordVerbs: ['سجل', 'سجلي', 'سجلت', 'ضيف', 'ضيفلي', 'اضف', 'اضيف', 'حط', 'حطلي'],
    incomeVerbs: ['قبضت', 'قبض', 'استلمت', 'اتسلمت', 'جالي', 'جاني', 'جتلي', 'نزل', 'نزلي', 'نزلت', 'اتحولي', 'اتحولت',
      'حولولي', 'حولوالي', 'حولوا لي', 'كسبت', 'ربحت', 'دفعولي', 'دفعلي', 'دفعوا لي', 'ادولي', 'اداني', 'ادوني'],
    categories: {
      food: ['اكل', 'اكلت', 'كلت', 'اكله', 'غدا', 'غداء', 'غدي', 'اتغديت', 'تغديت', 'عشا', 'عشاء', 'اتعشيت', 'تعشيت', 'فطار',
        'فطور', 'فطرت', 'سحور', 'مطعم', 'مطاعم', 'كشري', 'بيتزا', 'برجر', 'سندوتش', 'ساندوتش', 'سندوتشات', 'ساندوتشات',
        'شاورما', 'فول', 'طعميه', 'كباب', 'كفته', 'حلويات', 'وجبه', 'وجبات', 'ديليفري', 'دليفري', 'طلبات', 'ماكدونالدز',
        'ماك', 'كنتاكي', 'هارديز', 'بيتزا هت', 'دومينوز', 'اوردر اكل'],
      drinks: ['قهوه', 'كافيه', 'كافي', 'كوفي', 'نسكافيه', 'شاي', 'عصير', 'مشروب', 'مشروبات', 'ستاربكس', 'كوستا', 'لاتيه',
        'كابتشينو', 'ايس كوفي', 'سموذي', 'بيبسي', 'كوكاكولا', 'حاجه ساقعه'],
      transport: ['مواصلات', 'موصلات', 'تاكسي', 'اوبر', 'كريم', 'ان درايف', 'انديرايف', 'مترو', 'ميكروباص', 'ميكروباس',
        'اتوبيس', 'باص', 'قطر', 'قطار', 'موقف', 'ركنه', 'جراج', 'توكتوك', 'توك توك', 'تذكره', 'تذاكر',
        'رسوم طريق', 'كارته', 'اجره', 'ركبت'],
      grocery: ['سوبر ماركت', 'سوبرماركت', 'ماركت', 'بقاله', 'بقال', 'خضار', 'خضروات', 'فاكهه', 'فواكه', 'لحمه', 'لحم', 'فراخ',
        'دجاج', 'سمك', 'لبن', 'حليب', 'جبنه', 'جبن', 'بيض', 'رز', 'ارز', 'مكرونه', 'زيت', 'سمنه', 'سكر', 'عيش', 'خبز', 'مياه',
        'مناديل', 'منظفات', 'صابون', 'كارفور', 'هايبر', 'هايبروان', 'سبينيس', 'بيم', 'اولاد رجب', 'مستلزمات', 'عطاره',
        'جزار', 'جزاره', 'مخبز'],
      bills: ['فاتوره', 'فواتير', 'كهربا', 'كهرباء', 'غاز', 'انترنت', 'نت', 'واي فاي', 'وايفاي', 'فودافون', 'اورنج', 'اتصالات',
        'رصيد', 'شحن رصيد', 'كارت شحن', 'باقه', 'تليفون', 'خط', 'ايصال'],
      housing: ['ايجار', 'بواب', 'مصاريف عماره'],
      home: ['صيانه', 'سباك', 'كهربائي', 'نجار', 'نقاش', 'مفروشات'],
      fuel: ['بنزين', 'سولار', 'بنزينه'],
      gameya: ['جمعيه', 'جمعية', 'قسط', 'اقساط', 'قسط الجمعيه'],
      health: ['دكتور', 'دكتوره', 'كشف', 'عياده', 'صيدليه', 'دوا', 'دواء', 'ادويه', 'علاج', 'تحاليل', 'تحليل', 'اشعه',
        'مستشفي', 'عمليه', 'اسنان', 'نظاره', 'عدسات', 'فيتامينات', 'حقنه'],
      education: ['مدرسه', 'جامعه', 'مصاريف دراسيه', 'مصاريف مدرسه', 'دروس', 'درس', 'درس خصوصي', 'سنتر', 'كورس', 'كتب',
        'كتاب', 'كراسات', 'ادوات مدرسيه', 'تعليم', 'حضانه', 'اكاديميه', 'امتحان'],
      fun: ['سينما', 'فيلم', 'خروجه', 'رحله', 'سفر', 'فندق', 'حجز', 'حفله', 'مسرح', 'ملاهي', 'العاب', 'لعبه', 'بلايستيشن',
        'جيم', 'نادي', 'رياضه', 'كوره', 'ملعب', 'مصيف', 'شاليه', 'ترفيه', 'خروج'],
      subs: ['اشتراك', 'اشتراكات', 'نتفلكس', 'نتفليكس', 'شاهد', 'سبوتيفاي', 'انغامي', 'يوتيوب بريميوم', 'ايكلاود',
        'شات جي بي تي', 'شاتجيبيتي', 'ديزني', 'امازون برايم'],
      shopping: ['ملابس', 'هدوم', 'قميص', 'بنطلون', 'جزمه', 'حذاء', 'فستان', 'تيشرت', 'شنطه', 'تسوق', 'شوبنج', 'مول',
        'اكسسوار', 'اكسسوارات', 'موبايل', 'لاب توب', 'لابتوب', 'شاحن', 'سماعه', 'سماعات', 'جاكت', 'كوتشي', 'كوتش',
        'اثاث', 'ديكور', 'تلفزيون', 'ثلاجه', 'غساله'],
      gifts: ['هديه', 'هدايا', 'عيديه', 'زكاه', 'صدقه', 'صدقات', 'تبرع', 'تبرعات', 'مصروف البيت', 'مصروف', 'عزومه', 'فرح',
        'نقطه'],
      care: ['حلاق', 'حلاقه', 'كوافير', 'صالون', 'عطر', 'مكياج', 'ميك اب', 'كريم ترطيب', 'شامبو', 'مانيكير', 'بديكير',
        'سبا', 'ليزر'],
      car: ['عربيه', 'سياره', 'ميكانيكي', 'غسيل عربيه', 'غسيل', 'زيت موتور', 'اطارات', 'كاوتش', 'بطاريه', 'مخالفه', 'رخصه',
        'ترخيص', 'ونش', 'ورشه'],
    },
    incomeCategories: {
      salary: ['مرتب', 'راتب', 'مرتبي', 'ماهيه', 'معاش', 'مرتبات'],
      freelance: ['فريلانس', 'فري لانس', 'مشروع', 'شغل', 'شغلانه', 'عميل', 'اجر', 'اجره', 'اتعاب'],
      bonus: ['مكافاه', 'بونص', 'عموله', 'ارباح', 'ربح', 'حافز', 'بدل'],
      transfer: ['حواله', 'تحويل', 'تحويله', 'انستاباي', 'فودافون كاش', 'هديه', 'عيديه', 'مساعده'],
      sales: ['بيع', 'بعت', 'اتباع', 'مبيعات', 'بيعت'],
      rentIncome: ['ايجار', 'ايجاره', 'ايجارات'],
    },
  },

  /* ---------- إنجليزي ---------- */
  en: {
    expenseVerbs: ['spent', 'spend', 'paid', 'pay', 'paying', 'bought', 'buy', 'purchased', 'ate', 'ordered', 'cost me',
      'charged me', 'paid for', 'had lunch', 'had dinner', 'had breakfast'],
    recordVerbs: ['add', 'record', 'log', 'note'],
    incomeVerbs: ['received', 'earned', 'got paid', 'was paid', 'got salary', 'paid me', 'income', 'deposited', 'deposit'],
    categories: {
      food: ['food', 'lunch', 'dinner', 'breakfast', 'meal', 'restaurant', 'pizza', 'burger', 'sandwich', 'snack', 'takeout',
        'mcdonalds', 'kfc', 'fast food', 'dining', 'ate'],
      drinks: ['coffee', 'cafe', 'tea', 'juice', 'latte', 'cappuccino', 'starbucks', 'costa', 'drink', 'drinks', 'smoothie'],
      transport: ['taxi', 'uber', 'careem', 'metro', 'bus', 'train', 'fuel', 'petrol', 'parking', 'transport',
        'transportation', 'ride', 'tuktuk', 'toll'],
      grocery: ['groceries', 'grocery', 'supermarket', 'vegetables', 'fruits', 'meat', 'chicken', 'bread', 'milk', 'eggs',
        'carrefour', 'hypermarket'],
      bills: ['bill', 'bills', 'electricity', 'internet', 'wifi', 'phone bill', 'mobile bill', 'water bill', 'gas bill',
        'vodafone', 'etisalat', 'recharge', 'topup'],
      housing: ['rent', 'mortgage', 'maintenance', 'plumber', 'electrician'],
      health: ['doctor', 'pharmacy', 'medicine', 'hospital', 'clinic', 'dentist', 'checkup'],
      education: ['school', 'university', 'course', 'tuition', 'books', 'class', 'exam'],
      fun: ['cinema', 'movie', 'movies', 'game', 'games', 'trip', 'hotel', 'travel', 'concert', 'outing', 'gym', 'vacation'],
      subs: ['subscription', 'netflix', 'spotify', 'prime', 'icloud', 'chatgpt', 'youtube premium'],
      shopping: ['clothes', 'shoes', 'shopping', 'shirt', 'mall', 'dress', 'laptop', 'headphones', 'electronics'],
      gifts: ['gift', 'gifts', 'donation', 'charity', 'zakat'],
      care: ['haircut', 'barber', 'salon', 'perfume', 'makeup', 'skincare'],
      car: ['car wash', 'mechanic', 'tires', 'car service'],
    },
    incomeCategories: {
      salary: ['salary', 'payroll', 'wage', 'wages', 'pension', 'paycheck'],
      freelance: ['freelance', 'client', 'project', 'gig', 'invoice'],
      bonus: ['bonus', 'commission', 'profit', 'profits', 'dividend', 'cashback', 'refund'],
      transfer: ['transfer', 'gift', 'allowance'],
      sales: ['sold', 'sale', 'sales'],
      rentIncome: ['rent', 'rental income'],
    },
  },

  /* ---------- خليجي ---------- */
  gulf: {
    expenseVerbs: ['شريت', 'دفعت', 'صرفت', 'حاسبت'],
    incomeVerbs: ['وصلني', 'نزل الراتب', 'استلمت', 'جاني', 'حولولي'],
    categories: {
      food: ['برياني', 'مندي', 'مضبي', 'كبسه', 'شاورما', 'وجبه'],
      drinks: ['كرك', 'شاهي', 'دانكن', 'تيم هورتنز'],
      transport: ['ساهر', 'ليموزين', 'سالك'],
      grocery: ['تموينات', 'لولو', 'بنده', 'الدانوب', 'خضار', 'لحم'],
      bills: ['ماء', 'stc', 'زين', 'موبايلي'],
    },
    incomeCategories: { salary: ['راتب', 'حافز', 'بدل'] },
  },

  /* ---------- شامي ---------- */
  levant: {
    expenseVerbs: ['دفعت', 'صرفت', 'اشتريت', 'شريت', 'حاسبت'],
    incomeVerbs: ['قبضت', 'استلمت', 'نزلولي', 'اجاني', 'جاني', 'حولولي'],
    categories: {
      food: ['شاورما', 'فلافل', 'مناقيش', 'فتوش', 'كبه', 'مشاوي', 'فروج'],
      transport: ['تكسي', 'سرفيس', 'باص', 'مازوت', 'كازيه', 'موقف'],
      grocery: ['دكان', 'خضره', 'فروج', 'لحمه'],
      bills: ['مويه', 'كهربا', 'انترنت'],
    },
    incomeCategories: { salary: ['راتب', 'معاش'] },
  },

  /* ---------- مغاربي ---------- */
  maghreb: {
    expenseVerbs: ['خلصت', 'شريت', 'دفعت', 'صرفت'],
    incomeVerbs: ['جاني', 'توصلت', 'خلصوني'],
    categories: {
      food: ['ماكله', 'طاجين', 'كسكس', 'ساندويتش', 'فطور', 'غدا', 'عشاء'],
      drinks: ['اتاي', 'قهوه', 'عصير'],
      transport: ['طاكسي', 'طوبيس', 'ترامواي', 'طرامواي', 'كازوال', 'قطار'],
      grocery: ['سوق', 'مرجان', 'حانوت', 'ماركيت'],
      housing: ['كراء', 'كرا'],
      bills: ['ماء', 'كهرباء', 'فاتوره'],
    },
    incomeCategories: { salary: ['اجره', 'راتب', 'معاش'] },
  },
};

// كلمات غامضة: لوحدها نص وزن بس
const WEAK = new Set(['شاي', 'كريم', 'كارت', 'شحن', 'غسيل', 'مصروف', 'صيانه', 'حجز', 'سفر', 'لعبه', 'نت', 'خط', 'رصيد',
  'موبايل', 'شاحن', 'سنتر', 'كتاب', 'قسط', 'اقساط', 'عمليه', 'كشف', 'نادي', 'ماركت', 'بيم', 'ماك', 'نقطه', 'اجره', 'اجر',
  'غاز', 'ركبت', 'بعت', 'bus', 'ride', 'class', 'prime', 'sale', 'project', 'transfer', 'gift', 'ماء', 'باص', 'فرح'].map(nw));

/* ============================== الأرقام ============================== */
const NUM_WORDS = new Map();
function addNums(obj, kind) { for (const w of Object.keys(obj)) NUM_WORDS.set(nw(w), [kind, obj[w]]); }
addNums({
  'اتنين': 2, 'اثنين': 2, 'اثنان': 2, 'ثنتين': 2,
  'تلاته': 3, 'ثلاثه': 3, 'تلات': 3, 'ثلاث': 3, 'اربعه': 4, 'اربع': 4, 'خمسه': 5, 'خمس': 5, 'سته': 6, 'سبعه': 7,
  'تمانيه': 8, 'ثمانيه': 8, 'ثماني': 8, 'تماني': 8, 'تسعه': 9, 'تسع': 9, 'عشره': 10, 'عشر': 10,
  'حداشر': 11, 'احداشر': 11, 'اتناشر': 12, 'اثناعشر': 12, 'تلتاشر': 13, 'تلاتاشر': 13, 'اربعتاشر': 14, 'خمستاشر': 15,
  'ستاشر': 16, 'سبعتاشر': 17, 'تمنتاشر': 18, 'تسعتاشر': 19,
  'عشرين': 20, 'عشرون': 20, 'تلاتين': 30, 'ثلاثين': 30, 'ثلاثون': 30, 'اربعين': 40, 'اربعون': 40, 'خمسين': 50, 'خمسون': 50,
  'ستين': 60, 'ستون': 60, 'سبعين': 70, 'سبعون': 70, 'تمانين': 80, 'ثمانين': 80, 'ثمانون': 80, 'تسعين': 90, 'تسعون': 90,
  'ميتين': 200, 'مئتين': 200, 'مائتين': 200, 'مايتين': 200,
  'تلتميه': 300, 'تلاتميه': 300, 'ثلاثميه': 300, 'ثلاثمائه': 300, 'ثلاثمايه': 300,
  'ربعميه': 400, 'اربعميه': 400, 'اربعمائه': 400, 'خمسميه': 500, 'خمسمائه': 500, 'خمسمايه': 500,
  'ستميه': 600, 'ستمائه': 600, 'سبعميه': 700, 'سبعمائه': 700, 'تمنميه': 800, 'ثمانميه': 800, 'ثمانمائه': 800,
  'تسعميه': 900, 'تسعمائه': 900,
  'الفين': 2000, 'الفان': 2000, 'مليونين': 2000000,
  // english
  'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11,
  'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18,
  'nineteen': 19, 'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80,
  'ninety': 90,
}, 'abs');
addNums({ 'ميه': 100, 'مايه': 100, 'مائه': 100, 'hundred': 100 }, 'hundred');
addNums({ 'الف': 1000, 'الاف': 1000, 'آلاف': 1000, 'مليون': 1e6, 'ملايين': 1e6, 'thousand': 1000, 'million': 1e6 }, 'mult');
addNums({ 'نص': 0.5, 'نصف': 0.5, 'ربع': 0.25 }, 'frac');
// كلمات غامضة: بتتحسب رقم بس لو بعدها مية/ألف
const AMBIG_NUMS = new Map([['ست', 6], ['سبع', 7], ['تمن', 8], ['one', 1]]);

const CURRENCY = new Map();
[['جنيه', 'EGP'], ['جنيها', 'EGP'], ['جنيهات', 'EGP'], ['جنية', 'EGP'], ['ج', 'EGP'], ['egp', 'EGP'], ['pound', 'EGP'],
  ['pounds', 'EGP'], ['دولار', 'USD'], ['usd', 'USD'], ['dollar', 'USD'], ['dollars', 'USD'], ['يورو', 'EUR'],
  ['eur', 'EUR'], ['euro', 'EUR'], ['ريال', 'SAR'], ['sar', 'SAR'], ['riyal', 'SAR'], ['درهم', 'AED'], ['aed', 'AED'],
  ['dirham', 'AED'], ['دينار', 'DINAR'], ['ليره', 'LIRA']].forEach(([w, c]) => CURRENCY.set(nw(w), c));

const QTY_UNITS = new Set(['كيلو', 'كيلوجرام', 'جرام', 'غرام', 'لتر', 'علبه', 'علب', 'قطعه', 'قطع', 'حبه', 'حبات', 'كوب',
  'اكواب', 'ساعه', 'ساعات', 'يوم', 'ايام', 'شخص', 'اشخاص', 'نفر', 'مره', 'مرات', 'كرتونه', 'شهر', 'شهور', 'اسبوع',
  'kg', 'g', 'liter', 'liters', 'pieces', 'pcs', 'hours', 'days', 'people', 'times', 'items', 'month', 'months', 'week'].map(nw));
const PRE_AMOUNT = new Set(['ب', 'بمبلغ', 'مبلغ', 'بقيمه', 'بسعر', 'for', 'بحوالي']);

const DATE_WORDS = new Map([['النهارده', 0], ['انهارده', 0], ['اليوم', 0], ['today', 0], ['امبارح', -1], ['مبارح', -1],
  ['امس', -1], ['البارح', -1], ['البارحه', -1], ['yesterday', -1]]);

const QUESTION_WORDS = new Set(['كام', 'كم', 'ايه', 'ازاي', 'ليه', 'هل', 'امتي', 'فين', 'مين', '?', 'how', 'what', 'when',
  'why', 'where', 'who', 'وريني', 'اعرض', 'اعرضلي', 'قولي', 'ملخص', 'تقرير', 'احصائيات', 'show', 'summary', 'report']);

const STOP = new Set(['على', 'علي', 'في', 'من', 'الي', 'الى', 'ل', 'ب', 'و', 'مع', 'عن', 'كان', 'ده', 'دي', 'دا', 'دول', 'هو',
  'هي', 'انا', 'لي', 'ليا', 'لو', 'بس', 'كمان', 'برضو', 'فلوس', 'مبلغ', 'حاجه', 'شويه', 'مصاري', 'ال', 'the', 'a', 'an',
  'on', 'for', 'of', 'to', 'my', 'i', 'at', 'in', 'with', 'and', 'me', 'بمبلغ', 'بقيمه', 'بسعر'].map(nw));

const CONNECTORS = new Set(['و', 'and', 'وكمان', 'وبعدين', 'برضو', 'وبرضو', 'كمان', 'also', 'then', 'plus', 'ثم', 'وبعدها', 'بعدها', 'وبعد كده'].map(nw).filter((x) => !x.includes(' ')));

const BAD_NAMES = new Set(['لي', 'ليا', 'من', 'علي', 'عليا', 'فلوس', 'مبلغ', 'كل', 'بس', 'كمان', 'دين', 'قسط', 'الدين',
  'المبلغ', 'القسط', 'النهارده', 'امبارح', 'back', 'me', 'to', 'from', 'money', 'cash', 'نفسي', 'ده', 'دي']);
const LAM_NAMES = new Set(['ليلي', 'لبني', 'لميس', 'لينا', 'ليث', 'لطفي', 'لوي', 'لبيبه', 'لمياء', 'لمياء']);

/* ============================== سياق مبني من الطبقات ============================== */
const CTX_CACHE = new Map();

function phraseRe(p) { return new RegExp('(?:^|\\s)(?:[وفبلك]?(?:ال)?)' + escapeRe(p) + '(?=\\s|$)', 'u'); }

function buildIndex(list) {
  const words = new Map();
  const phrases = [];
  for (const cats of list) {
    for (const cat of Object.keys(cats)) {
      for (const raw of cats[cat]) {
        const w = nw(raw);
        if (!w) continue;
        const weak = WEAK.has(w);
        if (w.includes(' ')) phrases.push({ re: phraseRe(w), cat, weak });
        else {
          if (!words.has(w)) words.set(w, []);
          const l = words.get(w);
          if (!l.some((x) => x.cat === cat)) l.push({ cat, weak });
        }
      }
    }
  }
  return { words, phrases };
}

function buildLex(arrays) {
  const words = new Set();
  const phrases = [];
  for (const arr of arrays) for (const raw of arr) {
    const w = nw(raw);
    if (!w) continue;
    if (w.includes(' ')) phrases.push(phraseRe(w)); else words.add(w);
  }
  return { words, phrases };
}

function getContext(opts) {
  const dialects = (opts && opts.dialects) || CONFIG.DEFAULT_DIALECTS;
  const key = dialects.join(',');
  if (CTX_CACHE.has(key)) return CTX_CACHE.get(key);
  const layers = dialects.map((d) => LAYERS[d]).filter(Boolean);
  const ctx = {
    expenseIndex: buildIndex(layers.map((l) => l.categories || {})),
    incomeIndex: buildIndex(layers.map((l) => l.incomeCategories || {})),
    expenseVerbs: buildLex(layers.map((l) => l.expenseVerbs || [])),
    recordVerbs: buildLex(layers.map((l) => l.recordVerbs || [])),
    incomeVerbs: buildLex(layers.map((l) => l.incomeVerbs || [])),
  };
  CTX_CACHE.set(key, ctx);
  return ctx;
}

/* ============================== أدوات نصية ============================== */
const PREFIX_LETTERS = ['و', 'ف', 'ب', 'ل', 'ك'];
function variants(tok) {
  const set = new Set([tok]);
  let cur = [tok];
  for (let round = 0; round < 2; round++) {
    const next = [];
    for (const t of cur) {
      if (t.length > 3 && PREFIX_LETTERS.includes(t[0])) next.push(t.slice(1));
      if (t.length > 4 && t.startsWith('لل')) next.push('ال' + t.slice(2));
    }
    next.forEach((x) => set.add(x));
    cur = next;
  }
  for (const t of Array.from(set)) if (t.startsWith('ال') && t.length > 4) set.add(t.slice(2));
  if (/^[a-z]+$/.test(tok) && tok.length > 3) {
    if (tok.endsWith('s')) set.add(tok.slice(0, -1));
    if (tok.endsWith('es')) set.add(tok.slice(0, -2));
  }
  return Array.from(set);
}

function lexMatch(lex, tokens, text) {
  for (const t of tokens) for (const v of variants(t)) if (lex.words.has(v)) return true;
  return lex.phrases.some((re) => re.test(text));
}

function numInfo(tok, next, inPhrase) {
  if (tok === undefined) return null;
  if (/^\d+(?:\.\d+)?$/.test(tok)) return { kind: 'digit', v: parseFloat(tok) };
  let e = NUM_WORDS.get(tok);
  if (!e && inPhrase && tok.length > 3 && tok[0] === 'و') e = NUM_WORDS.get(tok.slice(1));
  if (e) return { kind: e[0], v: e[1] };
  if (AMBIG_NUMS.has(tok) && next) {
    const n = NUM_WORDS.get(next);
    if (n && (n[0] === 'hundred' || n[0] === 'mult')) return { kind: 'abs', v: AMBIG_NUMS.get(tok) };
  }
  return null;
}

/** بيلاقي كل عبارات الأرقام (١٥٠ / مية وخمسين / الف وخمسمية / 2k / اتنين ونص) */
function extractNumbers(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const first = numInfo(tokens[i], tokens[i + 1], false);
    if (!first || (first.kind === 'frac' && !CURRENCY.has(tokens[i + 1]))) { i++; continue; }
    let total = 0; let cur = 0; let j = i; let lastKind = null; let afterConn = false; let lastIdx = -1;
    while (j < tokens.length) {
      const t = tokens[j];
      if (t === 'k' && lastKind === 'digit') { total += cur * 1000; cur = 0; lastKind = 'mult'; lastIdx = j; afterConn = false; j++; continue; }
      const info = numInfo(t, tokens[j + 1], j > i);
      if (!info) {
        if (j > i && (t === 'و' || t === 'and') && lastKind) {
          const nx = numInfo(tokens[j + 1], tokens[j + 2], true);
          if (nx && !(lastKind === 'digit' && nx.kind === 'digit')) { j++; afterConn = true; continue; }
        }
        break;
      }
      const k = info.kind;
      if (k === 'digit') {
        if (j > i && !afterConn) break;
        cur += info.v;
      } else if (k === 'abs') {
        if (lastKind === 'digit' && !afterConn) break;
        cur += info.v;
      } else if (k === 'hundred') {
        if (lastKind === 'digit' && !afterConn) break;
        cur = (cur > 0 && cur < 100) ? cur * 100 : cur + 100;
      } else if (k === 'mult') {
        total += (cur || 1) * info.v; cur = 0;
      } else if (k === 'frac') {
        if (j > i && !(cur >= 1 && cur < 10)) break;
        cur += info.v;
      }
      lastKind = k; lastIdx = j; afterConn = false; j++;
    }
    const value = total + cur;
    if (lastIdx >= i && value > 0) { out.push({ value, start: i, end: lastIdx }); i = lastIdx + 1; } else i++;
  }
  return out;
}

function chooseAmount(tokens, nums) {
  const cand = [];
  for (const n of nums) {
    const next = tokens[n.end + 1];
    const prev = tokens[n.start - 1];
    if (next && QTY_UNITS.has(next)) continue;             // كمية مش مبلغ
    const pri = (next && CURRENCY.has(next)) || (prev && PRE_AMOUNT.has(prev)) || (prev && CURRENCY.has(prev));
    cand.push(Object.assign({ pri: !!pri }, n));
  }
  const pri = cand.filter((c) => c.pri);
  if (pri.length === 1) return pri[0];
  if (pri.length > 1) return { ambiguous: true };
  if (cand.length === 1) return cand[0];
  if (cand.length === 0) return null;
  return { ambiguous: true };
}

/**
 * تقسيم الوحدة (segment) لعدة عمليات لما فيها أكتر من مبلغ.
 * بيشتغل بين كل مبلغين متتاليين ويختار نقطة قص واحدة:
 *  1) رابط صريح (و / وكمان / ثم ...)  -> نقص عنده (آخر رابط بين المبلغين عشان الوصف يفضل مع صاحبه).
 *  2) واو ملزوقة في فعل معروف ("وسلفت" "واستلفت" "واشتريت")، أو فعل جديد من غير رابط -> نقص قبله.
 *  3) مفيش رابط ولا فعل ("قهوة 50 مواصلات 30" أو "50 قهوة 30 مواصلات"):
 *     لو فيه وصف قبل المبلغ الأول فالنمط "وصف مبلغ" -> الكلمات بعد المبلغ تتبع المبلغ التاني،
 *     وإلا النمط "مبلغ وصف" -> الكلمات بعد المبلغ تتبع المبلغ الأول.
 * لو النتيجة مش قطعة-لكل-مبلغ بالظبط نرجع للنص الأصلي (والمصنّف هيحوّله للـ AI بأمان).
 */
function splitByConnectors(tokens, nums, ctx) {
  if (nums.length < 2) return [tokens];
  const toks = tokens.slice();
  const inNum = (idx) => nums.some((n) => idx >= n.start && idx <= n.end);
  const isDesc = (t) => !STOP.has(t) && !CONNECTORS.has(t) && !CURRENCY.has(t) && !DATE_WORDS.has(t) &&
    !QUESTION_WORDS.has(t) && !isIntentToken(ctx, t) && !stripGluedWaw(ctx, t) && !/^\d/.test(t);

  const cuts = []; // { at: index أول توكن في القطعة الجديدة, skip: عدد التوكنز المحذوفة قبله }
  let pieceStart = 0;
  for (let k = 0; k < nums.length - 1; k++) {
    const a = nums[k]; const b = nums[k + 1];
    let cut = null;
    for (let i = a.end + 1; i < b.start; i++) {
      if (inNum(i)) continue;
      const t = toks[i];
      if (CONNECTORS.has(t)) { cut = { at: i + 1, skip: 1 }; }                         // آخر رابط يكسب
      else if (!cut || !CONNECTORS.has(toks[cut.at - 1] || '')) {
        const glued = stripGluedWaw(ctx, t);
        if (glued) { toks[i] = glued; if (!cut) cut = { at: i, skip: 0 }; }
        else if (isIntentToken(ctx, t) && !cut) cut = { at: i, skip: 0 };
      }
    }
    if (!cut) {
      let pos = a.end + 1;
      while (pos < b.start && CURRENCY.has(toks[pos])) pos++;
      const gap = b.start - pos;
      const descBefore = toks.slice(pieceStart, a.start).some(isDesc);
      if (gap <= 0) cut = { at: b.start, skip: 0 };
      else cut = { at: descBefore ? pos : b.start, skip: 0 };
    }
    cuts.push(cut);
    pieceStart = cut.at;
  }

  const pieces = [];
  let from = 0;
  for (const c of cuts) { pieces.push(toks.slice(from, c.at - c.skip)); from = c.at; }
  pieces.push(toks.slice(from));
  const clean = pieces.filter((p) => p.length);
  const good = clean.length === nums.length && clean.every((p) => extractNumbers(p).length === 1);
  return good ? clean : [tokens];
}

// "وسلفت" -> "سلفت" لو الباقي فعل معروف (مش اسم زي "وليد")
function stripGluedWaw(ctx, tok) {
  if (tok.length < 4 || tok[0] !== 'و') return null;
  const rest = tok.slice(1);
  return isIntentToken(ctx, rest) ? rest : null;
}

const DEBT_VERBS = new Set(['سلفت', 'اسلفت', 'اقرضت', 'قرضت', 'استلفت', 'اقترضت', 'استقرضت', 'رجعت', 'ارجعت', 'سددت', 'رديت',
  'lent', 'loaned', 'borrowed', 'عطيت', 'اديت', 'اخدت'].map(nw));
function isIntentToken(ctx, tok) {
  if (DEBT_VERBS.has(tok)) return true;
  if (!ctx) return false;
  // اسم متعلَّم من تاريخ المستخدم (personMap) بيعتبر بداية عملية دين جديدة
  if (ctx.personMap && tok.length >= 3) {
    for (const v of variants(tok)) if (Object.prototype.hasOwnProperty.call(ctx.personMap, v)) return true;
  }
  for (const v of variants(tok)) {
    if (ctx.expenseVerbs.words.has(v) || ctx.incomeVerbs.words.has(v) || ctx.recordVerbs.words.has(v)) return true;
  }
  return false;
}

/**
 * "200g" / "310 g" : لو مفيش منتج بيتوزن بعدها (لحمة/جبنة/رز...) يبقى المقصود "ج" (جنيه) مكتوبة بكيبورد غلط،
 * مش جرام. لو فيه منتج بيتوزن فنسيبها وحدة كمية زي ما هي.
 */
function fixGramAsPound(tokens, ctx) {
  const isWeighed = (t) => {
    for (const v of variants(t)) {
      const hits = ctx.expenseIndex.words.get(v);
      if (hits && hits.some((h) => h.cat === 'grocery' && !h.weak)) return true;
    }
    return false;
  };
  return tokens.map((t, i) => {
    if ((t === 'g' || t === 'gm') && i > 0 && /^\d+(?:\.\d+)?$/.test(tokens[i - 1])) {
      if (isWeighed(tokens[i + 1] || '') || isWeighed(tokens[i + 2] || '') || isWeighed(tokens[i - 2] || '')) return t;
      return 'جنيه';
    }
    return t;
  });
}

/* ============================== ديون ============================== */
const NM = '(\\p{L}{2,})';
const NM3 = '(\\p{L}{2,}(?:\\s+\\p{L}{2,}){0,2})';   // اسم من 1-3 كلمات (بنقلّم الكلمات الزيادة بعدين)
const OPT_L = '(?:ل\\s+|to\\s+)?';
const SKIP = '(?:(?:فلوس|الفلوس|مبلغ|المبلغ|الدين|دين|قسط|القسط)\\s+)?';
const DEBT_RULES = [
  [TYPES.debt_repay_in, [
    `${NM}\\s+(?:رجعلي|رجعلينا|رجعلنا|رجع\\s+لي|رجع\\s+ليا|سددلي|سدد\\s+لي|سدد\\s+ليا|ردلي|رد\\s+لي|رد\\s+ليا|paid\\s+me\\s+back|repaid\\s+me)`,
  ]],
  [TYPES.debt_repay_out, [
    `(?:رجعت|ارجعت|سددت|رديت|repaid|paid\\s+back)\\s+${SKIP}${OPT_L}${NM3}`,
    `paid\\s+${NM}\\s+back`,
  ]],
  [TYPES.debt_lent, [
    `(?:سلفت|اسلفت|اقرضت|قرضت|lent|loaned)\\s+${OPT_L}${NM3}`,
    `(?:لي|ليا)\\s+(?:عنده|عندو|عند)\\s+${NM3}`,
    `${NM}\\s+(?:بقي\\s+)?(?:لي|ليا)\\s+(?:عنده|عندو)`,
    `${NM}\\s+owes\\s+me`,
  ]],
  [TYPES.debt_borrowed, [
    `(?:استلفت|اقترضت|استقرضت|borrowed)\\s+(?:من\\s+|from\\s+)?${NM3}`,
    `عليا\\s+${OPT_L}${NM3}`,
    `علي\\s+ل\\s+${NM3}`,
    `(?:i\\s+)?owe\\s+${NM3}`,
  ]],
].map(([type, arr]) => [type, arr.map((s) => new RegExp(s, 'u'))]);

function cleanName(raw) {
  if (raw.length >= 4 && raw[0] === 'ل' && !LAM_NAMES.has(raw)) return raw.slice(1);
  return raw;
}

function isStrongKeyword(ctx, w) {
  for (const idx of [ctx.expenseIndex, ctx.incomeIndex]) {
    const hits = idx.words.get(w);
    if (hits && hits.some((h) => !h.weak)) return true;
  }
  return false;
}

function isBadName(ctx, raw, cleaned) {
  const bad = (n) => n.length < 2 || BAD_NAMES.has(n) || STOP.has(n) || CURRENCY.has(n) || NUM_WORDS.has(n) ||
    DATE_WORDS.has(n) || isStrongKeyword(ctx, n);
  return bad(raw) || bad(cleaned);
}

function findDebts(ctx, text) {
  const found = [];
  for (const [type, res] of DEBT_RULES) {
    for (const re of res) {
      const m = re.exec(text);
      if (!m) continue;
      // الاسم ممكن يبقى لحد 3 كلمات ("مصطفى احمد")؛ بنشيل الكلمات الزيادة من الآخر (تاريخ/عملة/كلمة مفتاحية...)
      const words = m[1].split(/\s+/).filter(Boolean);
      const first = words[0];
      const firstCleaned = cleanName(first);
      if (isBadName(ctx, first, firstCleaned)) continue;
      const kept = [firstCleaned];
      for (const w of words.slice(1)) { if (isBadName(ctx, w, w)) break; kept.push(w); }
      if (!found.some((f) => f.type === type)) found.push({ type, name: kept.join(' ') });
      break;
    }
  }
  return found;
}

/* ============================== Fuzzy (أخطاء إملائية) ============================== */
// Levenshtein بحد أقصى: بيرجع maxD+1 لو المسافة أكبر (عشان السرعة).
function editDistance(a, b, maxD) {
  if (Math.abs(a.length - b.length) > maxD) return maxD + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxD) return maxD + 1;
    prev = cur;
  }
  return prev[b.length];
}
// الحد المسموح حسب طول الكلمة: قصيرة (<5) ممنوع، 5-7 غلطة واحدة، 8+ غلطتين.
const fuzzyLimit = (len) => (len < 5 ? 0 : len < 8 ? 1 : 2);

/** أقرب كلمة فئة لتوكن فيه غلط إملائي. بيرجع null لو مفيش أو لو فيه تعادل بين فئتين مختلفتين (أمان). */
function fuzzyCategory(index, tok) {
  if (!index.fuzzyKeys) index.fuzzyKeys = Array.from(index.words.keys()).filter((k) => k.length >= 5 && !WEAK.has(k));
  const lim = fuzzyLimit(tok.length);
  if (!lim || /\d/.test(tok) || index.words.has(tok)) return null;
  let best = null; let bestD = lim + 1; let tie = false;
  for (const k of index.fuzzyKeys) {
    if (k[0] !== tok[0]) continue;                     // أول حرف لازم يتطابق (بيقلل false positives جدًا)
    const d = editDistance(tok, k, Math.min(lim, bestD));
    if (d > lim) continue;
    if (d < bestD) { best = k; bestD = d; tie = false; }
    else if (d === bestD && best) {
      const c1 = index.words.get(best).map((h) => h.cat).join();
      const c2 = index.words.get(k).map((h) => h.cat).join();
      if (c1 !== c2) tie = true;
    }
  }
  return best && !tie ? { word: best, dist: bestD } : null;
}

/* ============================== تصنيف الفئة ============================== */
function detectCategory(index, tokens, text, fuzzy) {
  const scores = new Map();
  const seen = new Set();
  const add = (cat, w) => scores.set(cat, (scores.get(cat) || 0) + w);
  for (const t of tokens) {
    for (const v of variants(t)) {
      const hits = index.words.get(v);
      if (!hits || seen.has(v)) continue;
      seen.add(v);
      hits.forEach((h) => add(h.cat, h.weak ? 0.5 : 1));
    }
  }
  for (const p of index.phrases) if (p.re.test(text)) add(p.cat, p.weak ? 0.5 : 1);
  let fuzzyUsed = false;
  // Fuzzy بس لو مفيش ولا تطابق حرفي (عشان ميبوظش حاجة شغالة)، وبوزن أقل => ثقة أقل => "راجع قبل الحفظ" أو AI
  if (!scores.size && fuzzy) {
    for (const t of tokens) {
      if (STOP.has(t) || CURRENCY.has(t) || NUM_WORDS.has(t) || DATE_WORDS.has(t) || QUESTION_WORDS.has(t)) continue;
      const m = fuzzyCategory(index, t);
      if (m) { index.words.get(m.word).forEach((h) => add(h.cat, h.weak ? 0.3 : 0.8)); fuzzyUsed = true; }
    }
  }
  const arr = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  if (!arr.length) return { cat: null, score: 0, second: 0, fuzzy: false };
  return { cat: arr[0][0], score: arr[0][1], second: arr[1] ? arr[1][1] : 0, fuzzy: fuzzyUsed };
}

/* ============================== تحليل وحدة واحدة ============================== */
function analyzeUnit(tokens, ctx, opts, restore) {
  const labels = Object.assign({}, LABELS, opts.labels || {});
  const nums = extractNumbers(tokens);
  const amt = chooseAmount(tokens, nums);
  if (!amt) return { ok: false, reason: 'no-amount', score: 0 };
  if (amt.ambiguous) return { ok: false, reason: 'ambiguous-amount', score: 0 };
  if (!(amt.value > 0) || amt.value > CONFIG.MAX_AMOUNT) return { ok: false, reason: 'bad-amount', score: 0 };

  // العملة
  const codes = tokens.filter((t) => CURRENCY.has(t)).map((t) => CURRENCY.get(t));
  const currency = codes.find((c) => c !== 'EGP') || CONFIG.DEFAULT_CURRENCY;
  if (currency !== 'EGP' && CONFIG.FOREIGN_CURRENCY_TO_AI) return { ok: false, reason: 'foreign-currency', score: 0 };

  // التاريخ
  let dateOffsetDays = 0;
  const drop = new Set();
  for (let i = amt.start; i <= amt.end; i++) drop.add(i);
  tokens.forEach((t, i) => {
    if (CURRENCY.has(t)) drop.add(i);
    if (DATE_WORDS.has(t)) {
      dateOffsetDays = DATE_WORDS.get(t);
      drop.add(i);
      if (t === 'امبارح' && tokens[i - 1] === 'اول') { dateOffsetDays = -2; drop.add(i - 1); }
    }
  });
  const content = tokens.filter((t, i) => !drop.has(i));
  const text = content.join(' ');

  const isQuestion = tokens.some((t) => QUESTION_WORDS.has(t));

  // النية
  const debts = findDebts(ctx, text);
  const expenseVerb = lexMatch(ctx.expenseVerbs, content, text);
  const recordVerb = lexMatch(ctx.recordVerbs, content, text);
  const incomeVerb = lexMatch(ctx.incomeVerbs, content, text);

  // الفئة
  const userMap = opts.userMap || null;
  let userCat = null;
  if (userMap) {
    outer: for (const t of content) for (const v of variants(t)) {
      if (Object.prototype.hasOwnProperty.call(userMap, v)) { userCat = userMap[v]; break outer; }
    }
  }
  const fuzzyOn = opts.fuzzy !== false;
  const catE = detectCategory(ctx.expenseIndex, content, text, fuzzyOn);
  const catI = detectCategory(ctx.incomeIndex, content, text, fuzzyOn);

  // أسماء اتعلمناها من تاريخ المستخدم: "وليد 200" لو وليد كان دائمًا سلفة => دين.
  // شرط الأمان: مفيش فعل مصروف/دخل ولا فئة مفهومة، يعني الاسم هو الإشارة الوحيدة.
  let learned = null;
  const personMap = opts.personMap || null;
  if (personMap && !debts.length && !expenseVerb && !incomeVerb && !catE.score && !catI.score) {
    outerP: for (const t of content) for (const v of variants(t)) {
      if (Object.prototype.hasOwnProperty.call(personMap, v) && /^debt_(lent|borrowed)$/.test(personMap[v])) {
        learned = { type: personMap[v], name: v }; break outerP;
      }
    }
  }
  if (learned) debts.push(learned);

  let type; let counterparty = null;
  if (debts.length) { type = debts[0].type; counterparty = debts[0].name; }
  else if (incomeVerb && !expenseVerb) type = TYPES.income;
  else if (!expenseVerb && !incomeVerb && catI.score > catE.score) type = TYPES.income;
  else type = TYPES.expense;

  const isDebt = type.startsWith('debt_');
  let categoryId = null; let categoryLabel = null; let catPoints = 0; let conflict = false;

  if (!isDebt) {
    if (userCat) { categoryLabel = userCat; catPoints = 30; }
    else if (type === TYPES.income) {
      if (catI.score > 0) { categoryId = catI.cat; catPoints = catI.score >= 1 ? 30 : 15; conflict = catI.second > 0 && catI.second >= catI.score * 0.8; }
      else if (incomeVerb) { categoryId = 'otherIncome'; catPoints = 20; }
    } else if (catE.score > 0) {
      categoryId = catE.cat; catPoints = catE.score >= 1 ? 30 : 15; conflict = catE.second > 0 && catE.second >= catE.score * 0.8;
    }
    if (categoryId) categoryLabel = labels[categoryId] || categoryId;
  }

  // وصف
  const nameWords = counterparty ? counterparty.split(' ') : [];
  const nameTokens = new Set(nameWords.length ? tokens.filter((t) => nameWords.includes(cleanName(t)) || nameWords.includes(t)) : []);
  const descTokens = content.filter((t) => {
    if (STOP.has(t) || QUESTION_WORDS.has(t) || nameTokens.has(t)) return false;
    for (const v of variants(t)) {
      if (ctx.expenseVerbs.words.has(v) || ctx.recordVerbs.words.has(v) || ctx.incomeVerbs.words.has(v)) return false;
    }
    return true;
  });

  // النقاط
  let score = 30;
  const explicitVerb = expenseVerb || incomeVerb || recordVerb;
  let intentPoints = 0;
  if (isDebt) intentPoints = learned ? 40 : 45;   // الاسم المتعلَّم أضعف شوية من فعل صريح (85 => 80 حد أدنى)
  else if (explicitVerb) intentPoints = 25;
  else if (catPoints > 0 && content.length <= 4) intentPoints = 20;
  score += intentPoints + catPoints;
  if (descTokens.length <= 5) score += 10;

  const flags = [];
  const distinctDebtTypes = debts.length;
  if (isQuestion) { score -= 40; flags.push('question-or-query'); }
  if (distinctDebtTypes > 1 || (incomeVerb && expenseVerb) || (debts.length && (incomeVerb || expenseVerb))) {
    score -= 30; flags.push('multiple-intents');
  }
  if (!isDebt && !expenseVerb && !incomeVerb && catE.score > 0 && catI.score > 0 && !userCat) {
    score -= 25; flags.push('ambiguous-direction');
  }
  if (conflict && !userCat) { score -= 25; flags.push('conflicting-categories'); }
  if (catE.fuzzy || catI.fuzzy) flags.push('fuzzy-match');
  if (learned) flags.push('learned-person');
  if (!isDebt && !categoryLabel) flags.push('no-category');
  if (!isDebt && intentPoints === 0) flags.push('no-intent');

  const reason = score >= CONFIG.LOCAL_THRESHOLD ? 'local-ok' : (flags[0] || 'low-score');
  const ok = score >= CONFIG.LOCAL_THRESHOLD;

  const description = descTokens.slice(0, 6).map(restore).join(' ') || (categoryLabel || '');
  const tx = {
    type,
    amount: amt.value,
    currency,
    category: isDebt ? null : categoryLabel,
    categoryId,
    description: isDebt ? '' : description,
    counterparty: counterparty ? counterparty.split(' ').map(restore).join(' ') : null,
    dateOffsetDays,
    confidence: Math.max(0, Math.min(100, score)) / 100,
  };
  return { ok, reason, score, tx, flags };
}

/* ============================== الواجهة الرئيسية ============================== */
/**
 * classifyMessage(message, opts?)
 * opts.userMap  : { [tokenNormalized]: 'اسم الفئة' }  تصحيحات المستخدم (اختياري)
 * opts.labels   : override لأسماء الفئات (اختياري)
 * opts.dialects : ['eg','en','gulf','levant','maghreb'] (اختياري)
 *
 * return { route:'local'|'ai', confidence, reason, transactions:[...], debug:[...] }
 */
// كلام افتتاحي مش جزء من العملية: "بقولك ايه" / "بص" / "اسمع" ... (لازم يتشال قبل فحص الأسئلة)
const PREAMBLE_RE = /^(?:(?:طيب|بص|شوف|اسمع|يعني|ايوه|يلا|استني|معلش)\s+)*(?:بقول\s?لك|بقولك|هقول\s?لك|هقولك|قولك)\s+ايه\s+(?:يا\s+\S+\s+)?/u;
// ترقيم القوائم في أول السطر: "1) " "2- " "3. " (بيتحسب مبلغ لو سبناه)
const LIST_MARKER_RE = /^[ \t]*(?:\d{1,2}|[٠-٩]{1,2})[ \t]*[-–.)][ \t]+(?=\S)/gmu;

function classifyMessage(message, opts) {
  opts = opts || {};
  const original = String(message == null ? '' : message);
  const ctx = opts.personMap ? Object.assign({}, getContext(opts), { personMap: opts.personMap }) : getContext(opts);
  const norm = normalize(original.replace(LIST_MARKER_RE, '')).replace(PREAMBLE_RE, '');
  if (!norm) return { route: 'ai', confidence: 0, reason: 'empty', transactions: [], debug: [] };

  // خريطة لاسترجاع الكتابة الأصلية (همزات/تاء مربوطة) في الوصف والأسماء
  const restoreMap = new Map();
  original.split(/[\s،,;؛+]+/).forEach((w) => {
    const clean = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!clean) return;
    const n = nw(clean);
    if (n && !n.includes(' ') && !restoreMap.has(n)) restoreMap.set(n, clean);
    if (n.length >= 4 && n[0] === 'ل') { const c = n.slice(1); if (!restoreMap.has(c)) restoreMap.set(c, clean.slice(1)); }
  });
  const restore = (t) => restoreMap.get(t) || t;

  const segments = norm.split(/[\n;؛،,+]+/).map((s) => s.trim()).filter(Boolean);
  const units = [];
  for (const seg of segments) {
    const tokens = fixGramAsPound(seg.split(/\s+/).filter(Boolean), ctx);
    const nums = extractNumbers(tokens);
    if (nums.length >= 2) splitByConnectors(tokens, nums, ctx).forEach((p) => units.push(p)); else units.push(tokens);
  }

  const results = units.map((u) => analyzeUnit(u, ctx, opts, restore));
  const debug = results.map((r, i) => ({ text: units[i].join(' '), ok: r.ok, reason: r.reason, score: r.score, flags: r.flags || [] }));
  const failed = results.find((r) => !r.ok);
  const minScore = Math.min.apply(null, results.map((r) => r.score));
  const confidence = Math.max(0, Math.min(100, minScore)) / 100;

  if (failed) {
    // نتيجة جزئية: اللي اتفهم محليًا + النصوص اللي محتاجة AI (المستدعي يقدر يبعت الباقي بس)
    const partial = {
      transactions: results.filter((r) => r.ok).map((r) => r.tx),
      unresolved: results.map((r, i) => (r.ok ? null : units[i].map(restore).join(' '))).filter(Boolean),
    };
    return { route: 'ai', confidence, reason: failed.reason, transactions: [], partial, debug };
  }
  return { route: 'local', confidence, reason: 'local-ok', transactions: results.map((r) => r.tx), debug };
}

/* ============================== تعلّم من تصحيحات المستخدم ============================== */
const canon = (t) => (t.startsWith('ال') && t.length > 4 ? t.slice(2) : t);

/** لما المستخدم يصحح فئة عملية: رجّع الكلمات اللي تتحفظ (token -> category) */
function learnEntries(description, category) {
  const seen = new Set();
  return normalize(description).split(/\s+/).filter(Boolean)
    .filter((t) => t.length >= 3 && !/^\d/.test(t) && !STOP.has(t) && !CURRENCY.has(t))
    .map(canon)
    .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
    .map((token) => ({ token, category }));
}

/** rows من الداتابيز [{token, category}] -> object جاهز لـ opts.userMap */
function buildUserMap(rows) {
  const m = {};
  (rows || []).forEach((r) => { m[r.token] = r.category; });
  return m;
}

/** لما المستخدم يأكد عملية دين: رجّع الاسم اللي يتحفظ (token -> 'debt_lent' | 'debt_borrowed') */
function learnPerson(type, name) {
  if (type !== 'debt_lent' && type !== 'debt_borrowed') return null;
  const token = nw(String(name || '')).split(/\s+/)[0];
  return token && token.length >= 2 ? { token: canon(token), type } : null;
}
/** rows من الداتابيز [{token, type}] -> object جاهز لـ opts.personMap */
function buildPersonMap(rows) {
  const m = {};
  (rows || []).forEach((r) => { if (r && r.token && r.type) m[r.token] = r.type; });
  return m;
}

export { classifyMessage, learnEntries, buildUserMap, learnPerson, buildPersonMap, editDistance, normalize, extractNumbers, CONFIG, LABELS, TYPES, LAYERS };
