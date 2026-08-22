-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ده migration خاص بميزة "دفع الاشتراك من الداشبورد": المستخدم يقدر يرفع صورة إيصال
-- التحويل من صفحة "حسابي" على الموقع (بدل ما يبعتها يدوي على تليجرام بس)، وبتتبعت
-- تلقائيًا للأدمن على تليجرام لمراجعتها وتفعيل الاشتراك بنفس أمر "فعل" المعتاد.
-- آمن يتشغّل تاني لو شغّلته قبل كده (كله IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- ============ جدول سجل إثباتات الدفع (للأرشفة والمتابعة بس) ============
-- بيتقرا ويتكتب من السيرفر بس (SUPABASE_SERVICE_ROLE_KEY في api/subscription-proof.js)،
-- مش من المتصفح مباشرة، فمفيش داعي لـ RLS policies هنا زي جدول user_links بالظبط.
create table if not exists subscription_proofs (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  image_url text not null,
  sender_name text,
  status text not null default 'pending' check (status in ('pending', 'activated', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists idx_subscription_proofs_user
  on subscription_proofs (telegram_user_id, created_at desc);

-- ============ Storage bucket لصور إيصالات التحويل ============
-- public = true عشان بوت تليجرام يقدر يجيب الصورة بلينك مباشر ويبعتها للأدمن (sendPhoto محتاج URL عام).
insert into storage.buckets (id, name, public)
values ('payment-proofs', 'payment-proofs', true)
on conflict (id) do nothing;

-- الرفع بيحصل من السيرفر بس (service role بيتخطى RLS أصلاً)، بس بنضيف policy قراءة عامة
-- عشان اللينك اللي بيتبعت لتليجرام يشتغل من غير أي توكن.
drop policy if exists "payment_proofs_public_read" on storage.objects;
create policy "payment_proofs_public_read" on storage.objects
  for select using (bucket_id = 'payment-proofs');
