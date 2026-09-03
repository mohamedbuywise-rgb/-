-- Dabbar reminders migration
-- شغّله في Supabase SQL Editor مرة واحدة على مشروع قائم.

create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  title text not null,
  due_date date not null,
  notified_2d boolean not null default false,
  notified_1d boolean not null default false,
  notified_due boolean not null default false,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists reminders_user_idx
  on reminders (telegram_user_id, due_date);

-- (اختياري بس منصوح بيه) يمنع استعلامات الـ cron اليومي إنها تفحص تذكيرات خلصت
create index if not exists reminders_pending_idx
  on reminders (due_date) where done = false;

-- تفعيل RLS: الـ API بيستخدم service role ويتخطى RLS تلقائيًا،
-- فبنقفل الوصول المباشر من المتصفح بنفس نمط جدول financial_events.
alter table reminders enable row level security;
