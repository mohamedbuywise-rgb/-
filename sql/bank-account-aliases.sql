-- شغّل الملف ده مرة واحدة في Supabase -> SQL Editor -> Run
-- 1) آخر أرقام الحساب/الكارت اللي اتخصم منه (بتتقرأ من الـ SMS) لمصروفات الـ SMS
alter table if exists expenses add column if not exists source_account_last4 text;

-- 2) أسماء مستعارة للحسابات: عشان لو عندك أكتر من حساب في نفس البنك تسمّي كل واحد ("مرتب"، "توفير"...)
create table if not exists bank_account_aliases (
  id bigserial primary key,
  telegram_user_id bigint not null,
  bank_key text not null,
  last4 text not null,
  nickname text not null default '',
  created_at timestamptz not null default now(),
  unique (telegram_user_id, bank_key, last4)
);
alter table bank_account_aliases enable row level security;
