// بنضبط توقيت السيرفر على توقيت القاهرة، عشان حسابات "بداية اليوم" و"بداية الشهر"
// (في التقارير والكرون اليومي) تتحسب صح حتى لو Vercel شغّالة بتوقيت UTC افتراضيًا.
// لو حبيت تغيّره لاحقًا، ضيف TZ في Environment Variables على Vercel وهياخد الأولوية.
process.env.TZ = process.env.TZ || 'Africa/Cairo';

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const GROQ_API_KEY = process.env.GROQ_API_KEY;
export const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile';
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// اختياري: بيتفعّل تلقائيًا لو ضفت CRON_SECRET في Vercel، وبيستخدم لتأمين الـ cron endpoints
export const CRON_SECRET = process.env.CRON_SECRET;

// ============ الاشتراك المدفوع (إنستا باي يدوي) ============
// الـ Telegram user id بتاعك إنت (الأدمن) — البوت بيسمحلك بس بأوامر التفعيل لو الرسالة جاية من الـ id ده.
// عشان تعرف الـ id بتاعك: ابعت أي رسالة لبوت @userinfobot على تليجرام.
export const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;

// مدة الاشتراك الافتراضية بعد كل تفعيل (بالأيام)
export const SUBSCRIPTION_DAYS = Number(process.env.SUBSCRIPTION_DAYS || 30);

// السعر ورابط الإنستا باي ويوزر الأدمن — بيتعرضوا للمستخدم لما يحاول يستخدم البوت من غير اشتراك فعّال
export const SUBSCRIPTION_PRICE_EGP = process.env.SUBSCRIPTION_PRICE_EGP || '99';
export const INSTAPAY_LINK = process.env.INSTAPAY_LINK || '01025204455';
export const ADMIN_CONTACT_USERNAME = process.env.ADMIN_CONTACT_USERNAME || '@YourAdminUsername';

// رابط صفحة دليل الاستخدام (Telegram Mini App) — بيتحدد أوتوماتيك من دومين Vercel،
// أو تقدر تحطه يدوي في GUIDE_URL لو عندك دومين مخصص
export const GUIDE_URL =
  process.env.GUIDE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/guide.html` : null);

export const CATEGORIES = ['أكل', 'مواصلات', 'فواتير', 'تسوق', 'ترفيه', 'صحة', 'أخرى'];

export const CATEGORY_EMOJI = {
  'أكل': '🍔',
  'مواصلات': '🚕',
  'فواتير': '🧾',
  'تسوق': '🛍️',
  'ترفيه': '🎬',
  'صحة': '💊',
  'أخرى': '📌',
};

export const CATEGORY_COLOR = {
  'أكل': '#FF6B6B',
  'مواصلات': '#4ECDC4',
  'فواتير': '#FFD166',
  'تسوق': '#A78BFA',
  'ترفيه': '#F472B6',
  'صحة': '#34D399',
  'أخرى': '#94A3B8',
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
