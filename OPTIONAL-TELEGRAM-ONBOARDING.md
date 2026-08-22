# Optional Telegram + Global Onboarding

## ما تم تغييره

أصبح المسار الأساسي: تثبيت دبّر، ثم تسجيل الدخول أو إنشاء حساب، ثم اختيار الدولة واللغة والعملة، ثم الدخول إلى الداشبورد. لا يظهر ربط Telegram في هذا المسار.

أصبح Telegram اختياريًا ويظهر داخل تبويب «حسابي» فقط. زر الربط يفتح صفحة الربط عند الطلب عبر `?link=1`.

## الحسابات بدون Telegram

أضيفت هوية بيانات داخلية ثابتة مرتبطة بـSupabase Auth. الحساب الجديد يستخدم `telegram_user_id` داخليًا سالبًا ومشتقًا من UUID، مع `chat_id=0` و`is_active=false` حتى لا يحاول cron إرسال رسائل Telegram له. هذا يحافظ على بنية الجداول الحالية ويمنع خلط بيانات مستخدم بآخر.

تم تعديل dashboard-data وassistant وreports وuser-context لتعمل بهذه الهوية عند عدم وجود صف في `user_links`.

## Migration ضرورية

شغّل `src/sql/auth-only.sql` في Supabase بعد `schema.sql` و`global-context.sql`. الـMigration تجعل `chat_id` اختياريًا وتضيف `auth_user_id` وفهرسًا فريدًا للحسابات القادمة من الموقع.

## التحقق

نجح فحص JavaScript المضمن في الداشبورد، وفحص JavaScript المضمن في onboarding، وفحص الصياغة لكل ملفات API وlib. تم التحقق من وجود install screen وcontext screen ورابط Telegram اختياري واحد.

## ملاحظات

النسخة لا تحذف أو تنقل أي روابط Telegram قديمة. المستخدم المرتبط يظل قادرًا على استخدام Telegram، والمستخدم الجديد يستطيع استخدام الداشبورد وUnified Expense Entry بدون ربط. يجب اختبار مسار حساب جديد في Supabase بعد تشغيل Migration قبل النشر العام.
