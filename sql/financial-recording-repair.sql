-- إصلاح حفظ العمليات المالية: شغّل هذا الملف مرة واحدة في Supabase SQL Editor.
-- كل الأوامر idempotent ويمكن تشغيلها بأمان على قاعدة قائمة.

alter table if exists expenses
  add column if not exists currency_code text not null default 'EGP';
alter table if exists expenses add column if not exists source text;
alter table if exists expenses add column if not exists source_bank_key text;
alter table if exists expenses add column if not exists source_bank_label text;
alter table if exists expenses add column if not exists source_bank_sender text;

alter table if exists debts
  add column if not exists currency_code text not null default 'EGP';

create table if not exists financial_events (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  event_type text not null,
  amount numeric not null check (amount > 0),
  currency_code text not null default 'EGP',
  category text,
  description text not null default '',
  raw_text text not null default '',
  direction text not null default 'neutral',
  needs_review boolean not null default false,
  counterparty text default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table if exists financial_events add column if not exists event_type text;
alter table if exists financial_events add column if not exists amount numeric;
alter table if exists financial_events add column if not exists currency_code text not null default 'EGP';
alter table if exists financial_events add column if not exists category text;
alter table if exists financial_events add column if not exists description text not null default '';
alter table if exists financial_events add column if not exists raw_text text not null default '';
alter table if exists financial_events add column if not exists direction text not null default 'neutral';
alter table if exists financial_events add column if not exists needs_review boolean not null default false;
alter table if exists financial_events add column if not exists counterparty text default '';
alter table if exists financial_events add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table if exists financial_events add column if not exists created_at timestamptz not null default now();

update expenses set currency_code = 'EGP' where currency_code is null or currency_code = '';
update debts set currency_code = 'EGP' where currency_code is null or currency_code = '';
update financial_events set currency_code = 'EGP' where currency_code is null or currency_code = '';

alter table if exists financial_events
  drop constraint if exists financial_events_event_type_check;
alter table if exists financial_events
  add constraint financial_events_event_type_check
  check (event_type in ('income','purchase','asset','transfer','withdrawal','deposit','refund','subscription','other'));

alter table if exists financial_events
  drop constraint if exists financial_events_currency_code_format;
alter table if exists financial_events
  add constraint financial_events_currency_code_format
  check (currency_code ~ '^[A-Z]{3}$');

alter table if exists financial_events
  drop constraint if exists financial_events_direction_check;
alter table if exists financial_events
  add constraint financial_events_direction_check
  check (direction in ('inflow','outflow','neutral'));

create index if not exists idx_expenses_user_currency_date
  on expenses (telegram_user_id, currency_code, created_at desc);
create index if not exists idx_debts_user_currency_date
  on debts (telegram_user_id, currency_code, created_at desc);
create index if not exists idx_financial_events_user_date
  on financial_events (telegram_user_id, created_at desc);
create index if not exists idx_financial_events_user_type
  on financial_events (telegram_user_id, event_type);

alter table financial_events enable row level security;
