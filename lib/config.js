// بنضبط توقيت السيرفر على توقيت القاهرة، عشان حسابات "بداية اليوم" و"بداية الشهر"
// (في التقارير والكرون اليومي) تتحسب صح حتى لو Vercel شغّالة بتوقيت UTC افتراضيًا.
// لو حبيت تغيّره لاحقًا، ضيف TZ في Environment Variables على Vercel وهياخد الأولوية.
process.env.TZ = process.env.TZ || 'Africa/Cairo';

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const GROQ_API_KEY = process.env.GROQ_API_KEY;
// الموديل الأساسي (رخيص وسريع) بيتصنّف بيه كل رسالة (نص أو صوت) بشكل افتراضي — كافي جدًا
// لمهمة استخراج JSON بسيط من جملة قصيرة، وتكلفته أقل بحوالي 12 ضعف من llama-3.3-70b.
export const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'llama-3.1-8b-instant';
// موديل احتياطي (fallback) أقوى وأدق — بينادى تلقائيًا بس لما الموديل الأساسي يرجّع نتيجة
// غامضة (unknown) أو غير مكتملة، عشان نحافظ على نفس مستوى الدقة في الحالات الصعبة
// (لهجة غير واضحة، جملة معقدة فيها أكتر من معاملة، إلخ) من غير ما ندفع تكلفته في كل رسالة.
export const GROQ_TEXT_MODEL_FALLBACK = process.env.GROQ_TEXT_MODEL_FALLBACK || 'llama-3.3-70b-versatile';
// ============ اختيار مزوّد التفريغ الصوتي (ASR) — قابل للتبديل من غير تعديل كود ============
// دلوقتي المزوّد الوحيد المتاح فعليًا هو 'whisper' (Groq Whisper large-v3، شوف lib/groq.js).
// 'qwen_cleo' (QwenCleo-ASR، موديل مفتوح المصدر متخصص في العامية المصرية) مش مفعّل لسه —
// محتاج استضافة GPU منفصلة (مش نداء API جاهز زي Groq)، فلو اتحطت هنا من غير ما يكون فيه
// implementation فعلي، الكود بيرجع تلقائيًا لـ whisper (شوف transcribeAudioBuffer).
// لما تجهّز الاستضافة، هنضيف provider فعلي هنا ونفعّله بالـ env var ده بس من غير تعديلات تانية.
export const ASR_PROVIDER = process.env.ASR_PROVIDER || 'whisper'; // 'whisper' | 'qwen_cleo' (لسه مش مفعّل)
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// الـ anon/publishable key بتاع نفس مشروع Supabase — مستخدم في api/auth-by-code.js عشان يحوّل
// magic-link مولّد بالـ service role لجلسة (access_token/refresh_token) فعلية للمتصفح.
// لازم يكون نفس القيمة المستخدمة في public/app/dabbar-onboarding.html و dabbar-dashboard-full.html.
export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || 'sb_publishable_yHiX1cnEMCVEcjQxiIrqig_DRBiuveQ';
// اختياري: سر التحقق من إن الطلب جاي فعليًا من تليجرام (مش من أي حد عارف رابط الويب هوك).
// لو ضفته في Vercel، لازم تظبطه بالظبط بنفس القيمة في secret_token لما تعمل setWebhook (شوف README).
export const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
// اختياري: بيتفعّل تلقائيًا لو ضفت CRON_SECRET في Vercel، وبيستخدم لتأمين الـ cron endpoints
export const CRON_SECRET = process.env.CRON_SECRET;

// ============ الاشتراك المدفوع (إنستا باي يدوي) ============
// الـ Telegram user id بتاعك إنت (الأدمن) — البوت بيسمحلك بس بأوامر التفعيل لو الرسالة جاية من الـ id ده.
// عشان تعرف الـ id بتاعك: ابعت أي رسالة لبوت @userinfobot على تليجرام.
export const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;

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

// لو عدد التسجيلات الصوتية لمستخدم واحد أكتر من الرقم ده في نفس اليوم، بنرفض التسجيلات الزيادة
// (بيرجع للمستخدم رسالة لطيفة إنه وصل الحد ده، مش رسالة "ممنوع"). الرقم ده أكتر بكتير من أي
// استخدام حقيقي (حتى مستخدم نشيط بيسجل كل مصروف بالصوت مش هيقرب منه في يوم عادي)، وفي نفس الوقت
// بيحمي هامش الربح في اشتراك 150 ج/شهر من حالات الاستهلاك الشاذ (abuse) اللي تكلّفنا فلوس Groq.
// ---- نزل من 80 لـ40 ----
// بحد أقصى 45 ثانية للتسجيل الواحد، 80/يوم كانت بتسمح بأسوأ حالة (استهلاك كامل كل يوم في
// الشهر) تاكل هامش الربح كله وتعدي سعر الاشتراك نفسه حتى مع whisper-large-v3-turbo. 40/يوم
// (~1200/شهر) لسه أكتر من 13 ضعف أي استخدام حقيقي (يعني رسالة صوتية كل ~24 دقيقة طول اليوم)،
// وبيسيب هامش ربح فعلي حتى في أسوأ سيناريو نظري.
export const DAILY_VOICE_LIMIT = Number(process.env.DAILY_VOICE_LIMIT || 40);

// نفس فكرة DAILY_VOICE_LIMIT بالظبط، بس لرسايل النص. لحد النهاردة مكانش فيه أي سقف على الرسايل
// النصية رغم إن كل رسالة بتكلّف مكالمة Groq زي الصوت بالظبط — ده كان بيسيب الباب مفتوح لاستهلاك
// غير محدود (بوت سبام أو استخدام غير طبيعي) من غير أي حماية لهامش الربح. الرقم ده أكبر بكتير من
// أي استخدام حقيقي (110 رسالة/يوم يعني تقريبًا رسالة كل 8 دقايق طول اليوم)، فمحدش هيحس بيه أبدًا،
// وفي نفس الوقت بيحمي التكلفة من أي حالة شاذة.
export const DAILY_TEXT_LIMIT = Number(process.env.DAILY_TEXT_LIMIT || 110);

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
