-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ميزات: الجمعية + المناسبات (ديون)، فصل الأقساط الثابتة (تذكيرات)، الحصالة اليومية (أهداف)

-- ============================================================
-- 1) الجمعية والمناسبات — توسعة جدول debts الموجود
-- ============================================================
alter table debts add column if not exists commitment_type text not null default 'debt'
  check (commitment_type in ('debt', 'gameya', 'occasion'));

-- تفاصيل خاصة بالجمعية/المناسبة (شكل مختلف لكل نوع، مش محتاجين أعمدة منفصلة لكل تفصيلة)
alter table debts add column if not exists commitment_meta jsonb not null default '{}'::jsonb;
-- gameya:   { "groupSize": 6, "myTurn": 4, "startDate": "2026-09-01",
--             "memberNames": ["محمد سعيد","سارة حسن"], "paidThisMonth": ["محمد سعيد"] }
-- occasion: { "occasionType": "فرح" }  -- خطوبة / سبوع / عزومة / تاني

-- تاريخ استحقاق اختياري لأي دين (يستخدم في عرض "متأخر X يوم" في شاشة الديون)
alter table debts add column if not exists due_date date;

create index if not exists idx_debts_commitment_type
  on debts (telegram_user_id, commitment_type);

-- ============================================================
-- 2) فصل الأقساط الثابتة عن التذكيرات العادية — توسعة جدول reminders الموجود
-- ============================================================
alter table reminders add column if not exists installment_type text not null default 'normal'
  check (installment_type in ('normal', 'installment'));
alter table reminders add column if not exists installments_remaining int;
alter table reminders add column if not exists last_installment_date date;

create index if not exists idx_reminders_installment
  on reminders (telegram_user_id, installment_type) where done = false;

-- ============================================================
-- 3) الحصالة اليومية — توسعة جدول goals الموجود
-- ============================================================
alter table goals add column if not exists is_daily_piggybank boolean not null default false;
alter table goals add column if not exists daily_amount numeric;
alter table goals add column if not exists last_contribution_date date;

-- الحصالة اليومية مفهوم مختلف عن "هدف ادّخار" وميتحسبش من الحد الأقصى (3 أهداف نشطة)
-- الموجود أصلاً — بنعدّل الـ trigger عشان يستثنيها من العدّ.
create or replace function enforce_max_active_goals()
returns trigger as $$
declare
  active_count integer;
begin
  if new.is_active and not new.is_daily_piggybank then
    select count(*) into active_count
    from goals
    where telegram_user_id = new.telegram_user_id
      and is_active = true
      and is_daily_piggybank = false
      and id <> coalesce(new.id, -1);

    if active_count >= 3 then
      raise exception 'MAX_ACTIVE_GOALS_REACHED: معاك 3 أهداف نشطة بالفعل (الحد الأقصى)';
    end if;
  end if;

  return new;
end;
$$ language plpgsql;
