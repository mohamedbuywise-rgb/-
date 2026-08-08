-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ده migration جديد يضيف ربط حساب الموقع (Supabase Auth) بحساب تليجرام بتاع نفس المستخدم.
-- من غير الربط ده، الداشبورد مش هيعرف يجيب بيانات المستخدم الصح من جدول expenses/debts.

-- ============ أكواد الربط المؤقتة (تتولد من /link في البوت، صالحة 10 دقايق) ============
create table if not exists link_codes (
  code text primary key,
  telegram_user_id bigint not null,
  chat_id bigint not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

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
