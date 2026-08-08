-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run

create table if not exists expenses (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  amount numeric not null,
  category text not null,
  description text,
  created_at timestamptz not null default now()
);

-- index يسرّع استعلامات التقارير (فلترة حسب المستخدم والتاريخ)
create index if not exists idx_expenses_user_date
  on expenses (telegram_user_id, created_at desc);
