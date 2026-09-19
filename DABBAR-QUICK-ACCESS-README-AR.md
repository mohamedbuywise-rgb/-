# حزمة دبّر الكاملة — الوصول السريع

## مكان الإضافة داخل التطبيق

المستخدم يصل إلى الميزة من داخل لوحة التحكم في:

**حسابي ← الوصول السريع ⚡**

هذا الكارت يفتح صفحة Preview تشرح للمستخدم مسار Android ومسار iPhone.

## Android

يختار المستخدم من صفحة الوصول السريع:

- **إضافة بلاطة** لإضافة دبّر إلى Quick Settings.
- **إضافة ويدجت** لمعرفة طريقة وضع ويدجت دبّر على الشاشة الرئيسية.

Android سيعرض تأكيد النظام مرة واحدة. هذه الموافقة لا يمكن تجاوزها من موقع أو PWA لأسباب أمنية.

بعدها:

- البلاطة تفتح `?quick=text`.
- زر الكتابة في الويدجت يفتح `?quick=text`.
- زر الصوت في الويدجت يفتح `?quick=voice`.

## iPhone

iPhone لا يسمح لموقع أو PWA بإضافة Widget أو Shortcut بصمت. المسار المدعوم هو:

**حسابي ← الوصول السريع ← اختيار كتابة أو صوت ← Add Shortcut مرة واحدة**

بعد الموافقة يستطيع المستخدم وضع الاختصار على الشاشة الرئيسية أو تشغيله من Siri.

## هل نحتاج SQL؟

لا. هذه التعديلات لا تضيف جداول أو أعمدة أو سياسات جديدة إلى Supabase.

الميزات تعتمد على:

- جلسة Supabase الموجودة بالفعل.
- واجهة الإدخال السريع الموجودة بالفعل.
- `?quick=text` و`?quick=voice`.
- نفس API الحالي لتحليل وحفظ الإدخال.

لا تشغّل أي ملف SQL جديد بسبب هذه الميزة.

## Android build

افتح مجلد `android-helper` في Android Studio، ثم:

1. نفّذ Gradle Sync.
2. ابنِ Debug APK.
3. ثبّت الـ APK على جهاز Android.
4. افتح مساعد دبّر مرة واحدة.
5. وافق على إضافة البلاطة إن ظهر طلب النظام.
6. أضف ويدجت دبّر من Widgets على الشاشة الرئيسية.

الحزمة الحالية لا تحتوي `node_modules` ولا ملفات بناء مؤقتة. لم يتم تضمين APK لأن بيئة التسليم لا تحتوي Gradle Wrapper أو Gradle مثبتًا.

## الملفات الرئيسية الجديدة

- `public/app/quick-access-preview.html`
- `android-helper/app/src/main/java/com/dabbar/smshelper/DabbarQuickTileService.kt`
- `android-helper/app/src/main/java/com/dabbar/smshelper/DabbarQuickWidgetProvider.kt`
- `android-helper/app/src/main/res/layout/widget_quick_entry.xml`
- `android-helper/app/src/main/res/xml/widget_quick_entry_info.xml`
- `android-helper/app/src/main/res/drawable/ic_dabbar_tile.xml`

## تعديلات أخرى ضمن هذه النسخة

- إعادة تصميم حركة السيولة للنهاري والليلي وإزالة الـ blur من شيت التفاصيل.
- اسم Android premium: `دبّر | المساعد المالي`.
- اختصارات PWA للكتابة والصوت.
- حفظ وضع الإدخال السريع أثناء تسجيل الدخول.
- إضافة Preview من داخل تبويب حسابي.
