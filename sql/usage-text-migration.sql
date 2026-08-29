-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ============================================================================
-- Migration: إضافة عداد "text" (الرسائل النصية المكتوبة/إدخالات الداشبورد)
-- عشان يبقى محدود بنفس منطق voice/ocr/chat بالظبط، بدل ما يفضل من غير حد.
-- شغّل الملف ده بعد sql/usage.sql (أو في أي وقت لو usage.sql شغال عندك بالفعل).
-- ============================================================================

alter table usage_counters add column if not exists text_count int not null default 0;

create or replace function increment_usage_counter(
  p_user_id bigint,
  p_period text,
  p_kind text,      -- 'voice' | 'ocr' | 'chat' | 'text'
  p_limit int
) returns table(allowed boolean, current_count int) as $$
declare
  v_new_count int;
begin
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
