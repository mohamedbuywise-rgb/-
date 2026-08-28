-- دبّر: إعدادات التخطيط المالي لكل مستخدم
create table if not exists financial_settings (
  telegram_user_id bigint primary key,
  monthly_income numeric not null default 0,
  monthly_budget numeric not null default 0,
  category_budgets jsonb not null default '{}'::jsonb,
  recurring_expenses jsonb not null default '[]'::jsonb,
  balance_categories jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_financial_settings_user on financial_settings (telegram_user_id);

alter table financial_settings add column if not exists balance_categories jsonb not null default '{}'::jsonb;
