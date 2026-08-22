-- Telegram اختياري: شغّل هذا بعد schema.sql وglobal-context.sql
-- لا يحذف أي بيانات أو روابط قديمة.
alter table users alter column chat_id drop not null;
alter table users add column if not exists auth_user_id uuid;
create unique index if not exists idx_users_auth_user_id on users(auth_user_id) where auth_user_id is not null;

-- الحسابات الجديدة من الموقع تستخدم chat_id=0 وtelegram_user_id سالبًا ثابتًا مشتقًا من UUID.
-- لا تستخدم هذه الهوية لإرسال رسائل Telegram؛ is_active=false يمنع مهام الإرسال التلقائي.
comment on column users.auth_user_id is 'Supabase Auth identity for users who have not linked Telegram yet';
