-- Dabbar subscription flags migration (صياد الاشتراكات 2.0)
-- شغّله في Supabase SQL Editor مرة واحدة على مشروع قائم.
-- الجدول ده بيخزن أي اشتراك ثابت علّمه المستخدم بإنه "مش بستخدمه" — عشان يتحسب
-- تلقائي في كارت "فرص التوفير" فوق تبويب "يومي"، ويفضل متزامن بين الأجهزة.

create table if not exists subscription_flags (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  subscription_key text not null, -- نفس normalizeSubscriptionKey() المستخدم في كشف الاشتراكات
  label text not null,            -- آخر اسم ظاهر للمستخدم (للعرض بس)
  last_amount numeric(14, 2) not null default 0,
  flagged_at timestamptz not null default now(),
  unique (telegram_user_id, subscription_key)
);

create index if not exists subscription_flags_user_idx
  on subscription_flags (telegram_user_id);

-- تفعيل RLS: الـ API بيستخدم service role ويتخطى RLS تلقائيًا،
-- فبنقفل الوصول المباشر من المتصفح بنفس نمط جدول reminders.
alter table subscription_flags enable row level security;
