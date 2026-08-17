// بنضبط توقيت السيرفر على توقيت القاهرة، عشان حسابات "بداية اليوم" و"بداية الشهر"
// (في التقارير والكرون اليومي) تتحسب صح حتى لو Vercel شغّالة بتوقيت UTC افتراضيًا.
// لو حبيت تغيّره لاحقًا، ضيف TZ في Environment Variables على Vercel وهياخد الأولوية.
process.env.TZ = process.env.TZ || 'Africa/Cairo';

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const GROQ_API_KEY = process.env.GROQ_API_KEY;

// موديل النصوص — محدث ومضبوط على openai/gpt-oss-20b لتجنب أخطاء النماذج القديمة
export const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-20b';

// موديل الرؤية (Vision) — بيستخدم لقراءة صور الفواتير/الإيصالات في ميزة "امسح فاتورة".
export const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';

// تاريخ آخر مرة اتأكدنا فيها يدويًا إن الموديلين فوق (نص + فيجن) لسه متاحين عند Groq
export const MODELS_LAST_VERIFIED = '2026-08-17';

const MODEL_CHECK_INTERVAL_DAYS = 60;

export function isModelsCheckOverdue() {
  const daysSince = (Date.now() - new Date(MODELS_LAST_VERIFIED).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > MODEL_CHECK_INTERVAL_DAYS;
}

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || 'sb_publishable_yHiX1cnEMCVEcjQxiIrqig_DRBiuveQ';

export const CRON_SECRET = process.env.CRON_SECRET;
export const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
export const SETUP_SECRET = process.env.SETUP_SECRET;

export const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export const SUBSCRIPTION_DAYS = Number(process.env.SUBSCRIPTION_DAYS || 30);
export const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 3);

export const SUBSCRIPTION_PRICE_EGP = process.env.SUBSCRIPTION_PRICE_EGP || '150';
export const INSTAPAY_LINK = process.env.INSTAPAY_LINK || '01025204455';
export const ADMIN_CONTACT_USERNAME = process.env.ADMIN_CONTACT_USERNAME || '@YourAdminUsername';

export const GUIDE_URL =
  process.env.GUIDE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/guide.html` : null);

export const TRIAL_SUMMARY_BASE_URL =
  process.env.TRIAL_SUMMARY_BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/app/dabbar-trial-summary.html` : null);

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

export const OLD_DEBT_REMINDER_DAYS = 30;
export const OLD_DEBT_REMINDER_COOLDOWN_DAYS = 7;
export const DEBT_STATEMENT_PDF_THRESHOLD = 5;

export const USAGE_LIMITS = {
  paid: { voice: 250, ocr: 50, chat: 180 },
  trial: { voice: 60, ocr: 30, chat: 50 },
};

export const VOICE_MAX_DURATION_SECONDS = 30;
