-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- ميزة "ربط المحفظة الاستثمارية بشراء/بيع الأصول تلقائيًا من الرسائل الطبيعية".
-- بنضيف كمية ووحدة وتكلفة تراكمية عشان نقدر نحسب "مكسبك طالع ولا نازل" (amount - cost_basis)،
-- ونقدر نخصم الكمية الصح لما المستخدم يبيع جزء من أصل (زي "بعت 30 من 120 جرام دهب").

alter table portfolio_assets
  add column if not exists quantity numeric,       -- الكمية الحالية (مثلاً 120 جرام)، فاضية لو الأصل مش مقاس بكمية (زي "محفظة خارجية")
  add column if not exists unit text,               -- وحدة القياس، مثلاً "جرام" أو "دولار" أو "سهم"
  add column if not exists cost_basis numeric;       -- إجمالي الفلوس اللي اتدفعت فعليًا عشان تجيب الكمية الحالية (متوسط تكلفة تراكمي)

comment on column portfolio_assets.quantity is 'الكمية الحالية من الأصل (اختياري)';
comment on column portfolio_assets.unit is 'وحدة الكمية، مثلاً جرام/دولار/سهم';
comment on column portfolio_assets.cost_basis is 'إجمالي تكلفة الشراء التراكمية للكمية الحالية — الفرق بينه وبين amount هو المكسب/الخسارة غير المحقق';
