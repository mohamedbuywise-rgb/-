-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run
-- بيضيف عمود الربح/الخسارة المحققة على عمليات البيع في portfolio_transactions.
-- آمن لو اتشغّل أكتر من مرة. من غيره التطبيق بيشتغل عادي، بس الربح المحقق بيتكتب في الوصف بدل عمود مستقل.

alter table portfolio_transactions add column if not exists realized_gain numeric;
comment on column portfolio_transactions.realized_gain is 'الربح (+) أو الخسارة (-) الفعلية من عملية البيع = عائد البيع - نصيب الجزء المباع من التكلفة';
