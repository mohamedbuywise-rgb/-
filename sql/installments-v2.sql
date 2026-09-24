-- شغّل الملف ده مرة واحدة في Supabase -> SQL Editor
-- بيحفظ "يوم القسط الأصلي" (مثلاً 31) عشان القسط ميتزحلقش لتواريخ غلط في الشهور القصيرة (فبراير مثلاً).
alter table if exists reminders add column if not exists installment_day int;
update reminders set installment_day = extract(day from due_date)::int
  where installment_type = 'installment' and installment_day is null;
