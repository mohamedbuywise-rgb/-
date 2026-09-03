-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run

create table if not exists expenses (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  amount numeric not null,
  category text not null,
  description text,
  created_at timestamptz not null default now()
);

-- index يسرّع استعلامات التقارير (فلترة حسب المستخدم والتاريخ)
create index if not exists idx_expenses_user_date
  on expenses (telegram_user_id, created_at desc);

-- جدول الديون/السلف بين المستخدم والناس
create table if not exists debts (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  person_name text not null,
  amount numeric not null,
  direction text not null check (direction in ('lent', 'borrowed')),
  note text,
  created_at timestamptz not null default now()
);

-- index يسرّع تجميع الديون حسب المستخدم
create index if not exists idx_debts_user
  on debts (telegram_user_id, person_name);

-- عمود "مرتجع": بيفرّق بين دين جديد وبين سداد (كلي أو جزئي) لدين موجود.
-- مبيأثرش على حساب الصافي (لسه بيتحسب من direction زي ما هو)، بس بيغيّر الصياغة اللي المستخدم بيشوفها
-- (مثلاً "محمد رجّعلك 500 جنيه" بدل "استلفت 500 جنيه من محمد").
alter table debts add column if not exists is_repayment boolean not null default false;

-- جدول تسويات الديون: كل صف بيمثل لحظة "خلصنا الحساب" مع شخص معيّن.
-- بيتحسب صافي الرصيد بعد كده من العمليات اللي بعد آخر تسوية بس (من غير ما نمسح التاريخ القديم).
create table if not exists debt_settlements (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  person_name text not null,
  settled_at timestamptz not null default now()
);

create index if not exists idx_settlements_user
  on debt_settlements (telegram_user_id, person_name);

-- جدول المستخدمين: بيتسجل تلقائيًا مع أول رسالة، وبيستخدم عشان:
-- (1) نعرف الـ chat_id بتاع كل مستخدم لنبعتله تقارير/تذكيرات تلقائية من الـ cron jobs
-- (2) is_premium: عمود قديم مش مستخدم دلوقتي (الاشتراك بقى بيتحسب من subscription_expires_at تحت)
-- (3) is_active: بيتطفى تلقائي لو المستخدم عمل Block للبوت (عشان الكرون يبطّل يحاول يبعتله)، وبيرجع true لو كتب تاني
create table if not exists users (
  telegram_user_id bigint primary key,
  chat_id bigint not null,
  is_premium boolean not null default false,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- السطرين دول آمنين يتشغلوا في أي وقت (بيتخطوا لو العمود موجود أصلاً):
-- تاريخ/وقت انتهاء الاشتراك الحالي. NULL يعني المستخدم لسه ماشتركش أبدًا (متقفل عليه البوت بالكامل).
-- لو موجود القيمة وأكبر من دلوقتي، يبقى الاشتراك فعّال.
alter table users add column if not exists subscription_expires_at timestamptz;
alter table users add column if not exists is_active boolean not null default true;
-- عمود بداية التجربة المجانية: كان بيتقرا في lib/users.js من غير ما يتعرّف هنا أبدًا (باج قديم) —
-- default now() يضمن إن أي مستخدم موجود بالفعل قبل الـ migration ده تتحسبله التجربة من لحظة تشغيل السكريبت،
-- وأي مستخدم جديد بعد كده هياخد الوقت الحقيقي بتاع أول upsert (Supabase بيحط القيمة تلقائي وقت الـ insert).
alter table users add column if not exists trial_started_at timestamptz not null default now();

-- جدول تتبع آخر تذكير اتبعت عن ديون قديمة لكل شخص، عشان منزنقش المستخدم بنفس التذكير كل يوم
create table if not exists debt_reminders (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  person_name text not null,
  last_reminded_at timestamptz not null default now()
);

create unique index if not exists idx_debt_reminders_user_person
  on debt_reminders (telegram_user_id, person_name);

-- جدول "حجز" تنفيذ الكرون: بيمنع تكرار إرسال نفس التقرير لنفس المستخدم لو الكرون اشتغل مرتين
-- لنفس اليوم/الأسبوع/الشهر (بسبب retry من Vercel أو تشغيل يدوي بالغلط)
create table if not exists cron_runs (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  report_type text not null, -- 'daily' | 'weekly' | 'monthly'
  period_key text not null,  -- مثلاً '2026-08-07' لليومي، '2026-08' للشهري
  sent_at timestamptz not null default now()
);

create unique index if not exists idx_cron_runs_unique
  on cron_runs (telegram_user_id, report_type, period_key);

-- يعتمد التسجيل اليدوي على العملة، ويعتمد تسجيل الدخل/الحركات على financial_events.
-- للتحديث الآمن لقاعدة قائمة شغّل sql/financial-recording-repair.sql.
alter table if exists expenses add column if not exists currency_code text not null default 'EGP';
alter table if exists expenses add column if not exists source text;
alter table if exists expenses add column if not exists source_bank_key text;
alter table if exists expenses add column if not exists source_bank_label text;
alter table if exists expenses add column if not exists source_bank_sender text;
alter table if exists debts add column if not exists currency_code text not null default 'EGP';

create table if not exists financial_events (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  event_type text not null check (event_type in ('income','purchase','asset','transfer','withdrawal','deposit','refund','subscription','other')),
  amount numeric not null check (amount > 0),
  currency_code text not null default 'EGP' check (currency_code ~ '^[A-Z]{3}$'),
  category text,
  description text not null default '',
  raw_text text not null default '',
  direction text not null default 'neutral' check (direction in ('inflow','outflow','neutral')),
  needs_review boolean not null default false,
  counterparty text default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_financial_events_user_date
  on financial_events (telegram_user_id, created_at desc);
create index if not exists idx_financial_events_user_type
  on financial_events (telegram_user_id, event_type);
