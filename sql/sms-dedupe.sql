-- دبّر: بصمة رسايل الـ SMS لمنع التسجيل المزدوج (نفس النص بالحرف خلال 90 ثانية فقط)
-- شغّله مرة واحدة في Supabase SQL Editor (آمن لو شغّلته أكتر من مرة).

create table if not exists sms_dedupe (
  id bigint generated always as identity primary key,
  user_id bigint not null,
  fingerprint text not null,
  bucket bigint not null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_sms_dedupe_unique
  on sms_dedupe (user_id, fingerprint, bucket);
create index if not exists idx_sms_dedupe_lookup
  on sms_dedupe (user_id, fingerprint, created_at desc);
