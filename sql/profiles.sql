-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ده migration المرحلة التانية: صفحة "حسابي" (الاسم/الإيميل/صورة البروفايل).
-- آمن يتشغّل تاني لو شغّلته قبل كده (كله IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- ============ جدول البروفايلات: صف واحد لكل حساب على الموقع (auth.users) ============
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  avatar_url text,
  updated_at timestamptz not null default now()
);

-- RLS: كل مستخدم يقدر يشوف/يعدّل بس صف نفسه (الصفحة بتستخدم الـ anon key من المتصفح مباشرة هنا)
alter table profiles enable row level security;

drop policy if exists "profiles_select_own" on profiles;
create policy "profiles_select_own" on profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles
  for update using (auth.uid() = id);

-- ============ Storage bucket لصور البروفايل ============
-- public = true عشان نقدر نعرض الصورة بلينك مباشر من غير توكن (زي أي أفاتار عادي).
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- أي حد يقدر يقرأ الصور (bucket عام أصلاً)، بس الرفع/التعديل/المسح مقصور على صاحب الملف بس.
-- بنخزّن كل صورة تحت مسار {auth_user_id}/avatar.jpg، فبنتحقق إن أول جزء من المسار = uid بتاع المستخدم.
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own" on storage.objects
  for update using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own" on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
