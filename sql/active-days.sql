-- Active Days: إحصائية حقيقية من expenses بدون streak أو reset.
-- شغّل هذا الملف مرة واحدة في Supabase SQL Editor.

create or replace function public.get_active_days(p_telegram_user_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with active as (
    select distinct (e.created_at at time zone 'Africa/Cairo')::date as local_day
    from public.expenses e
    where e.telegram_user_id = p_telegram_user_id
  ),
  cairo_today as (
    select (now() at time zone 'Africa/Cairo')::date as day
  ),
  last_seven as (
    select
      (c.day - (6 - n))::date as day,
      exists (select 1 from active a where a.local_day = (c.day - (6 - n))::date) as active,
      case extract(isodow from (c.day - (6 - n))::date)::int
        when 1 then 'ن'
        when 2 then 'ث'
        when 3 then 'ر'
        when 4 then 'خ'
        when 5 then 'ج'
        when 6 then 'س'
        when 7 then 'ح'
      end as label
    from cairo_today c
    cross join generate_series(0, 6) as series(n)
  )
  select jsonb_build_object(
    'total_active_days', (select count(*) from active),
    'last_7_days', coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'date', to_char(day, 'YYYY-MM-DD'),
          'label', label,
          'active', active
        ) order by day
      ) from last_seven),
      '[]'::jsonb
    )
  );
$$;

comment on function public.get_active_days(bigint) is
  'Returns cumulative distinct Cairo calendar days with expenses and live activity for the last seven days.';
