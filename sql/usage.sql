-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ============================================================================
-- نظام حدود الاستهلاك (Rate Limiting) — فويس / OCR / شات المساعد الذكي
--
-- فكرة الجدول: صف واحد لكل (مستخدم + period_key).
-- - المشترك المدفوع: period_key = رقم الشهر الحالي، مثلاً '2026-08' — وده بيخلي "الرجوع الشهري"
--   يحصل لوحده تلقائيًا من غير أي cron أو خطوة reset يدوية: أول استخدام في شهر جديد بيعمل صف جديد بيبدأ من صفر.
-- - المستخدم في التجربة المجانية: period_key ثابت = 'trial' — صف واحد بس طول الثلاث أيام، تراكمي ومبيتصفرش،
--   لأن حدود التجربة إجمالية على الفترة كلها مش شهرية.
-- ============================================================================

create table if not exists usage_counters (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  period_key text not null,
  voice_count int not null default 0,
  ocr_count int not null default 0,
  chat_count int not null default 0,
  text_count int not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table usage_counters add column if not exists text_count int not null default 0;

create unique index if not exists idx_usage_counters_user_period
  on usage_counters (telegram_user_id, period_key);

-- ============ دالة الزيادة الأتوميك ============
-- بتضمن إن فحص الحد + الزيادة يحصلوا في خطوة واحدة ذرّية جوه Postgres (منعًا لأي race condition
-- لو جالك ريكوستين لنفس المستخدم في نفس اللحظة — زي فويستين ورا بعض بسرعة). بترجع:
--   allowed        = true لو المستخدم لسه تحت الحد وتمت الزيادة فعليًا، أو false لو وصل للحد ومتزادش.
--   current_count  = العداد الحالي بعد المحاولة (سواء اتزاد أو فضل زي ما هو لو وصل للحد).
create or replace function increment_usage_counter(
  p_user_id bigint,
  p_period text,
  p_kind text,      -- 'voice' | 'ocr' | 'chat' | 'text'
  p_limit int
) returns table(allowed boolean, current_count int) as $$
declare
  v_new_count int;
begin
  -- بنضمن إن الصف موجود الأول (من غير ما نلمس القيم لو موجود بالفعل)
  insert into usage_counters (telegram_user_id, period_key)
  values (p_user_id, p_period)
  on conflict (telegram_user_id, period_key) do nothing;

  if p_kind = 'voice' then
    update usage_counters
      set voice_count = voice_count + 1, updated_at = now()
      where telegram_user_id = p_user_id and period_key = p_period and voice_count < p_limit
      returning voice_count into v_new_count;
  elsif p_kind = 'ocr' then
    update usage_counters
      set ocr_count = ocr_count + 1, updated_at = now()
      where telegram_user_id = p_user_id and period_key = p_period and ocr_count < p_limit
      returning ocr_count into v_new_count;
  elsif p_kind = 'chat' then
    update usage_counters
      set chat_count = chat_count + 1, updated_at = now()
      where telegram_user_id = p_user_id and period_key = p_period and chat_count < p_limit
      returning chat_count into v_new_count;
  elsif p_kind = 'text' then
    update usage_counters
      set text_count = text_count + 1, updated_at = now()
      where telegram_user_id = p_user_id and period_key = p_period and text_count < p_limit
      returning text_count into v_new_count;
  else
    raise exception 'unknown usage kind: %', p_kind;
  end if;

  -- لو مفيش صف اتحدّث (يعني وصل للحد)، نرجّع العداد الحالي من غير زيادة
  if v_new_count is null then
    if p_kind = 'voice' then
      select voice_count into v_new_count from usage_counters where telegram_user_id = p_user_id and period_key = p_period;
    elsif p_kind = 'ocr' then
      select ocr_count into v_new_count from usage_counters where telegram_user_id = p_user_id and period_key = p_period;
    elsif p_kind = 'chat' then
      select chat_count into v_new_count from usage_counters where telegram_user_id = p_user_id and period_key = p_period;
    else
      select text_count into v_new_count from usage_counters where telegram_user_id = p_user_id and period_key = p_period;
    end if;
    return query select false, coalesce(v_new_count, p_limit);
  end if;

  return query select true, v_new_count;
end;
$$ language plpgsql;

-- ============ دالة الاسترجاع (Refund) ============
-- بتستخدم لما العداد يكون اتزاد قبل المحاولة (زي OCR) بس المحاولة فشلت فعليًا (الصورة مقروتش) —
-- فبنرجّع العداد زي ما كان عشان المستخدم منخسرش محاولة من رصيده بسبب حاجة مش غلطته.
-- بتمنع الرقم يقل عن صفر (احتياط لو اتنادت مرتين بالغلط أو حصل تضارب توقيت).
create or replace function decrement_usage_counter(
  p_user_id bigint,
  p_period text,
  p_kind text      -- 'voice' | 'ocr' | 'chat' | 'text'
) returns void as $$
begin
  if p_kind = 'voice' then
    update usage_counters
      set voice_count = greatest(voice_count - 1, 0), updated_at = now()
      where telegram_user_id = p_user_id and period_key = p_period;
  elsif p_kind = 'ocr' then
    update usage_counters
      set ocr_count = greatest(ocr_count - 1, 0), updated_at = now()
      where telegram_user_id = p_user_id and period_key = p_period;
  elsif p_kind = 'chat' then
    update usage_counters
      set chat_count = greatest(chat_count - 1, 0), updated_at = now()
      where telegram_user_id = p_user_id and period_key = p_period;
  elsif p_kind = 'text' then
    update usage_counters
      set text_count = greatest(text_count - 1, 0), updated_at = now()
      where telegram_user_id = p_user_id and period_key = p_period;
  else
    raise exception 'unknown usage kind: %', p_kind;
  end if;
end;
$$ language plpgsql;
