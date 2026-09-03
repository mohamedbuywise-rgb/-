-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ميزة "أهداف مالية": المستخدم يحدد هدف (مبلغ + اسم)، ويضيف عليه أول ما يوفر حاجة.
--
-- تحديث (دعم أكتر من هدف): كان قديمًا فيه unique index بيمنع غير هدف نشط واحد لكل
-- مستخدم. اتشال القيد ده، وبدل منه بقى مسموح بحد أقصى 3 أهداف نشطة في نفس الوقت لكل
-- مستخدم (نفس العدد اللي اتفقنا عليه في البريفيو)، مطبّق بـ trigger على مستوى الداتابيز
-- عشان يفضل الاتساق مضمون حتى لو حصل insert من مصدر تاني غير الـ API بتاعنا.

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

-- لو الداتابيز عندك جاية من نسخة قديمة فيها القيد اللي كان بيمنع أكتر من هدف نشط، امسحه.
-- التنفيذ آمن حتى لو القيد مش موجود أصلاً.
drop index if exists idx_goals_one_active_per_user;

create index if not exists idx_goals_user
  on goals (telegram_user_id, created_at desc);

-- فهرس بيسرّع قراءة الأهداف النشطة الحالية للمستخدم (list مش single زي الأول).
create index if not exists idx_goals_active_per_user
  on goals (telegram_user_id, created_at)
  where is_active = true;

-- ============ حد أقصى 3 أهداف نشطة لكل مستخدم (مطبّق جوه الداتابيز نفسها) ============
create or replace function enforce_max_active_goals()
returns trigger as $$
declare
  active_count integer;
begin
  -- بس لو الهدف الجديد/المتحدّث بيبقى نشط بيتحقق من العدد
  if new.is_active then
    select count(*) into active_count
    from goals
    where telegram_user_id = new.telegram_user_id
      and is_active = true
      and id <> coalesce(new.id, -1);

    if active_count >= 3 then
      raise exception 'MAX_ACTIVE_GOALS_REACHED: معاك 3 أهداف نشطة بالفعل (الحد الأقصى)';
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_enforce_max_active_goals on goals;
create trigger trg_enforce_max_active_goals
  before insert or update of is_active on goals
  for each row
  execute function enforce_max_active_goals();
