-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- نفس فكرة sql/voice-usage.sql بالظبط، بس لرسايل النص: بيضيف حد أقصى يومي لعدد رسايل النص
-- اللي بتتصنّف بالـ AI لكل مستخدم، عشان نمنع أي abuse يكلّفنا فلوس Groq من غير ما يأثر على
-- أي استخدام حقيقي (110 رسالة باليوم كتير جدًا لأي إنسان عادي).

create table if not exists text_usage (
  telegram_user_id bigint not null,
  usage_date date not null,
  count int not null default 0,
  primary key (telegram_user_id, usage_date)
);

-- دالة atomic: بتحاول تزوّد العدّاد بواحد، وترفض (ترجع false) لو وصل الحد الأقصى.
-- نفس منطق try_increment_voice_usage بالظبط.
create or replace function try_increment_text_usage(p_user_id bigint, p_limit int)
returns boolean
language plpgsql
as $$
declare
  new_count int;
begin
  insert into text_usage (telegram_user_id, usage_date, count)
  values (p_user_id, current_date, 0)
  on conflict (telegram_user_id, usage_date) do nothing;

  update text_usage
  set count = count + 1
  where telegram_user_id = p_user_id
    and usage_date = current_date
    and count < p_limit
  returning count into new_count;

  return new_count is not null;
end;
$$;
