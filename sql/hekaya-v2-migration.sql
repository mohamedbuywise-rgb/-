-- ============ الحكاية · تحديث v2 (شغّله بعد hekaya.sql، آمن للتكرار) ============

-- صور الأغلفة / الفيديو (زي صورة الفيديو على يوتيوب، بتترفع من الأدمن)
insert into storage.buckets (id, name, public)
values ('hekaya-media', 'hekaya-media', true)
on conflict (id) do nothing;

-- لايكات على التعليقات
create table if not exists public.hekaya_comment_likes (
  comment_id uuid not null references public.hekaya_comments(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
alter table public.hekaya_comment_likes enable row level security;
-- الكتابة والقراءة من الـAPI بس (service role)
