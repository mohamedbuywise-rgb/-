-- Dabbar multi-currency migration
-- شغّله في Supabase SQL Editor مرة واحدة على مشروع قائم.

alter table if exists expenses
  add column if not exists currency_code text not null default 'EGP';

alter table if exists debts
  add column if not exists currency_code text not null default 'EGP';

alter table if exists financial_events
  add column if not exists currency_code text not null default 'EGP';

update expenses set currency_code = 'EGP' where currency_code is null or currency_code = '';
update debts set currency_code = 'EGP' where currency_code is null or currency_code = '';
update financial_events set currency_code = 'EGP' where currency_code is null or currency_code = '';

alter table if exists expenses
  drop constraint if exists expenses_currency_code_format;
alter table if exists expenses
  add constraint expenses_currency_code_format check (currency_code ~ '^[A-Z]{3}$');

alter table if exists debts
  drop constraint if exists debts_currency_code_format;
alter table if exists debts
  add constraint debts_currency_code_format check (currency_code ~ '^[A-Z]{3}$');

alter table if exists financial_events
  drop constraint if exists financial_events_currency_code_format;
alter table if exists financial_events
  add constraint financial_events_currency_code_format check (currency_code ~ '^[A-Z]{3}$');

create index if not exists idx_expenses_user_currency_date
  on expenses (telegram_user_id, currency_code, created_at desc);

create index if not exists idx_debts_user_currency_date
  on debts (telegram_user_id, currency_code, created_at desc);

create index if not exists idx_financial_events_user_currency_date
  on financial_events (telegram_user_id, currency_code, created_at desc);

-- لا نخزن كلمات مرور البنوك أو أرقام البطاقات؛ العملة مجرد ISO code ثلاثي.
