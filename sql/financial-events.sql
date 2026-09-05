-- سجل مالي عام للعبارات الطبيعية التي ليست مصروفًا أو دينًا تقليديًا فقط.
-- شغّله في Supabase SQL Editor مرة واحدة قبل تفعيل التسجيل الموسّع.
create table if not exists financial_events (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  -- ملحوظة: لو الجدول اتعمل قبل كده بقيود قديمة، شغّل السطرين دول مرة واحدة قبل الإدراج:
--   alter table financial_events drop constraint if exists financial_events_event_type_check;
--   alter table financial_events add constraint financial_events_event_type_check
--     check (event_type in ('income','purchase','asset','transfer','withdrawal','deposit','refund','subscription','other'));
  event_type text not null check (event_type in ('income', 'purchase', 'asset', 'transfer', 'withdrawal', 'deposit', 'refund', 'subscription', 'other')),
  amount numeric not null check (amount > 0),
  currency_code text not null default 'EGP' check (currency_code ~ '^[A-Z]{3}$'),
  category text,
  description text not null default '',
  raw_text text not null default '',
  direction text not null default 'neutral' check (direction in ('inflow', 'outflow', 'neutral')),
  -- لو الحركة غامضة (تحويل لشخص/من شخص من غير سياق تجاري واضح) بتتسجل هنا مؤقتًا بعلامة "تحتاج مراجعة"
  -- لحد ما المستخدم يحدد يدويًا هل هي دين، دخل، مصروف، أو فعلًا حركة بنكية محايدة.
  needs_review boolean not null default false,
  counterparty text default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table financial_events add column if not exists needs_review boolean not null default false;
alter table financial_events add column if not exists counterparty text default '';

create index if not exists idx_financial_events_user_review
  on financial_events (telegram_user_id, needs_review) where needs_review = true;

create index if not exists idx_financial_events_user_date
  on financial_events (telegram_user_id, created_at desc);

create index if not exists idx_financial_events_user_type
  on financial_events (telegram_user_id, event_type);

create index if not exists idx_financial_events_user_currency_date
  on financial_events (telegram_user_id, currency_code, created_at desc);

-- تفعيل RLS مع سياسات الخدمة الخلفية فقط؛ الـAPI يستخدم service role ولا يعرّض الجدول مباشرة للمتصفح.
alter table financial_events enable row level security;
