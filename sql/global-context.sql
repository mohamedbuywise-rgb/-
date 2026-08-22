-- Global Context migration for Dabbaar.
-- Safe defaults preserve the current Egypt/Arabic experience.

alter table users add column if not exists country text not null default 'Egypt';
alter table users add column if not exists country_code text not null default 'EG';
alter table users add column if not exists language text not null default 'ar';
alter table users add column if not exists currency text not null default 'Egyptian Pound';
alter table users add column if not exists currency_code text not null default 'EGP';
alter table users add column if not exists locale text not null default 'ar-EG';
alter table users add column if not exists timezone text not null default 'Africa/Cairo';

-- Keep supported UI languages explicit while allowing any country/currency.
alter table users drop constraint if exists users_language_check;
alter table users add constraint users_language_check check (language in ('ar', 'en'));

-- Historical operations remain EGP; future rows carry the currency used at entry time.
alter table expenses add column if not exists currency_code text not null default 'EGP';
alter table debts add column if not exists currency_code text not null default 'EGP';
alter table invoices add column if not exists currency_code text not null default 'EGP';
alter table invoice_items add column if not exists currency_code text not null default 'EGP';
alter table goals add column if not exists currency_code text not null default 'EGP';

create index if not exists idx_users_country_language on users (country_code, language);
create index if not exists idx_expenses_user_currency on expenses (telegram_user_id, currency_code);
create index if not exists idx_debts_user_currency on debts (telegram_user_id, currency_code);
create index if not exists idx_invoices_user_currency on invoices (telegram_user_id, currency_code);
create index if not exists idx_invoice_items_user_currency on invoice_items (telegram_user_id, currency_code);

comment on column users.country_code is 'ISO 3166-1 alpha-2 country code, e.g. EG, SA, FR';
comment on column users.language is 'UI/assistant language: ar or en';
comment on column users.currency_code is 'ISO 4217 currency code used for new entries';
comment on column users.locale is 'BCP-47 locale used for formatting';
comment on column users.timezone is 'IANA timezone used for local dates and reports';
comment on column expenses.currency_code is 'Currency at transaction creation; do not reinterpret historical amounts';
comment on column debts.currency_code is 'Currency at debt creation; do not reinterpret historical amounts';
comment on column invoices.currency_code is 'Currency at invoice creation; do not reinterpret historical amounts';
comment on column invoice_items.currency_code is 'Currency at invoice item creation';
comment on column goals.currency_code is 'Currency at goal creation';
