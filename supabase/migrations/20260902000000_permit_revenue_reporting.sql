-- ParkOS: include monthly permit revenue in the dashboard and the report_* functions.
--
-- permit_payments has recorded settled subscription invoices since 20260829000000,
-- but no reporting surface read it, so every operator-facing revenue total was
-- understated by exactly the permit take. This closes that gap.
--
-- JOIN PATH. Permits do NOT hang off a reservation the way booth payments do.
-- booth_payments resolves facility, space and ownership THROUGH reservations;
-- a permit carries facility_id and space_id as its own NOT NULL columns, so the
-- permit branch is one hop shorter and never joins reservations at all:
--
--   permit_payments -> permits -> facilities [-> spaces, only for space type]
--
-- Facility scoping therefore reads permits.facility_id. It deliberately does NOT
-- re-derive the facility by hopping spaces -> zones -> zones.facility_id the way
-- facility_dashboard_summary's active_spaces CTE does: issue_permit validates the
-- two agree when the permit is created, and permits.facility_id is how permits are
-- filtered everywhere else in the codebase.
--
-- REFUNDS. permit_payments.status is constrained to 'succeeded' alone -- the table
-- is written only from invoice.payment_succeeded, and a failed invoice suspends the
-- permit while recording no money. The branches below still filter
-- pp.status = 'succeeded' explicitly, matching how the `payments` branches filter
-- rather than how the booth branches do not: booth_payments has no status column at
-- all, whereas permit_payments does, and an explicit filter keeps these functions
-- correct if that CHECK is ever widened to record permit refunds. Permit rows
-- consequently never reach refunded_count, which stays reservation-only and keeps
-- its existing meaning.
--
-- TIMEZONE. Each function keeps the date expression it already used, and permit
-- revenue uses that same expression so it bins identically to the money already in
-- that function:
--   * facility_dashboard_summary -> raw f.timezone, via its existing tz CTE
--   * report_revenue_by_period      \
--   * report_revenue_by_space_type   > public.safe_timezone(f.timezone)
--   * report_revenue_split          /
-- The divergence between the two is deliberate and NOT addressed here; it predates
-- this change and is tracked in docs/roadmap.md.
--
-- SPACE TYPE. A permit holds a specific space and permits.space_id is NOT NULL with
-- an FK, so the space row always exists and the join can be inner. Archived spaces
-- still contribute their type, exactly as the reservation branches already allow --
-- archiving a space must not silently delete historic revenue from the report.

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
  today_booth_card_revenue_cents         bigint,
  today_permit_revenue_cents             bigint
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
  ),
  -- No reservation hop: the permit names its own facility. Same tz.zone as the
  -- two CTEs above, so all three bin on the identical local calendar day.
  permit_revenue as (
    select coalesce(pg_catalog.sum(pp.amount_cents), 0::bigint) as cents
      from public.permit_payments pp
      join public.permits pr
        on pr.id = pp.permit_id and pr.org_id = pp.org_id
      cross join tz
     where pr.facility_id = p_facility_id
       and pp.status = 'succeeded'
       and (pp.created_at at time zone tz.zone)::date
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
    sr.cents + br.cash_cents + br.card_cents + pr.cents as today_revenue_cents,
    sr.cents as today_stripe_revenue_cents,
    br.cash_cents as today_booth_cash_revenue_cents,
    br.card_cents as today_booth_card_revenue_cents,
    pr.cents as today_permit_revenue_cents
  from stripe_revenue sr
  cross join booth_revenue br
  cross join permit_revenue pr;
$$;

comment on function public.facility_dashboard_summary(uuid) is
  'Per-facility occupancy, today''s revenue, and headline counts for the live dashboard. today_revenue_cents is the sum of the online, booth-cash, booth-card and permit columns beside it. Bins by facilities.timezone DIRECTLY, which raises 22023 on an unusable value -- unlike the reporting and manifest functions, which use safe_timezone(). See docs/roadmap.md. SECURITY INVOKER: rows are filtered by the caller''s own RLS. EXECUTE: authenticated and service_role only; anon was revoked in 20260826030000.';

revoke all on function public.facility_dashboard_summary(uuid) from public, anon;
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
  booth_card_revenue_cents            bigint,
  permit_payments_count               bigint,
  permit_revenue_cents                bigint
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

    union all

    -- Permits reach the facility directly. Tagged 'succeeded' like the booth
    -- branch so it counts as revenue; the WHERE keeps that tag honest.
    select 'permit'::text,
           'succeeded'::text,
           pp.amount_cents,
           (pp.created_at at time zone public.safe_timezone(f.timezone))::date
      from public.permit_payments pp
      join public.permits pr
        on pr.id = pp.permit_id and pr.org_id = pp.org_id
      join public.facilities f on f.id = pr.facility_id and f.org_id = pr.org_id
     where (p_facility_id is null or pr.facility_id = p_facility_id)
       and pp.status = 'succeeded'
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
         ) as booth_card_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'permit')::bigint as permit_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'permit'),
           0::bigint
         ) as permit_revenue_cents
    from bucketed
   group by bucketed.bucket
  having pg_catalog.count(*) filter (
           where status in ('succeeded', 'refunded', 'partially_refunded')) > 0
   order by bucketed.bucket;
