# دبّر SMS Helper — دليل التشغيل السريع

كل الكود جاهز ومربوط بالباك إند الفعلي (`/api/sms-webhook`, `/api/bank-accounts`). الخطوات
المتبقية دي بتحتاج بيئة Android SDK حقيقية ووصول إنترنت — معنديش أي منهم في البيئة اللي
كتبت فيها الكود، فمقدرتش أخليها آلية بالكامل. خطوات لمرة واحدة بس:

## 1) افتح المشروع
افتح مجلد `android-helper/` في Android Studio (هيقترح عليك يولّد `gradlew`/`gradlew.bat`
و `gradle-wrapper.jar` تلقائي أول ما تفتحه — دي ملفات ثنائية Gradle بيحتاج نفسه يحمّلها
من الإنترنت، مش حاجة نقدر نولّدها كنص).

## 2) أيقونة التطبيق
ضيف أيقونة عادية عبر: يمين على `app/src/main/res` → New → Image Asset → اختار لوجو دبّر
(`public/app/branding/dabbar-mark-white.png` موجود بالفعل، يصلح كنقطة بداية).

## 3) جرّب على جهازك
وصّل موبايل بكابل (أو Emulator)، ودوس Run ▶️. جرّب تبعتلنفسك SMS تجريبي وتابع لوج
`BankNotificationListenerService` في Logcat.

## 4) التوقيع والنشر الآلي (مرة واحدة)
اتبع التعليقات آخر ملف `.github/workflows/build-apk.yml` (توليد keystore + 3 GitHub
Secrets). بعدها أي تاج جديد (`git tag v1.0.0 && git push --tags`) هيبني وينشر
`dabbar-sms-helper.apk` تلقائي على GitHub Releases، وده نفس الرابط اللي
`backend/api-handlers/bank-accounts.js` بيرجعه في `apkDownloadUrl` للداشبورد.

## 5) لو مش عايز تستخدم GitHub Actions
أبسط بديل: افتح Android Studio → Build → Generate Signed Bundle/APK → اعمل APK موقّع
يدويًا، وارفعه لأي مكان استضافة ملفات عندك (حتى `public/downloads/` في نفس مشروع
Next.js)، وحدّث environment variable اسمها `SMS_HELPER_APK_URL` على Vercel برابط الملف.

بعد كده كل حاجة في الداشبورد (زرار التحميل + رابط `dabbar://setup?token=...`) هتشتغل
من غير أي تعديل تاني في الكود.
