# Dashboard English Translation

أضيف قاموس ترجمة مركزي داخل الداشبورد يعمل عند `globalContext.language === 'en'`. النظام يحفظ النص العربي الأصلي لكل Text Node، ويترجم النصوص الثابتة والديناميكية الجديدة، والـplaceholder والـtitle والـaria-label، ويعيد العربية عند تغيير اللغة. كما يغيّر `lang` و`dir` إلى `en` و`ltr`، مع بقاء تنسيق العملة حسب Global Context.

الترجمة تعمل محليًا داخل الداشبورد ولا تحتاج Migration جديدة. يلزم فقط حفظ اللغة عبر Global Context الحالي وتشغيل `global-context.sql` و`auth-only.sql` إذا لم يكونا مشغّلين.

تم إصلاح مشكلة كانت ستسبب crash: Text nodes لا تملك `dataset`، فتم استخدام `WeakMap` لحفظ النص الأصلي، مع حماية من حلقة MutationObserver.
