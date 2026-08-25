-- ParkOS Week 13: operator reporting.
--
-- Read-only aggregation. Every function here is plain SQL, deliberately NOT
-- SECURITY DEFINER — same reasoning as find_available_spaces: an admin or
-- manager can already read their own org's payments, reservations, spaces, and
-- holds, so the caller's RLS is exactly the right scope. Nothing in this file
-- grants visibility that the caller did not already have, and a customer
-- calling these gets their own rows or nothing.
--
-- Shared signature across all five reports: (p_from, p_to, p_facility_id).
-- p_facility_id null means "every facility in the org", matching the permits
-- page's All facilities option. p_from/p_to are inclusive calendar dates read
-- in the facility's own local time, never UTC (Architecture Decision #2).

-- ---------------------------------------------------------------------------
-- Timezone guard
-- ---------------------------------------------------------------------------

-- Facilities carry a free-text timezone, and at least one row in the wild holds
-- an invalid value ('Pacific'). `at time zone` raises 22023 on those, which
-- would take down an entire org-wide report because of one bad facility. Fall
-- back to UTC for unusable values rather than failing the whole query.
create or replace function public.safe_timezone(p_tz text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_tz is null or pg_catalog.btrim(p_tz) = '' then
    return 'UTC';
  end if;
  -- A fixed instant keeps this genuinely immutable; now() would not be.
  perform timestamptz '2000-01-01 00:00:00+00' at time zone p_tz;
  return p_tz;
exception
  when others then
    return 'UTC';
end;
$$;

comment on function public.safe_timezone(text) is
  'Returns the given IANA timezone, or UTC when it is null, blank, or not recognized by this server.';

-- ---------------------------------------------------------------------------
-- 1. Revenue by day / week / month, bucketed in facility-local time
-- ---------------------------------------------------------------------------

-- Only 'succeeded' counts as revenue. 'refunded' is excluded outright, and
-- 'partially_refunded' is excluded too: process_stripe_event uses the refunded
-- amount to pick a status but never stores it, so the net figure is not
-- recoverable from our data. refunded_count is returned alongside so the
-- exclusion is visible rather than silent.
create or replace function public.report_revenue_by_period(
  p_from date,
  p_to date,
  p_facility_id uuid default null,
  p_grain text default 'day'
)
returns table (
  bucket date,
  payments_count bigint,
  revenue_cents bigint,
  refunded_count bigint
)
language sql
stable
set search_path = ''
as $$
  with local_payments as (
    select p.status,
           p.amount_cents,
           (p.created_at at time zone public.safe_timezone(f.timezone))::date as local_day
      from public.payments p
      join public.reservations r on r.id = p.reservation_id
      join public.facilities f on f.id = r.facility_id
     where (p_facility_id is null or r.facility_id = p_facility_id)
  )
  select case pg_catalog.lower(coalesce(p_grain, 'day'))
           when 'week' then pg_catalog.date_trunc('week', local_day)::date
           when 'month' then pg_catalog.date_trunc('month', local_day)::date
           else local_day
         end as bucket,
         pg_catalog.count(*) filter (where status = 'succeeded')::bigint,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where status = 'succeeded'), 0)::bigint,
         pg_catalog.count(*) filter (
           where status in ('refunded', 'partially_refunded'))::bigint
    from local_payments
   where local_day between p_from and p_to
   group by 1
  having pg_catalog.count(*) filter (
           where status in ('succeeded', 'refunded', 'partially_refunded')) > 0
   order by 1;
$$;

-- ---------------------------------------------------------------------------
-- 2. Occupancy over time
-- ---------------------------------------------------------------------------

-- We never recorded point-in-time snapshots, so occupancy is reconstructed from
-- the interval data we do have. For each facility-local calendar day, sum the
-- hours every space_holds row overlaps that day (clipped to the day's bounds,
-- and cut short at released_at when a hold was released early), then divide by
-- (active spaces x 24) to get an average percent occupied for the day.
--
-- Caveat worth stating in the UI: this measures space-hours *held*, not cars
-- present. A reservation nobody showed up for still reads as occupied, which is
-- the correct answer for "could I have sold this space?" and the wrong one for
-- "was the lot full?".
create or replace function public.report_occupancy_by_day(
  p_from date,
  p_to date,
  p_facility_id uuid default null
)
returns table (
  bucket date,
  held_hours numeric,
  space_hours numeric,
  occupancy_pct numeric
)
language sql
stable
set search_path = ''
as $$
  with fac as (
    select f.id,
           public.safe_timezone(f.timezone) as tz,
           (select pg_catalog.count(*)
              from public.spaces s
              join public.zones z on z.id = s.zone_id
             where z.facility_id = f.id
               and s.archived_at is null) as space_count
      from public.facilities f
     where f.archived_at is null
       and (p_facility_id is null or f.id = p_facility_id)
  ),
  days as (
    select d::date as day
      from pg_catalog.generate_series(p_from, p_to, interval '1 day') as d
  ),
  windows as (
    select days.day,
           fac.id as facility_id,
           fac.space_count,
           (days.day::timestamp at time zone fac.tz) as win_start,
           ((days.day + 1)::timestamp at time zone fac.tz) as win_end
      from days cross join fac
     where fac.space_count > 0
  ),
  held_by_day as (
    select w.day,
           w.space_count,
           pg_catalog.sum(
             greatest(
               0,
               extract(epoch from (
                 least(
                   coalesce(upper(h.during), w.win_end),
                   coalesce(h.released_at, w.win_end),
                   w.win_end
                 )
                 - greatest(lower(h.during), w.win_start)
               )) / 3600.0
             )
           ) as held_hours
      from windows w
      join public.spaces s on s.archived_at is null
      join public.zones z on z.id = s.zone_id and z.facility_id = w.facility_id
      join public.space_holds h
        on h.space_id = s.id
       and h.during && tstzrange(w.win_start, w.win_end, '[)')
     group by w.day, w.space_count
  )
  select d.day as bucket,
         pg_catalog.round(coalesce(o.held_hours, 0)::numeric, 2),
         pg_catalog.round(pg_catalog.sum(w.space_count * 24)::numeric, 2),
         case
           when pg_catalog.sum(w.space_count * 24) > 0
             then pg_catalog.round(
               (coalesce(o.held_hours, 0) * 100.0
                / pg_catalog.sum(w.space_count * 24))::numeric, 2)
           else 0
         end
    from days d
    join windows w on w.day = d.day
    left join held_by_day o on o.day = d.day
   group by d.day, o.held_hours
   order by d.day;
