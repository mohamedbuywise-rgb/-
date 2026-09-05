-- ============ جداول "امسح فاتورة" الاحترافي: فاتورة كاملة + كل صنف فيها لوحده ============
-- شغّل الملف ده مرة واحدة في Supabase SQL editor قبل ما تستخدم lib/invoices.js

create table if not exists invoices (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  merchant text not null default '',
  total_amount numeric not null,
  payment_method text default '',
  invoice_number text default '',
  is_debt boolean not null default false,
  debt_person text default '',
  created_at timestamptz not null default now()
);

create table if not exists invoice_items (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references invoices(id) on delete cascade,
  telegram_user_id bigint not null,
  name text not null,
  category text not null,
  amount numeric not null,
  quantity numeric default 1,
  created_at timestamptz not null default now()
);

-- عمود اختياري على expenses عشان نربط كل مصروف اتسجل من فاتورة بالفاتورة الأصلية (يفيد في الحذف/العرض)
alter table expenses add column if not exists invoice_id bigint references invoices(id) on delete set null;

create index if not exists idx_invoices_user on invoices(telegram_user_id, created_at desc);
create index if not exists idx_invoice_items_invoice on invoice_items(invoice_id);
create index if not exists idx_expenses_invoice on expenses(invoice_id);
