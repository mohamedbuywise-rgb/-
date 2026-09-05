-- ============ جدول تسجيل تاريخ المحفظة الاستثمارية (snapshot يومي) ============
-- بيتسجل صف جديد كل يوم (من الكرون اليومي) فيه: الإجمالي الكلي + تفاصيل كل أصل لوحده
-- (بصيغة JSON) وقت التسجيل. ده اللي بيسمحلنا نحسب "حركة آخر 3 أيام" لكل أصل ولإجمالي
-- المحفظة، ونرسم جراف بسيط لحركة كل أصل مع الوقت.
--
-- assets_json شكله: [{ "id": "...", "name": "...", "amount": 1234.5 }, ...]

create table if not exists portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  total numeric not null,
  assets_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists portfolio_snapshots_user_idx
  on portfolio_snapshots (telegram_user_id, created_at desc);

-- ملحوظة: مفيش داعي لتنضيف/حذف الصفوف القديمة دلوقتي — كل صف صغير جدًا (رقم + JSON بسيط)،
-- ولو حبيت تحتفظ بالمساحة مستقبلًا ممكن تضيف cron شهري يمسح اللي أقدم من 90 يوم مثلًا.