$$;

-- ---------------------------------------------------------------------------
-- 3. Average reservation duration
-- ---------------------------------------------------------------------------

-- Measures the booked window (upper(during) - lower(during)) rather than
-- checked_in_at..checked_out_at: the booked window exists on every reservation,
-- while the actual stamps only exist for ones that went through the booth.
-- Reservations are selected by the local calendar day their window starts on.
create or replace function public.report_avg_duration(
  p_from date,
  p_to date,
  p_facility_id uuid default null
)
returns table (
  completed_count bigint,
  avg_hours numeric,
  min_hours numeric,
  max_hours numeric
)
language sql
stable
set search_path = ''
as $$
  with scoped as (
    select extract(
             epoch from (upper(r.during) - lower(r.during))) / 3600.0 as hours
      from public.reservations r
      join public.facilities f on f.id = r.facility_id
     where r.status = 'completed'
       and (p_facility_id is null or r.facility_id = p_facility_id)
       and (lower(r.during) at time zone public.safe_timezone(f.timezone))::date
             between p_from and p_to
  )
  select pg_catalog.count(*)::bigint,
         pg_catalog.round(coalesce(pg_catalog.avg(hours), 0)::numeric, 2),
         pg_catalog.round(coalesce(pg_catalog.min(hours), 0)::numeric, 2),
         pg_catalog.round(coalesce(pg_catalog.max(hours), 0)::numeric, 2)
    from scoped;
$$;

-- ---------------------------------------------------------------------------
-- 4. Revenue by space type
-- ---------------------------------------------------------------------------

create or replace function public.report_revenue_by_space_type(
  p_from date,
  p_to date,
  p_facility_id uuid default null
)
returns table (
  space_type text,
  payments_count bigint,
  revenue_cents bigint
)
language sql
stable
set search_path = ''
as $$
  select s.space_type::text,
         pg_catalog.count(*)::bigint,
         pg_catalog.sum(p.amount_cents)::bigint
    from public.payments p
    join public.reservations r on r.id = p.reservation_id
    join public.spaces s on s.id = r.space_id
    join public.facilities f on f.id = r.facility_id
   where p.status = 'succeeded'
     and (p_facility_id is null or r.facility_id = p_facility_id)
     and (p.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to
   group by 1
   order by 3 desc;
$$;

-- ---------------------------------------------------------------------------
-- 5. Permit vs hourly revenue split
-- ---------------------------------------------------------------------------

-- Hourly revenue is real: it comes from settled reservation payments. Permit
-- revenue is NOT reported, because it is not recorded anywhere — payments
-- cannot hold a permit charge (reservation_id is NOT NULL) and the webhook
-- never handles invoice.payment_succeeded. See the "permit subscription
-- payments are not recorded" gap in ARCHITECTURE.md.
--
-- The permit row is returned with a null amount and recorded = false so the UI
-- can show the gap honestly instead of implying zero revenue, and so the figure
-- can never be silently folded into a headline total.
create or replace function public.report_revenue_split(
  p_from date,
  p_to date,
  p_facility_id uuid default null
)
returns table (
  category text,
  revenue_cents bigint,
  recorded boolean,
  note text
)
language sql
stable
set search_path = ''
as $$
  select 'hourly'::text,
         coalesce(pg_catalog.sum(p.amount_cents), 0)::bigint,
         true,
         null::text
    from public.payments p
    join public.reservations r on r.id = p.reservation_id
    join public.facilities f on f.id = r.facility_id
   where p.status = 'succeeded'
     and (p_facility_id is null or r.facility_id = p_facility_id)
     and (p.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to
  union all
  select 'permit'::text,
         null::bigint,
         false,
         'Not recorded - see known gap in ARCHITECTURE.md'::text;
$$;

-- ---------------------------------------------------------------------------
-- Grants. No SECURITY DEFINER anywhere above, so RLS scopes every result to the
-- caller's own org exactly as it does for a direct table read.
-- ---------------------------------------------------------------------------

revoke all on function public.safe_timezone(text) from public;
revoke all on function public.report_revenue_by_period(date, date, uuid, text) from public;
revoke all on function public.report_occupancy_by_day(date, date, uuid) from public;
revoke all on function public.report_avg_duration(date, date, uuid) from public;
revoke all on function public.report_revenue_by_space_type(date, date, uuid) from public;
revoke all on function public.report_revenue_split(date, date, uuid) from public;

grant execute on function public.safe_timezone(text) to authenticated, service_role;
grant execute on function public.report_revenue_by_period(date, date, uuid, text) to authenticated, service_role;
grant execute on function public.report_occupancy_by_day(date, date, uuid) to authenticated, service_role;
grant execute on function public.report_avg_duration(date, date, uuid) to authenticated, service_role;
grant execute on function public.report_revenue_by_space_type(date, date, uuid) to authenticated, service_role;
grant execute on function public.report_revenue_split(date, date, uuid) to authenticated, service_role;