$$;

revoke all on function public.report_revenue_by_period(date, date, uuid, text)
  from public, anon;
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
  booth_card_revenue_cents             bigint,
  permit_payments_count                bigint,
  permit_revenue_cents                 bigint
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

    union all

    -- The permit's own space, not a reservation's. No archived_at filter, so an
    -- archived space keeps contributing its type exactly as above.
    select s.space_type::text,
           'permit'::text,
           pp.amount_cents
      from public.permit_payments pp
      join public.permits pr
        on pr.id = pp.permit_id and pr.org_id = pp.org_id
      join public.spaces s on s.id = pr.space_id and s.org_id = pr.org_id
      join public.facilities f on f.id = pr.facility_id and f.org_id = pr.org_id
     where pp.status = 'succeeded'
       and (p_facility_id is null or pr.facility_id = p_facility_id)
       and (pp.created_at at time zone public.safe_timezone(f.timezone))::date
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
         ) as booth_card_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'permit')::bigint as permit_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'permit'),
           0::bigint
         ) as permit_revenue_cents
    from collected
   group by collected.space_type
   order by revenue_cents desc;
$$;

revoke all on function public.report_revenue_by_space_type(date, date, uuid)
  from public, anon;
grant execute on function public.report_revenue_by_space_type(date, date, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Permit vs hourly split
-- ---------------------------------------------------------------------------

-- The 'permit' row used to be a constant placeholder: NULL money, recorded=false,
-- and a note pointing at the known gap. It was never an estimate, so nothing that
-- was previously reported becomes wrong -- but `recorded` now flips to true, the
-- note clears, and the four money columns carry real values, which is visible to
-- anyone comparing a report from before this migration.
--
-- The signature and return type are unchanged, so this is a replace rather than a
-- drop, and the existing grants carry over untouched.
create or replace function public.report_revenue_split(
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
  ),
  -- Deliberately its own CTE rather than a third arm of `collected`: permit money
  -- is the OTHER category here, not part of the hourly total.
  permit_collected as (
    select coalesce(pg_catalog.sum(pp.amount_cents), 0::bigint) as cents
      from public.permit_payments pp
      join public.permits pr
        on pr.id = pp.permit_id and pr.org_id = pp.org_id
      join public.facilities f on f.id = pr.facility_id and f.org_id = pr.org_id
     where pp.status = 'succeeded'
       and (p_facility_id is null or pr.facility_id = p_facility_id)
       and (pp.created_at at time zone public.safe_timezone(f.timezone))::date
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
  -- Every permit invoice is collected by Stripe, so the whole figure sits in the
  -- online column and both booth columns are zero. That keeps the per-row identity
  -- revenue = stripe + booth_cash + booth_card true on this row as well, which is
  -- what the Reports breakdown line renders.
  select 'permit'::text,
         pc.cents,
         pc.cents,
         0::bigint,
         0::bigint,
         true,
         null::text
    from permit_collected pc;
$$;

revoke all on function public.report_revenue_split(date, date, uuid)
  from public, anon;
grant execute on function public.report_revenue_split(date, date, uuid)
  to authenticated, service_role;
