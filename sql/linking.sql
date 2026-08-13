-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ده migration جديد يضيف ربط حساب الموقع (Supabase Auth) بحساب تليجرام بتاع نفس المستخدم.
-- من غير الربط ده، الداشبورد مش هيعرف يجيب بيانات المستخدم الصح من جدول expenses/debts.
--
-- ملحوظة مهمة (بعد تبسيط الـ onboarding لـ3 شاشات): دلوقتي مفيش فورم إيميل/باسورد منفصل خالص.
-- المستخدم بيكتب كود الربط بس، والسيرفر (api/auth-by-code.js) هو اللي بيعمل حساب Supabase Auth
-- تلقائي أول مرة (بإيميل صناعي مبني على telegram_user_id) ويربطه على طول — ده معناه إن الـ auth
-- بقى معتمد على تليجرام بالكامل، مش على إيميل/باسورد حقيقيين بيدخلهم المستخدم بنفسه.

-- ============ أكواد الربط المؤقتة (تتولد من /link في البوت، صالحة 10 دقايق) ============
create table if not exists link_codes (
  code text primary key,
  telegram_user_id bigint not null,
  chat_id bigint not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now(),
  -- الاسم الأول بتاع المستخدم في تليجرام، بنحفظه هنا عشان نستخدمه كاسم افتراضي
  -- لما نعمل حساب جديد تلقائي من شاشة الربط (من غير ما نطلب منه يكتب اسمه في فورم منفصل)
  telegram_first_name text
);

-- آمن يتشغّل تاني حتى لو الجدول كان موجود قبل الإضافة دي
alter table link_codes add column if not exists telegram_first_name text;

create index if not exists idx_link_codes_telegram
  on link_codes (telegram_user_id);

-- ============ الربط النهائي: حساب موقع واحد (auth.users) <-> حساب تليجرام واحد ============
create table if not exists user_links (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  telegram_user_id bigint not null unique,
  linked_at timestamptz not null default now()
);

-- ملحوظة أمان مهمة: الجدولين دول بيتقروا/يتكتبوا بس من الـ API endpoints في السيرفر
-- (باستخدام SUPABASE_SERVICE_ROLE_KEY)، مش من المتصفح مباشرة. فمفيش داعي لـ RLS policies
-- عامة هنا طالما الـ anon key مش بيلمسهم أبدًا. لو حبيت تفتحهم للقراءة من المتصفح لاحقًا
-- (باستخدام anon key)، لازم تفعّل RLS وتحط policy بـ auth.uid() = auth_user_id.
