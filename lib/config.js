// بنضبط توقيت السيرفر على توقيت القاهرة، عشان حسابات "بداية اليوم" و"بداية الشهر"
// (في التقارير والكرون اليومي) تتحسب صح حتى لو Vercel شغّالة بتوقيت UTC افتراضيًا.
// لو حبيت تغيّره لاحقًا، ضيف TZ في Environment Variables على Vercel وهياخد الأولوية.
process.env.TZ = process.env.TZ || 'Africa/Cairo';

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const GROQ_API_KEY = process.env.GROQ_API_KEY;
// اعتماد كامل على أسرع وأرخص موديل نصوص عند Groq (llama-3.1-8b-instant) لكل معالجة النصوص/الشات/التصنيف،
// عشان نفضل جوه ميزانية الاستضافة الشهرية. لو حابب تغيّره لاحقًا حط GROQ_TEXT_MODEL في Environment Variables.
export const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'llama-3.1-8b-instant';
// موديل الرؤية (Vision) — بيستخدم لقراءة صور الفواتير/الإيصالات في ميزة "امسح فاتورة".
// لو Groq غيّر اسم الموديل الحالي، دور في console.groq.com/docs/models على أحدث موديل يدعم الصور وحطه في GROQ_VISION_MODEL.
export const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// ملحوظة: القيمة دي مش مستخدمة فعليًا في أي API endpoint دلوقتي (auth-by-code.js بيشتغل بس
// بالـ Bearer token اللي المتصفح بيبعته، مش بمفتاح تاني). سايبينها هنا لأنها نفس القيمة
// المستخدمة في public/app/dabbar-onboarding.html و dabbar-dashboard-full.html، لو احتجتها
// لاحقًا في endpoint سيرفر-سايد جديد.
export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || 'sb_publishable_yHiX1cnEMCVEcjQxiIrqig_DRBiuveQ';
// اختياري: بيتفعّل تلقائيًا لو ضفت CRON_SECRET في Vercel، وبيستخدم لتأمين الـ cron endpoints
export const CRON_SECRET = process.env.CRON_SECRET;

// ============ الاشتراك المدفوع (إنستا باي يدوي) ============
// الـ Telegram user id بتاعك إنت (الأدمن) — البوت بيسمحلك بس بأوامر التفعيل لو الرسالة جاية من الـ id ده.
// عشان تعرف الـ id بتاعك: ابعت أي رسالة لبوت @userinfobot على تليجرام.
export const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;

// باسورد صفحة إحصائيات الأدمن (public/app/admin-stats.html) — مفيش حساب إيميل خالص هنا،
// الصفحة بتطلب الباسورد ده بس وبتقارنه بالسيرفر. لازم تحطه في Vercel Environment Variables.
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// مدة الاشتراك الافتراضية بعد كل تفعيل (بالأيام)
export const SUBSCRIPTION_DAYS = Number(process.env.SUBSCRIPTION_DAYS || 30);

// مدة التجربة المجانية للمستخدم الجديد (بالأيام) — بتتحسب من أول رسالة يبعتها للبوت
export const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 3);

// السعر ورابط الإنستا باي ويوزر الأدمن — بيتعرضوا للمستخدم لما يحاول يستخدم البوت من غير اشتراك فعّال
export const SUBSCRIPTION_PRICE_EGP = process.env.SUBSCRIPTION_PRICE_EGP || '150';
export const INSTAPAY_LINK = process.env.INSTAPAY_LINK || '01025204455';
export const ADMIN_CONTACT_USERNAME = process.env.ADMIN_CONTACT_USERNAME || '@YourAdminUsername';

// رابط صفحة دليل الاستخدام (Telegram Mini App) — بيتحدد أوتوماتيك من دومين Vercel،
// أو تقدر تحطه يدوي في GUIDE_URL لو عندك دومين مخصص
export const GUIDE_URL =
  process.env.GUIDE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/guide.html` : null);

// ملحوظة: مفيش فئة "أخرى" ولا أي فئة عامة/فضفاضة عمدًا. الـ prompt في groq.js بيتطلب من الموديل
// دايمًا يختار أقرب فئة من القائمة دي، حتى لو مش مضبوطة 100%، عشان التقارير تفضل مفيدة.
export const CATEGORIES = [
  'أكل', 'مواصلات', 'فواتير', 'تسوق', 'ترفيه', 'صحة',
  'تعليم', 'منزل وأثاث', 'ملابس', 'اشتراكات', 'هدايا وتبرعات', 'شخصي وعناية',
];

export const CATEGORY_EMOJI = {
  'أكل': '🍔',
  'مواصلات': '🚕',
  'فواتير': '🧾',
  'تسوق': '🛍️',
  'ترفيه': '🎬',
  'صحة': '💊',
  'تعليم': '📚',
  'منزل وأثاث': '🏠',
  'ملابس': '👕',
  'اشتراكات': '🔁',
  'هدايا وتبرعات': '🎁',
  'شخصي وعناية': '🧴',
};

export const CATEGORY_COLOR = {
  'أكل': '#FF6B6B',
  'مواصلات': '#4ECDC4',
  'فواتير': '#FFD166',
  'تسوق': '#A78BFA',
  'ترفيه': '#F472B6',
  'صحة': '#34D399',
  'تعليم': '#60A5FA',
  'منزل وأثاث': '#F59E0B',
  'ملابس': '#EC4899',
  'اشتراكات': '#818CF8',
  'هدايا وتبرعات': '#FB923C',
  'شخصي وعناية': '#2DD4BF',
};

export const MONTH_NAMES = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

// دين يعتبر "قديم" لو من غير تسوية وعدّى عليه الفترة دي (باليوم)
export const OLD_DEBT_REMINDER_DAYS = 30;

// بعد ما نبعت تذكير عن دين قديم، منكررهوش قبل ما تعدي الفترة دي (باليوم)
export const OLD_DEBT_REMINDER_COOLDOWN_DAYS = 7;

// لو عدد المعاملات مع شخص معيّن أكتر من الرقم ده، "ديون [اسم]" هتبعت كشف حساب PDF منسّق
// بدل ما تكتب كل العمليات كرسايل نصوص طويلة (تبقى صعبة القراءة بعد عدد معيّن)
export const DEBT_STATEMENT_PDF_THRESHOLD = 5;

// ============ حدود الاستهلاك (Rate Limiting) — عشان نضمن التكلفة الشهرية تحت السقف المطلوب ============
// المشترك المدفوع: الحدود دي بترجع لصفر لوحدها أول كل شهر ميلادي (مفيش حاجة بتتصفر يدوي، كل شهر بيبقى
// "دور" جديد في usage_counters تلقائيًا). التجربة المجانية: الحدود دي إجمالية على الثلاث أيام كلها، مش شهرية.
// الفويس بيتعامل في الواجهة كـ"Unlimited" (مفيش عداد ظاهر للمستخدم في أي حالة)، أما OCR والشات
// فبيظهرلهم عداد صغير للمشترك بس (مش في التجربة، عشان التجربة تحس إنها Unlimited بالكامل).
export const USAGE_LIMITS = {
  paid: { voice: 250, ocr: 50, chat: 180 },
  trial: { voice: 60, ocr: 30, chat: 50 },
};

// أقصى مدة لفويس نوت واحد (بالثواني) — أي فويس أطول من كده بنطلب من المستخدم يبعته أقصر
// (تكلفة تفريغ الصوت عند Groq بتتحسب على مدة الصوت، فتحديد المدة بيحمي الميزانية الشهرية).
export const VOICE_MAX_DURATION_SECONDS = 30;
