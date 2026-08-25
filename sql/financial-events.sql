-- سجل مالي عام للعبارات الطبيعية التي ليست مصروفًا أو دينًا تقليديًا فقط.
-- شغّله في Supabase SQL Editor مرة واحدة قبل تفعيل التسجيل الموسّع.
create table if not exists financial_events (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  event_type text not null check (event_type in ('income', 'purchase', 'asset', 'transfer', 'refund', 'subscription', 'other')),
  amount numeric not null check (amount > 0),
  currency_code text not null default 'EGP' check (currency_code ~ '^[A-Z]{3}$'),
  category text,
  description text not null default '',
  raw_text text not null default '',
  direction text not null default 'neutral' check (direction in ('inflow', 'outflow', 'neutral')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_financial_events_user_date
  on financial_events (telegram_user_id, created_at desc);

create index if not exists idx_financial_events_user_type
  on financial_events (telegram_user_id, event_type);

create index if not exists idx_financial_events_user_currency_date
  on financial_events (telegram_user_id, currency_code, created_at desc);

-- تفعيل RLS مع سياسات الخدمة الخلفية فقط؛ الـAPI يستخدم service role ولا يعرّض الجدول مباشرة للمتصفح.
alter table financial_events enable row level security;
