-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ميزة "أهداف مالية": المستخدم يحدد هدف (مبلغ + اسم)، ويضيف عليه أول ما يوفر حاجة.

create table if not exists goals (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  title text not null,
  target_amount numeric not null,
  saved_amount numeric not null default 0,
  target_date date,               -- اختياري: تاريخ عايز توصل الهدف بحلوله
  is_active boolean not null default true,   -- بيتحول false لما الهدف يخلص أو يتحذف
  achieved_at timestamptz,        -- بيتسجل لما saved_amount يوصل target_amount
  created_at timestamptz not null default now()
);

-- كل مستخدم عنده هدف واحد نشط بس في نفس الوقت (بيبسط المتابعة والتذكيرات)
create unique index if not exists idx_goals_one_active_per_user
  on goals (telegram_user_id)
  where is_active = true;

create index if not exists idx_goals_user
  on goals (telegram_user_id, created_at desc);
