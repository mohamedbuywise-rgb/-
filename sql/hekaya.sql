-- ============ الحكاية الأسبوعية: جداول النشرة + التعليقات + التفاعل ============
-- شغّلها مرة واحدة في Supabase SQL Editor.
-- الكتابة كلها بتتم من الـAPI (service role)، والقراءة العامة للعدد المنشور بس.

create table if not exists public.hekaya_issues (
  id uuid primary key default gen_random_uuid(),
  issue_no int not null unique,
  title text not null,
  subtitle text,
  article_md text not null default '',
  video_url text,
  video_id text,
  cover_url text,
  topic text,
  week_start date,
  status text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hekaya_comments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.hekaya_issues(id) on delete cascade,
  parent_id uuid references public.hekaya_comments(id) on delete cascade,
  user_id uuid not null,
  author_name text not null default 'مستخدم',
  body text not null check (char_length(body) between 1 and 500),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.hekaya_reactions (
  issue_id uuid not null references public.hekaya_issues(id) on delete cascade,
  user_id uuid not null,
  kind text not null check (kind in ('fire','think','money')),
  created_at timestamptz not null default now(),
  primary key (issue_id, user_id, kind)
);

create index if not exists hekaya_comments_issue_idx on public.hekaya_comments(issue_id, created_at);
create index if not exists hekaya_issues_pub_idx on public.hekaya_issues(status, issue_no desc);

alter table public.hekaya_issues enable row level security;
alter table public.hekaya_comments enable row level security;
alter table public.hekaya_reactions enable row level security;

-- القراءة العامة: العدد المنشور بس، والتعليقات غير المخفية
drop policy if exists "hekaya issues public read" on public.hekaya_issues;
create policy "hekaya issues public read" on public.hekaya_issues
  for select using (status = 'published');

drop policy if exists "hekaya comments public read" on public.hekaya_comments;
create policy "hekaya comments public read" on public.hekaya_comments
  for select using (hidden = false);

drop policy if exists "hekaya reactions public read" on public.hekaya_reactions;
create policy "hekaya reactions public read" on public.hekaya_reactions
  for select using (true);

-- ============ الاستفتاء (إضافة) ============
alter table public.hekaya_issues add column if not exists poll_question text;
alter table public.hekaya_issues add column if not exists poll_options jsonb not null default '[]'::jsonb;

create table if not exists public.hekaya_poll_votes (
  issue_id uuid not null references public.hekaya_issues(id) on delete cascade,
  user_id uuid not null,
  option_index int not null check (option_index >= 0 and option_index < 6),
  created_at timestamptz not null default now(),
  primary key (issue_id, user_id)
);
alter table public.hekaya_poll_votes enable row level security;
-- الأصوات بتتقري وتتكتب من الـAPI بس (service role)، فمفيش policy عامة
