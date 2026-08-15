-- شغّل الكود ده في Supabase -> SQL Editor -> New Query -> Run

-- بيخزّن مؤقتًا أي معاملة (مصروف/دين) رجّعها الموديل بمبلغ محتاج تأكيد من المستخدم (شوف
-- lib/numberExtraction.js -> resolveAmountConfidence)، عشان بوت تليجرام (chat غير stateful،
-- كل request منفصل) يقدر يسترجعها لما المستخدم يدوس زرار التأكيد بعد كذا رسالة/ثانية.
create table if not exists pending_confirmations (
  id text primary key,
  telegram_user_id bigint not null,
  chat_id bigint not null,
  kind text not null check (kind in ('expense', 'debt')),
  payload jsonb not null,
  raw_text text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pending_confirmations_user
  on pending_confirmations (telegram_user_id);

-- تنضيف تلقائي: أي تأكيد معلّق من غير رد لأكتر من يوم بيتحذف مع الكرون اليومي (شوف
-- lib/confirmations.js -> cleanupOldPendingConfirmations، متنادى من api/cron-daily.js).
