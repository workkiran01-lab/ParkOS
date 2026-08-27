-- ParkOS: include booth collections in dashboard and report revenue.
--
-- Revenue stays additive at the payment-row level. A reservation may have a
-- succeeded Stripe payment and one or more booth payments; UNION ALL preserves
-- every collected row exactly once instead of trying to choose one source for
-- the reservation. Existing total columns remain, with explicit online,
-- booth-cash, and booth-card breakdowns added alongside them.
--
-- Timezone behavior is deliberately NOT normalized in this migration:
--   * facility_dashboard_summary keeps the existing direct f.timezone use.
--   * report_* functions keep the existing safe_timezone(f.timezone) guard.
-- The inconsistency predates this change and changing it here would alter
-- established bucketing behavior beyond the booth-revenue scope.

-- ---------------------------------------------------------------------------
-- Dashboard summary
-- ---------------------------------------------------------------------------

drop function public.facility_dashboard_summary(uuid);

create function public.facility_dashboard_summary(p_facility_id uuid)
returns table (
  total_spaces                           integer,
  held_now                               integer,
  occupancy_pct                          numeric,
  today_revenue_cents                    bigint,
  today_stripe_revenue_cents             bigint,
  today_booth_cash_revenue_cents         bigint,
  today_booth_card_revenue_cents         bigint
)
language sql
stable
set search_path = ''
as $$
  with tz as (
    select f.timezone as zone
      from public.facilities f
     where f.id = p_facility_id
       and f.archived_at is null
  ),
  active_spaces as (
    select s.id
      from public.spaces s
      join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
     where z.facility_id = p_facility_id
       and s.archived_at is null
       and z.archived_at is null
  ),
  held as (
    select distinct h.space_id
      from public.space_holds h
      join active_spaces a on a.id = h.space_id
     where h.released_at is null
       and h.during @> now()
  ),
  stripe_revenue as (
    select coalesce(pg_catalog.sum(p.amount_cents), 0::bigint) as cents
      from public.payments p
      join public.reservations r
        on r.id = p.reservation_id and r.org_id = p.org_id
      cross join tz
     where r.facility_id = p_facility_id
       and p.status = 'succeeded'
       and (p.created_at at time zone tz.zone)::date
           = (now() at time zone tz.zone)::date
  ),
  booth_revenue as (
    select coalesce(
             pg_catalog.sum(bp.amount_cents) filter (where bp.method = 'cash'),
             0::bigint
           ) as cash_cents,
           coalesce(
             pg_catalog.sum(bp.amount_cents) filter (where bp.method = 'card'),
             0::bigint
           ) as card_cents
      from public.booth_payments bp
      join public.reservations r
        on r.id = bp.reservation_id and r.org_id = bp.org_id
      cross join tz
     where r.facility_id = p_facility_id
       and (bp.created_at at time zone tz.zone)::date
           = (now() at time zone tz.zone)::date
  )
  select
    (select pg_catalog.count(*) from active_spaces)::integer as total_spaces,
    (select pg_catalog.count(*) from held)::integer as held_now,
    case
      when (select pg_catalog.count(*) from active_spaces) = 0 then 0
      else pg_catalog.round(
        (select pg_catalog.count(*) from held)::numeric * 100
        / (select pg_catalog.count(*) from active_spaces), 1)
    end as occupancy_pct,
    sr.cents + br.cash_cents + br.card_cents as today_revenue_cents,
    sr.cents as today_stripe_revenue_cents,
    br.cash_cents as today_booth_cash_revenue_cents,
    br.card_cents as today_booth_card_revenue_cents
  from stripe_revenue sr cross join booth_revenue br;
$$;

revoke all on function public.facility_dashboard_summary(uuid) from public;
grant execute on function public.facility_dashboard_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Revenue by day / week / month
-- ---------------------------------------------------------------------------

drop function public.report_revenue_by_period(date, date, uuid, text);

create function public.report_revenue_by_period(
  p_from date,
  p_to date,
  p_facility_id uuid default null,
  p_grain text default 'day'
)
returns table (
  bucket                              date,
  payments_count                      bigint,
  revenue_cents                       bigint,
  refunded_count                      bigint,
  stripe_payments_count               bigint,
  stripe_revenue_cents                bigint,
  booth_cash_payments_count           bigint,
  booth_cash_revenue_cents            bigint,
  booth_card_payments_count           bigint,
  booth_card_revenue_cents            bigint
)
language sql
stable
set search_path = ''
as $$
  with local_payments as (
    select 'stripe'::text as source,
           p.status,
           p.amount_cents,
           (p.created_at at time zone public.safe_timezone(f.timezone))::date as local_day
      from public.payments p
      join public.reservations r
        on r.id = p.reservation_id and r.org_id = p.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where p_facility_id is null or r.facility_id = p_facility_id

    union all

    select ('booth_' || bp.method)::text,
           'succeeded'::text,
           bp.amount_cents,
           (bp.created_at at time zone public.safe_timezone(f.timezone))::date
      from public.booth_payments bp
      join public.reservations r
        on r.id = bp.reservation_id and r.org_id = bp.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where p_facility_id is null or r.facility_id = p_facility_id
  ),
  bucketed as (
    select case pg_catalog.lower(coalesce(p_grain, 'day'))
             when 'week' then pg_catalog.date_trunc('week', local_day)::date
             when 'month' then pg_catalog.date_trunc('month', local_day)::date
             else local_day
           end as bucket,
           source,
           status,
           amount_cents
      from local_payments
     where local_day between p_from and p_to
  )
  select bucketed.bucket as bucket,
         pg_catalog.count(*) filter (
           where status = 'succeeded')::bigint as payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where status = 'succeeded'),
           0::bigint
         ) as revenue_cents,
         pg_catalog.count(*) filter (
           where status in ('refunded', 'partially_refunded'))::bigint
           as refunded_count,
         pg_catalog.count(*) filter (
           where source = 'stripe' and status = 'succeeded')::bigint
           as stripe_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (
             where source = 'stripe' and status = 'succeeded'),
           0::bigint
         ) as stripe_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'booth_cash')::bigint as booth_cash_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_cash'),
           0::bigint
         ) as booth_cash_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'booth_card')::bigint as booth_card_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_card'),
           0::bigint
         ) as booth_card_revenue_cents
    from bucketed
   group by bucketed.bucket
  having pg_catalog.count(*) filter (
           where status in ('succeeded', 'refunded', 'partially_refunded')) > 0
   order by bucketed.bucket;
