-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ميزة "محفظتك الاستثمارية": كانت قبل كده بيانات وهمية (mock) ثابتة في الواجهة بس.
-- دلوقتي بقت بيانات حقيقية بيدخلها العميل بنفسه (ذهب/صناديق/عملات رقمية/أي أصل تاني)،
-- وبتتخزن هنا وتتجمع في إجمالي المحفظة الحقيقي.

create table if not exists portfolio_assets (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  name text not null,             -- اسم الأصل، مثلاً "ذهب" أو "صناديق استثمار بنك مصر"
  sub_label text,                 -- وصف اختياري، مثلاً "120 جرام" أو "محفظة خارجية"
  amount numeric not null,        -- القيمة الحالية بالجنيه (بيدخلها العميل يدويًا وقت التحديث)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_portfolio_assets_user
  on portfolio_assets (telegram_user_id, created_at desc);
