-- ParkOS: facility_daily_manifest — the Booking section's Daily Manifest.
--
-- WHAT THIS ANSWERS, AND WHY IT IS NOT AN EXISTING FUNCTION
-- facility_today_arrivals and facility_today_departures both key off
-- checked_in_at / checked_out_at, so they report events that have ALREADY
-- happened. A manifest is the opposite question: what is SCHEDULED for a given
-- facility-local day, whether or not anyone has touched it yet. That predicate
-- lives on `during`, not on the check-in timestamps, so it needs its own
-- function rather than a parameter on those.
--
-- SCOPE — arrivals UNION departures, not "overlaps the day". A reservation is
-- on the manifest when its window STARTS or ENDS on the target local date.
-- Deliberately not `during && the day`: a long stay would appear on every
-- sheet between its endpoints, burying the rows staff actually act on. The
-- returned `kind` distinguishes the three cases:
--   arriving    — starts that day
--   departing   — ends that day
--   turnaround  — both (a same-day in-and-out)
--
-- SECURITY INVOKER (the default), same reasoning as the occupancy_dashboard
-- family: this only READS rows the caller's own RLS SELECT policies already
-- govern. Every org member may SELECT reservations, spaces, zones, customers,
-- facilities, payments, and booth_payments in their org
-- (get_user_role(org_id) is not null). Running as the caller means RLS filters
-- every row automatically and a cross-tenant facility id resolves to zero
-- visible rows. There is nothing to bypass, so we never elevate. STABLE
-- (read-only) with search_path locked to ''.
--
-- TIMEZONE CONVENTION — this function uses public.safe_timezone(f.timezone),
-- following the reporting_functions family (20260824000000), NOT the bare
-- f.timezone used by the occupancy_dashboard family (20260822000000).
-- safe_timezone falls back to UTC for a null/blank/unrecognized value instead
-- of raising 22023 and taking down the whole query. CONSEQUENCE, ACCEPTED
-- DELIBERATELY: for a facility whose timezone string is malformed, this
-- manifest bins by UTC while the dashboard's arrivals card raises or bins
-- differently, so the two can disagree. That divergence is recorded in
-- docs/roadmap.md under "Known gaps" and is not fixed here.
--
-- SOFT DELETES — archived reservations are excluded (Decision #5). This
-- matches record_booth_payment, which refuses to collect against an archived
-- reservation; a row nobody may take money for does not belong on the sheet.

create or replace function public.facility_daily_manifest(
  p_facility_id uuid,
  p_date date default null
)
returns table (
  reservation_id  uuid,
  booking_code    text,
  customer_name   text,
  space_number    text,
  zone_name       text,
  starts_at       timestamptz,
  ends_at         timestamptz,
  status          public.reservation_status,
  kind            text,
  total_cents     integer,
  paid_cents      integer,
  balance_cents   integer,
  currency        text,
  checked_in_at   timestamptz,
  checked_out_at  timestamptz
)
language sql
stable
set search_path = ''
as $$
  with target as (
    select f.id  as facility_id,
           public.safe_timezone(f.timezone) as tz,
           coalesce(
             p_date,
             (now() at time zone public.safe_timezone(f.timezone))::date
           ) as local_date
      from public.facilities f
     where f.id = p_facility_id
  )
  select r.id,
         r.booking_code,
         c.full_name,
         s.space_number,
         z.name,
         lower(r.during),
         upper(r.during),
         r.status,
         case
           when (lower(r.during) at time zone t.tz)::date = t.local_date
            and (upper(r.during) at time zone t.tz)::date = t.local_date
             then 'turnaround'
           when (lower(r.during) at time zone t.tz)::date = t.local_date
             then 'arriving'
           else 'departing'
         end,
         r.total_cents,
         paid.amount,
         greatest(r.total_cents - paid.amount, 0),
         r.currency,
         r.checked_in_at,
         r.checked_out_at
    from target t
    join public.reservations r
      on r.facility_id = t.facility_id
    join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
    join public.customers c on c.id = r.customer_id and c.org_id = r.org_id
    -- Money is summed inline rather than by calling
    -- public.reservation_balance_cents(uuid) per row: that function is
    -- SECURITY DEFINER and takes one reservation id, so a manifest of N rows
    -- would be N elevated calls inside one query. reservation_balance_cents
    -- REMAINS THE CANONICAL DEFINITION of what a reservation balance is --
    -- this is a duplicate of it, and the two must agree row for row. If you
    -- change one, change the other.
    left join lateral (
      select coalesce(pg_catalog.sum(collected.amount_cents), 0::bigint)::integer
               as amount
        from (
          select bp.amount_cents
            from public.booth_payments bp
           where bp.reservation_id = r.id
             and bp.org_id = r.org_id
          union all
          select p.amount_cents
            from public.payments p
           where p.reservation_id = r.id
             and p.org_id = r.org_id
             and p.status = 'succeeded'
        ) collected
    ) paid on true
   where r.archived_at is null
     and (   (lower(r.during) at time zone t.tz)::date = t.local_date
          or (upper(r.during) at time zone t.tz)::date = t.local_date)
   order by lower(r.during), s.space_number
$$;

comment on function public.facility_daily_manifest(uuid, date) is
  'Reservations scheduled to start or end on one facility-local day, with kind (arriving/departing/turnaround) and collected/outstanding money. Bins by safe_timezone(facilities.timezone). Balance duplicates reservation_balance_cents(uuid), which stays canonical.';

-- The other half of the duplication note, so whoever edits the canonical
-- function finds the copy.
comment on function public.reservation_balance_cents(uuid) is
  'Canonical outstanding balance for one reservation: total_cents minus booth_payments plus succeeded payments, floored at zero. NOTE: public.facility_daily_manifest(uuid, date) inlines this same sum for a whole day at once. Keep the two in agreement.';

-- Grants: authenticated may execute; RLS inside the function (it runs as the
-- caller) decides which rows come back. No anon access.
revoke all on function public.facility_daily_manifest(uuid, date) from public;
grant execute on function public.facility_daily_manifest(uuid, date) to authenticated;
