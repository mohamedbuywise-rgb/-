# فلوسي بوت — تتبع المصاريف بالصوت على تليجرام

## 1) Supabase
- افتح مشروعك في Supabase → SQL Editor → New Query
- الصق محتوى `sql/schema.sql` وشغّله (Run)

## 2) رفع الكود
- ارفع الفولدر ده كامل على GitHub repo جديد
- من Vercel: New Project → استورد الـ repo ده → Deploy

## 3) Environment Variables (في إعدادات المشروع على Vercel)
| اسم المتغير | القيمة منين |
|---|---|
| `TELEGRAM_BOT_TOKEN` | من BotFather على تليجرام |
| `GROQ_API_KEY` | من console.groq.com → API Keys |
| `SUPABASE_URL` | من Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | من Supabase → Project Settings → API (Service Role، مش Anon) |

ملاحظة: البوت بيستخدم Groq بس لكل حاجة — تفريغ الصوت (`whisper-large-v3`) واستخراج المبلغ والفئة (`llama-3.3-70b-versatile`). مبقاش محتاج Gemini API key خالص.

بعد ما تضيف المتغيرات، اعمل **Redeploy** للمشروع عشان القيم تتفعّل.

## 4) ربط الـ Webhook (مرة واحدة بس)
افتح الرابط ده في المتصفح بعد ما تستبدل القيم:
```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<VERCEL_URL>/api/telegram-webhook
```
مثال:
```
https://api.telegram.org/bot7123456789:AAExxxxx/setWebhook?url=https://floosy-bot.vercel.app/api/telegram-webhook
```
لازم يرجعلك `{"ok":true,...}`.

## 5) جرب البوت
- افتح البوت في تليجرام، ابعت `/start`
- ابعت فويس نوت أو رسالة زي "صرفت 50 جنيه أكل"
- ابعت "تقرير" عشان تشوف الملخص

## ملاحظات
- الفئات المتاحة حاليًا: أكل، مواصلات، فواتير، تسوق، ترفيه، صحة، أخرى (تقدر تعدلها في `CATEGORIES` بملف الكود)
- لو حابب تغيّر الموديل النصي المستخدم للاستخراج، ضيف Environment Variable اسمها `GROQ_TEXT_MODEL` (افتراضيًا `llama-3.3-70b-versatile`)
