# دبّر SMS Helper — عمارة الحل (Android APK)

## الهدف
تطبيق أندرويد خفيف جدًا (~2 ميجا، Kotlin بدون أي مكتبات تقيلة) بيعمل حاجة واحدة بس:
يقرأ إشعارات رسائل SMS البنكية اللي بتوصل للموبايل، ويبعتها لسيرفر دبّر عبر Webhook
موجود بالفعل (`/api/sms-webhook`) — نفس الـ endpoint اللي MacroDroid كان بيستخدمه، فمفيش
أي تغيير مطلوب في الباك إند.

## ليه NotificationListenerService مش قراءة SMS مباشرة (READ_SMS)؟
- `READ_SMS` / `RECEIVE_SMS` permissions بقت شبه مستحيلة على Google Play للتطبيقات اللي
  مش SMS/Dialer افتراضي (Play Console بيرفضها إلا في حالات محدودة جدًا).
- `NotificationListenerService` بيحتاج إذن واحد بس (Notification Access) بيتاخد مرة واحدة
  من صفحة إعدادات النظام، وبيشتغل مع أي تطبيق SMS افتراضي (Messages, Samsung Messages...)
  من غير ما نطلب صلاحيات حساسة زيادة عن اللزوم.
- ده بالظبط نفس المبدأ اللي MacroDroid شغال بيه دلوقتي — إحنا بنستبدل MacroDroid بتطبيق
  مخصص أخف وأبسط في التفعيل.

## تدفق البيانات (Data Flow)
```
[رسالة SMS بنكية توصل]
        │
        ▼
[النظام يطلع إشعار (Notification)]
        │
        ▼
[BankNotificationListenerService.onNotificationPosted]
   - يفلتر: packageName لازم يكون تطبيق رسائل معروف
   - يفلتر: extras (title/text) لازم يطابق نمط بنك/محفظة مصرية معروفة
     (نفس قايمة lib/bank-senders.js بالظبط عشان الاتساق مع الباك إند)
        │
        ▼
[WebhookClient.send(token, sender, text)]
   - POST https://dabbar.app/api/sms-webhook
   - body: { token, sender, text }
   - لو فشل الإرسال (نت مقطوع مثلاً) → يتخزن محليًا في قايمة انتظار بسيطة
     (SharedPreferences/Room) ويعاد المحاولة لاحقًا (WorkManager)
        │
        ▼
[سيرفر دبّر: نفس منطق sms-webhook.js الحالي]
   - يتحقق من التوكن → يصنّف الرسالة (Groq) → يسجلها (expense/income/debt/...)
```

## تجربة المستخدم (Onboarding)
1. من الداشبورد، زرار "🏦 فعّل تتبع رسائل البنك أوتوماتيك".
2. الموقع يعرض التوكن الخاص بالمستخدم (`sms_webhook_token` من جدول `profiles`،
   نفس اللي موجود بالفعل لـ MacroDroid) + رابط تحميل الـ APK
   (أو رابط Play Store لو اتنشر هناك).
3. أول فتح للتطبيق:
   - شاشة واحدة بسيطة: حقل يلصق فيه التوكن (أو رابط عميق `dabbar://setup?token=...`
     يملأه أوتوماتيك لو فتح من المتصفح مباشرة)
   - زرار "تفعيل" يودي المستخدم لصفحة System Settings → Notification Access
     (`Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`) ويوافق عليها مرة واحدة.
4. من هنا التطبيق شغال في الخلفية صامت تمامًا — مفيش أي UI تاني يحتاجه المستخدم.
5. أيقونة/إشعار دائم (Foreground-friendly عبر `Notification Listener` نفسه، مش محتاج
   Foreground Service منفصل) يوضح إن "دبّر شغال" اختياريًا.

## الأمان والخصوصية
- التطبيق **مايخزنش** أي رسالة SMS محليًا إلا مؤقتًا في قايمة إعادة المحاولة (وبيتمسح
  بعد الإرسال الناجح).
- التوكن بيتخزن في `EncryptedSharedPreferences` (Android Jetpack Security) مش SharedPreferences عادي.
- الفلترة بتحصل **على الجهاز نفسه** قبل الإرسال: أي إشعار من غير تطبيقات رسائل معروفة،
  أو مش من نمط بنك/محفظة معروف، بيتجاهل فورًا ومايتبعتش للسيرفر خالص.
- الاتصال بالسيرفر HTTPS بس، والتوكن هو مصدر التوثيق الوحيد (نفس نموذج MacroDroid الحالي).

## القيود المعروفة (iOS)
Apple ما بتسمحش لأي تطبيق يقرا إشعارات تطبيقات تانية في الخلفية بالشكل ده — فالحل هناك
هيفضل يدوي: iOS Shortcut يشارك نص رسالة SMS لصفحة "أضف مصروف" في دبّر (زي الموجود بالفعل
في `iOS-Shortcut-Setup-AR.md`).

## الحجم المستهدف (~2MB)
- Kotlin فقط، من غير Jetpack Compose (استخدام XML layouts بسيطة).
- من غير أي مكتبة HTTP تقيلة — استخدام `HttpURLConnection` المدمجة أو OkHttp لايت
  (لو الحجم سمح) بدل Retrofit + Gson.
- من غير أي SDK تحليلات/إعلانات.
- ProGuard/R8 مفعّل بالكامل في نسخة الـ release.

## الخطوات التالية (لما تفتح اللابتوب)
1. افتح `android-helper/` في Android Studio كمشروع مستقل.
2. حدّث `WEBHOOK_BASE_URL` في `WebhookClient.kt` بدومين دبّر الحقيقي.
3. راجع/حدّث قايمة أسماء مرسلي البنوك في `BankSenderMatcher.kt` لتفضل متزامنة مع
   `lib/bank-senders.js` (ولو حبيت، ممكن نعمل endpoint صغير `/api/bank-senders` يرجّع
   القايمة كـ JSON عشان التطبيق يحدثها من غير إصدار نسخة جديدة من الـ APK).
4. جرّب على جهاز حقيقي فيه رسائل بنكية تجريبية، وتابع الـ Vercel logs بتاعة
   `/api/sms-webhook` للتأكد من وصول الطلبات.
