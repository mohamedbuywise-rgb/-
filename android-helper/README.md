# أتمتة رسائل البنوك عبر MacroDroid

تم إيقاف مسار التطبيق المخصص. المسار الرسمي الحالي هو تثبيت MacroDroid من Google Play ثم تنزيل الماكرو المخصص من صفحة **البنوك والمحافظ** داخل دبّر.

1. اضغط «فعّل أتمتة الرسائل عبر MacroDroid».
2. إذا لم يكن MacroDroid مثبتاً، ثبّته من [Google Play](https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid).
3. افتح ملف `daber-bank-automation.macro` واختر MacroDroid للاستيراد.
4. وافق على الاستيراد، ثم فعّل الماكرو ومنح صلاحية قراءة SMS عند طلبها.
5. أرسل SMS تجريبية من بنك مدعوم وتحقق من صفحة الحركات البنكية.

الماكرو يرسل HTTPS POST إلى `/api/sms-webhook` ويحتوي Token المستخدم داخل جسم الطلب. لا تشارك الملف بعد تنزيله مع أي شخص.