$$;

revoke all on function public.report_revenue_by_period(date, date, uuid, text) from public;
grant execute on function public.report_revenue_by_period(date, date, uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Revenue by space type
-- ---------------------------------------------------------------------------

drop function public.report_revenue_by_space_type(date, date, uuid);

create function public.report_revenue_by_space_type(
  p_from date,
  p_to date,
  p_facility_id uuid default null
)
returns table (
  space_type                           text,
  payments_count                       bigint,
  revenue_cents                        bigint,
  stripe_payments_count                bigint,
  stripe_revenue_cents                 bigint,
  booth_cash_payments_count            bigint,
  booth_cash_revenue_cents             bigint,
  booth_card_payments_count            bigint,
  booth_card_revenue_cents             bigint
)
language sql
stable
set search_path = ''
as $$
  with collected as (
    select s.space_type::text as space_type,
           'stripe'::text as source,
           p.amount_cents
      from public.payments p
      join public.reservations r
        on r.id = p.reservation_id and r.org_id = p.org_id
      join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where p.status = 'succeeded'
       and (p_facility_id is null or r.facility_id = p_facility_id)
       and (p.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to

    union all

    select s.space_type::text,
           ('booth_' || bp.method)::text,
           bp.amount_cents
      from public.booth_payments bp
      join public.reservations r
        on r.id = bp.reservation_id and r.org_id = bp.org_id
      join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where (p_facility_id is null or r.facility_id = p_facility_id)
       and (bp.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to
  )
  select collected.space_type as space_type,
         pg_catalog.count(*)::bigint as payments_count,
         pg_catalog.sum(amount_cents)::bigint as revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'stripe')::bigint as stripe_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'stripe'),
           0::bigint
         ) as stripe_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'booth_cash')::bigint as booth_cash_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_cash'),
           0::bigint
         ) as booth_cash_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'booth_card')::bigint as booth_card_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_card'),
           0::bigint
         ) as booth_card_revenue_cents
    from collected
   group by collected.space_type
   order by revenue_cents desc;
$$;

revoke all on function public.report_revenue_by_space_type(date, date, uuid) from public;
grant execute on function public.report_revenue_by_space_type(date, date, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Permit vs hourly split
-- ---------------------------------------------------------------------------

drop function public.report_revenue_split(date, date, uuid);

create function public.report_revenue_split(
  p_from date,
  p_to date,
  p_facility_id uuid default null
)
returns table (
  category                           text,
  revenue_cents                      bigint,
  stripe_revenue_cents               bigint,
  booth_cash_revenue_cents           bigint,
  booth_card_revenue_cents           bigint,
  recorded                           boolean,
  note                               text
)
language sql
stable
set search_path = ''
as $$
  with collected as (
    select 'stripe'::text as source,
           p.amount_cents
      from public.payments p
      join public.reservations r
        on r.id = p.reservation_id and r.org_id = p.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where p.status = 'succeeded'
       and (p_facility_id is null or r.facility_id = p_facility_id)
       and (p.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to

    union all

    select ('booth_' || bp.method)::text,
           bp.amount_cents
      from public.booth_payments bp
      join public.reservations r
        on r.id = bp.reservation_id and r.org_id = bp.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where (p_facility_id is null or r.facility_id = p_facility_id)
       and (bp.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to
  )
  select 'hourly'::text as category,
         coalesce(pg_catalog.sum(amount_cents), 0::bigint) as revenue_cents,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'stripe'),
           0::bigint
         ) as stripe_revenue_cents,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_cash'),
           0::bigint
         ) as booth_cash_revenue_cents,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_card'),
           0::bigint
         ) as booth_card_revenue_cents,
         true as recorded,
         null::text as note
    from collected
  union all
  select 'permit'::text,
         null::bigint,
         null::bigint,
         null::bigint,
         null::bigint,
         false,
         'Not recorded - see known gap in ARCHITECTURE.md'::text;
$$;

revoke all on function public.report_revenue_split(date, date, uuid) from public;
grant execute on function public.report_revenue_split(date, date, uuid)
  to authenticated, service_role;
