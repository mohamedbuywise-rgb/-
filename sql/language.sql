-- شغّل الملف ده مرة واحدة في Supabase -> SQL Editor
-- لغة المستخدم (ar / en): بتحدد لغة الإشعارات اللي بتتبعت له من السيرفر.
alter table if exists notification_preferences add column if not exists language text not null default 'ar';
