-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- عداد يومي منفصل لاستخدام endpoint المشاركة من آيفون (Share Sheet) — بيستخدم نفس
-- التوكن بتاع أتمتة SMS (sms_webhook_token) لكن بعداد يومي مستقل عشان ميتلخبطش مع
-- عداد رسائل البنوك.

alter table profiles
  add column if not exists quick_add_webhook_daily_count int not null default 0;

alter table profiles
  add column if not exists quick_add_webhook_daily_reset_at date not null default current_date;

comment on column profiles.quick_add_webhook_daily_count is 'عدد مرات استخدام endpoint مشاركة آيفون (نص/صوت/فاتورة) في يوم quick_add_webhook_daily_reset_at';
