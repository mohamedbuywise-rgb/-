-- Dabbar: استيراد بيانات من تطبيق تاني (رفع ملف)
-- شغّله في Supabase SQL Editor مرة واحدة على مشروع قائم.
--
-- الفكرة: لو المستخدم رفع ملف فيه 500 صف مثلاً، بنقسمه دفعات (chunks) صغيرة عند
-- المعالجة بالـ AI (عشان ميحصلش timeout)، ونسجل تقدّم كل دفعة في import_jobs.
-- لو الاتصال اتقطع أو الصفحة اتقفلت في نص الطريق، المستخدم يقدر يكمل من عند
-- processed_rows بدل ما يبدأ الملف من الأول، وكل صف بيتسجله له import_key فريد
-- (hash من التاريخ+المبلغ+الفئة+الوصف) عشان لو نفس الصف اتبعت تاني (إعادة محاولة
-- أو رفع نفس الملف غلط) ميتكررش في جدول expenses.

alter table if exists expenses add column if not exists import_source text;
alter table if exists expenses add column if not exists import_key text;

-- unique index جزئي: بس على الصفوف المستوردة (import_key مش null)، ومربوط بالمستخدم
-- عشان مستخدمين مختلفين يقدروا يكون عندهم نفس الـ hash من غير تعارض.
create unique index if not exists idx_expenses_user_import_key
  on expenses (telegram_user_id, import_key)
  where import_key is not null;

create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  source_app text,
  file_name text,
  total_rows int not null default 0,
  processed_rows int not null default 0,
  inserted_rows int not null default 0,
  skipped_rows int not null default 0,
  status text not null default 'processing', -- processing | done | error
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_import_jobs_user
  on import_jobs (telegram_user_id, created_at desc);
