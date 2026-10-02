-- Base/display currency selected from «حسابي».
create table if not exists user_currency_preferences (
  telegram_user_id bigint primary key,
  currency_code text not null default 'EGP' check (currency_code ~ '^[A-Z]{3}$'),
  updated_at timestamptz not null default now()
);
create index if not exists idx_user_currency_preferences_currency on user_currency_preferences(currency_code);
