-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- توكن ثابت وعشوائي لكل مستخدم، بيتحط في رابط الـ webhook بتاع MacroDroid
-- عشان السيرفر يعرف الرسالة دي بتخص مين، من غير ما يحتاج تسجيل دخول Supabase.

alter table profiles
  add column if not exists sms_webhook_token uuid not null default gen_random_uuid();

alter table profiles
  add column if not exists sms_webhook_enabled boolean not null default false;

alter table profiles
  add column if not exists sms_webhook_daily_count int not null default 0;

alter table profiles
  add column if not exists sms_webhook_daily_reset_at date not null default current_date;

create unique index if not exists profiles_sms_webhook_token_idx
  on profiles (sms_webhook_token);
