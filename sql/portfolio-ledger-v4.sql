-- Portfolio Ledger v4 — additive migration for the existing Dabbar schema
-- Safe to run repeatedly in Supabase SQL Editor.

alter table portfolio_assets add column if not exists user_id uuid;
alter table portfolio_assets add column if not exists category text;
alter table portfolio_assets add column if not exists title text;
alter table portfolio_assets add column if not exists quantity numeric;
alter table portfolio_assets add column if not exists buy_price numeric;
alter table portfolio_assets add column if not exists current_price numeric;
alter table portfolio_assets add column if not exists yield_rate numeric;
alter table portfolio_assets add column if not exists payout_frequency text;
alter table portfolio_assets add column if not exists payout_type text;
alter table portfolio_assets add column if not exists next_payout_date date;
alter table portfolio_assets add column if not exists maturity_date date;
alter table portfolio_assets add column if not exists status text not null default 'active';
alter table portfolio_assets add column if not exists notes text;
alter table portfolio_assets add column if not exists legacy_description text;
alter table portfolio_assets add column if not exists currency_code text not null default 'EGP';

update portfolio_assets set title = coalesce(title, name) where title is null;
update portfolio_assets set name = coalesce(name, title) where name is null;
update portfolio_assets set category = coalesce(category, 'static_cash');

alter table portfolio_assets drop constraint if exists portfolio_assets_category_check;
alter table portfolio_assets add constraint portfolio_assets_category_check check (category in ('fixed_yield','market_asset','static_cash','loan_debt'));
alter table portfolio_assets drop constraint if exists portfolio_assets_payout_frequency_check;
alter table portfolio_assets add constraint portfolio_assets_payout_frequency_check check (payout_frequency is null or payout_frequency in ('monthly','quarterly','annually','at_maturity'));
alter table portfolio_assets drop constraint if exists portfolio_assets_payout_type_check;
alter table portfolio_assets add constraint portfolio_assets_payout_type_check check (payout_type is null or payout_type in ('cash_payout','compound'));
alter table portfolio_assets drop constraint if exists portfolio_assets_status_check;
alter table portfolio_assets add constraint portfolio_assets_status_check check (status in ('active','matured','sold','archived'));

create table if not exists portfolio_transactions (
  id bigint generated always as identity primary key,
  asset_id bigint references portfolio_assets(id) on delete set null,
  telegram_user_id bigint not null,
  type text not null check (type in ('deposit','withdrawal','yield_payout','maturity_transfer','buy','sell','revaluation')),
  amount numeric not null check (amount >= 0),
  quantity numeric,
  description text,
  transaction_date timestamptz not null default now(),
  idempotency_key text,
  currency_code text not null default 'EGP',
  created_at timestamptz not null default now()
);
create unique index if not exists idx_portfolio_tx_idempotency on portfolio_transactions(telegram_user_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_portfolio_tx_user_date on portfolio_transactions(telegram_user_id, transaction_date desc);
create index if not exists idx_portfolio_assets_user_status on portfolio_assets(telegram_user_id, status);

-- Extract common Arabic legacy descriptions into structured columns.
create or replace function migrate_portfolio_legacy_metadata() returns integer language plpgsql as $$
declare r record; n integer := 0; rate numeric; freq text; begin
  for r in select id, coalesce(legacy_description, sub_label, '') as d from portfolio_assets loop
    rate := (regexp_match(r.d, '(\d+(?:[\.,]\d+)?)\s*%'))[1]::numeric;
    freq := case when r.d ~* 'شهري|شهر' then 'monthly' when r.d ~* 'ربع|3\s*شهور|ثلاث' then 'quarterly' when r.d ~* 'سنوي|سنه|عام' then 'annually' when r.d ~* 'استحقاق|مaturity' then 'at_maturity' end;
    update portfolio_assets set yield_rate=coalesce(yield_rate,rate), payout_frequency=coalesce(payout_frequency,freq), legacy_description=case when legacy_description is null then r.d else legacy_description end where id=r.id and (rate is not null or freq is not null);
    if found then n := n + 1; end if;
  end loop; return n;
end $$;

-- One transaction per user/day. The unique idempotency key is the final guard against retries.
create or replace function process_portfolio_daily(p_user_id bigint, p_today date default current_date) returns jsonb language plpgsql security definer as $$
declare a record; cash_id bigint; payout numeric; months numeric; key text; processed integer := 0; transferred numeric := 0;
begin
  for a in select * from portfolio_assets where telegram_user_id=p_user_id and status='active' order by id for update loop
    if a.category='fixed_yield' and a.yield_rate is not null and a.next_payout_date is not null and a.next_payout_date <= p_today then
      months := case a.payout_frequency when 'monthly' then 1 when 'quarterly' then 3 when 'annually' then 12 else 0 end;
      if months > 0 then
        payout := round((a.amount * (a.yield_rate / 100) * (months / 12))::numeric, 2);
        key := 'yield:'||a.id||':'||a.next_payout_date;
        if not exists(select 1 from portfolio_transactions where telegram_user_id=p_user_id and idempotency_key=key) then
          if a.payout_type='cash_payout' then
            select id into cash_id from portfolio_assets where telegram_user_id=p_user_id and category='static_cash' and lower(coalesce(title,name))='كاش وسيولة' and status='active' order by id limit 1 for update;
            if cash_id is null then insert into portfolio_assets(telegram_user_id,name,title,category,amount,status) values(p_user_id,'كاش وسيولة','كاش وسيولة','static_cash',0,'active') returning id into cash_id; end if;
            update portfolio_assets set amount=amount+payout, updated_at=now() where id=cash_id;
          else update portfolio_assets set amount=amount+payout, updated_at=now() where id=a.id; end if;
          insert into portfolio_transactions(asset_id,telegram_user_id,type,amount,description,transaction_date,idempotency_key,currency_code) values(a.id,p_user_id,'yield_payout',payout,'صرف عائد دوري آلي',p_today,key,coalesce(a.currency_code,'EGP'));
          update portfolio_assets set next_payout_date=case a.payout_frequency when 'monthly' then a.next_payout_date+interval '1 month' when 'quarterly' then a.next_payout_date+interval '3 months' when 'annually' then a.next_payout_date+interval '1 year' else a.next_payout_date end where id=a.id;
          processed := processed+1;
        end if;
      end if;
    end if;
    if a.maturity_date is not null and a.maturity_date <= p_today and a.status='active' then
      select id into cash_id from portfolio_assets where telegram_user_id=p_user_id and category='static_cash' and lower(coalesce(title,name))='كاش وسيولة' and status='active' order by id limit 1 for update;
      if cash_id is null then insert into portfolio_assets(telegram_user_id,name,title,category,amount,status) values(p_user_id,'كاش وسيولة','كاش وسيولة','static_cash',0,'active') returning id into cash_id; end if;
      key := 'maturity:'||a.id||':'||a.maturity_date;
      if not exists(select 1 from portfolio_transactions where telegram_user_id=p_user_id and idempotency_key=key) then
        update portfolio_assets set amount=amount+a.amount, updated_at=now() where id=cash_id;
        insert into portfolio_transactions(asset_id,telegram_user_id,type,amount,description,transaction_date,idempotency_key,currency_code) values(a.id,p_user_id,'maturity_transfer',a.amount,'تحويل أصل عند الاستحقاق',p_today,key,coalesce(a.currency_code,'EGP'));
        update portfolio_assets set amount=0,status='matured',updated_at=now() where id=a.id;
        transferred := transferred+a.amount;
      end if;
    end if;
  end loop;
  return jsonb_build_object('processed',processed,'transferred',transferred,'date',p_today);
end $$;
