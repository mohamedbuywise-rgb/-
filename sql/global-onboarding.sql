-- شغّل هذا الملف مرة واحدة في Supabase SQL Editor قبل استخدام onboarding الجديد.
-- آمن للتشغيل أكثر من مرة، ولا يحذف أي بيانات.

alter table users alter column chat_id drop not null;
alter table users add column if not exists auth_user_id uuid;
create unique index if not exists idx_users_auth_user_id on users(auth_user_id) where auth_user_id is not null;

alter table users add column if not exists country text not null default 'Egypt';
alter table users add column if not exists country_code text not null default 'EG';
alter table users add column if not exists language text not null default 'ar';
alter table users add column if not exists currency text not null default 'Egyptian Pound';
alter table users add column if not exists currency_code text not null default 'EGP';
alter table users add column if not exists locale text not null default 'ar-EG';
alter table users add column if not exists timezone text not null default 'Africa/Cairo';

alter table expenses add column if not exists currency_code text not null default 'EGP';
alter table debts add column if not exists currency_code text not null default 'EGP';
alter table debt_settlements add column if not exists currency_code text not null default 'EGP';
alter table debt_reminders add column if not exists currency_code text not null default 'EGP';

-- هذه الأعمدة تخص الفواتير/الأهداف إن كانت الجداول موجودة في مشروعك.
do $$ begin
  if to_regclass('public.invoices') is not null then alter table invoices add column if not exists currency_code text not null default 'EGP'; end if;
  if to_regclass('public.invoice_items') is not null then alter table invoice_items add column if not exists currency_code text not null default 'EGP'; end if;
  if to_regclass('public.goals') is not null then alter table goals add column if not exists currency_code text not null default 'EGP'; end if;
end $$;

comment on column users.auth_user_id is 'Supabase Auth identity for users who have not linked Telegram';
