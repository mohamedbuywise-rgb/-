-- دبّر: Web Push subscriptions, user preferences, and idempotency records
-- شغّل الملف مرة واحدة في Supabase SQL Editor.

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  telegram_user_id bigint not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  is_active boolean not null default true,
  last_used_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_push_subscriptions_endpoint
  on push_subscriptions (endpoint);
create index if not exists idx_push_subscriptions_telegram_user
  on push_subscriptions (telegram_user_id, is_active);

create table if not exists notification_preferences (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  telegram_user_id bigint not null unique,
  daily_reminder_enabled boolean not null default true,
  daily_summary_enabled boolean not null default true,
  weekly_summary_enabled boolean not null default true,
  budget_alert_enabled boolean not null default true,
  daily_reminder_hour smallint not null default 8 check (daily_reminder_hour between 0 and 23),
  budget_alert_threshold numeric not null default 0.80 check (budget_alert_threshold between 0.50 and 1.00),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table notification_preferences add column if not exists daily_summary_enabled boolean not null default true;

create index if not exists idx_notification_preferences_telegram_user
  on notification_preferences (telegram_user_id);

create table if not exists push_notification_runs (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  notification_type text not null,
  period_key text not null,
  sent_at timestamptz not null default now()
);

create unique index if not exists idx_push_notification_runs_unique
  on push_notification_runs (telegram_user_id, notification_type, period_key);
