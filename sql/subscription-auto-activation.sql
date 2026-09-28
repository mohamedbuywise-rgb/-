-- شغّل هذا migration في Supabase SQL Editor.
-- التفعيل الآلي لا يحدث إلا عند تطابق مرجع الصورة + مبلغها مع SMS وارد عبر التوكن السري الخاص بهاتف صاحب الحساب.

alter table subscription_proofs add column if not exists extracted_reference text;
alter table subscription_proofs add column if not exists extracted_amount numeric(12,2);
alter table subscription_proofs add column if not exists bank_reference text;
alter table subscription_proofs add column if not exists bank_amount numeric(12,2);
alter table subscription_proofs add column if not exists matched_sms_id bigint;
alter table subscription_proofs add column if not exists matched_at timestamptz;
alter table subscription_proofs add column if not exists verification_reason text;

do $$ begin
  alter table subscription_proofs drop constraint if exists subscription_proofs_status_check;
  alter table subscription_proofs add constraint subscription_proofs_status_check
    check (status in ('pending', 'review', 'activated', 'rejected'));
exception when duplicate_object then null;
end $$;

create table if not exists subscription_payment_sms (
  id bigint generated always as identity primary key,
  fingerprint text not null unique,
  sender text not null,
  raw_text text not null,
  reference text not null,
  amount numeric(12,2) not null,
  status text not null default 'pending' check (status in ('pending', 'matched', 'ignored')),
  matched_proof_id bigint references subscription_proofs(id) on delete set null,
  received_at timestamptz not null default now(),
  matched_at timestamptz
);
create index if not exists subscription_payment_sms_pending_idx on subscription_payment_sms (status, received_at);
create index if not exists subscription_payment_sms_reference_idx on subscription_payment_sms (reference, amount, status);

do $$ begin
  alter table subscription_proofs add constraint subscription_proofs_matched_sms_fk
    foreign key (matched_sms_id) references subscription_payment_sms(id) on delete set null;
exception when duplicate_object then null;
end $$;
