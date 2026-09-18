-- Dabbar subscription model v3
-- Safe to run on an existing project. It never deletes or hides financial history.

alter table users add column if not exists trial_reminder_sent_at timestamptz;
alter table users alter column trial_started_at drop not null;
alter table users alter column trial_started_at drop default;

create table if not exists subscription_events (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  event_type text not null check (event_type in ('trial_started','trial_ended','subscription_started','subscription_renewed','subscription_expired','feature_blocked','feature_used')),
  feature_key text,
  status text not null check (status in ('trial','subscribed','free_locked')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists subscription_events_user_date_idx on subscription_events (telegram_user_id, created_at desc);
create index if not exists subscription_events_type_idx on subscription_events (event_type, created_at desc);

create table if not exists subscription_plans (
  plan_key text primary key,
  name text not null,
  price_egp numeric(12,2) not null,
  billing_interval text not null check (billing_interval in ('month')),
  is_active boolean not null default true,
  limits jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
insert into subscription_plans (plan_key, name, price_egp, billing_interval, limits)
values ('monthly', 'دبّر الشهري', 199, 'month', '{"voice":250,"ocr":50,"chat":180,"text":300,"statement":10}'::jsonb)
on conflict (plan_key) do update set price_egp = excluded.price_egp, limits = excluded.limits;

create or replace function start_trial_if_missing(p_user_id bigint)
returns timestamptz language plpgsql as $$
declare v_started timestamptz;
begin
  update users set trial_started_at = coalesce(trial_started_at, now())
  where telegram_user_id = p_user_id
  returning trial_started_at into v_started;
  if v_started is not null then
    insert into subscription_events (telegram_user_id, event_type, status)
    select p_user_id, 'trial_started', 'trial'
    where not exists (
      select 1 from subscription_events where telegram_user_id = p_user_id and event_type = 'trial_started'
    );
  end if;
  return v_started;
end;
$$;

-- Suggested fair-use defaults (editable via subscription_plans.limits):
-- Trial per Cairo day: voice 15, OCR 3, chat 50, AI text classification 15, bank statements 2.
-- Paid per calendar month: voice 250, OCR 50, chat 180, AI text classification 300, statements 10.
-- Manual text + manual category remain unlimited and free; no stored record is deleted on expiry.
