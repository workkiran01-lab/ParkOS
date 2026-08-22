-- ParkOS Week 11: live occupancy dashboard.
-- No new tables. This migration only (1) enables Realtime replication on the two
-- tables the dashboard subscribes to and (2) adds SECURITY INVOKER read
-- functions that compute per-facility occupancy, today's revenue, arrivals,
-- departures, and overstays.
--
-- WHY THESE FUNCTIONS ARE SECURITY INVOKER (the default), same reasoning as
-- Week 6's find_available_spaces: they only READ rows the caller's own RLS
-- SELECT policies already govern. Every member of an org may already SELECT
-- spaces, zones, space_holds, reservations, customers, facilities, and payments
-- in that org (get_user_role(org_id) is not null). Running as the caller means
-- RLS filters every row to the caller's org automatically and a cross-tenant
-- facility id simply resolves to zero visible rows. There is nothing to bypass,
-- so we never elevate. All are STABLE (read-only) with search_path locked to ''.
--
-- IMPORTANT MODELING NOTE — live occupancy comes from space_holds, not
-- spaces.status. Nothing in the reservation lifecycle (check-in, check-out,
-- no-show, cancel) ever writes spaces.status; that column is the admin-set
-- baseline (available / permit_assigned / maintenance / blocked) only. A space
-- is "held now" iff it has a space_hold with released_at is null whose `during`
-- range contains now(). The dashboard's occupancy count and the grid's live
-- tile colours are both derived from exactly that predicate so the number and
-- the picture can never disagree.

-- ---------------------------------------------------------------------------
-- 1. Realtime replication
-- ---------------------------------------------------------------------------
--
-- postgres_changes subscriptions only fire for tables in the supabase_realtime
-- publication. Confirmed not previously added (no publication references existed
-- anywhere before this week), so this genuinely enables it now. Guarded so a
-- re-run or a table already present is a NOTICE, not a failure.
--
-- REPLICA IDENTITY FULL: Realtime applies the subscriber's RLS to each change
-- and evaluates subscription filters against the row. For UPDATE and DELETE the
-- default replica identity (primary key only) does not carry the other columns
-- (e.g. org_id) that RLS and our org-scoped filter need, so we widen it to FULL
-- on both tables. INSERTs already carry the whole new row.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'spaces'
  ) then
    alter publication supabase_realtime add table public.spaces;
    raise notice 'PARKOS: added public.spaces to supabase_realtime';
  else
    raise notice 'PARKOS: public.spaces already in supabase_realtime';
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'space_holds'
  ) then
    alter publication supabase_realtime add table public.space_holds;
    raise notice 'PARKOS: added public.space_holds to supabase_realtime';
  else
    raise notice 'PARKOS: public.space_holds already in supabase_realtime';
  end if;
end $$;

alter table public.spaces replica identity full;
alter table public.space_holds replica identity full;

-- ---------------------------------------------------------------------------
-- 2. facility_dashboard_summary — the glanceable top-line numbers (§18)
-- ---------------------------------------------------------------------------
--
-- Returns one row: total active spaces, spaces held right now, occupancy
-- percentage, and today's collected revenue in the facility's local day.
-- today_revenue_cents sums succeeded payments whose created_at falls on the
-- facility-local calendar day (ARCHITECTURE.md decision 2: convert at the edge,
-- here the facility's own IANA timezone column), never UTC midnight.
create or replace function public.facility_dashboard_summary(p_facility_id uuid)
returns table (
  total_spaces         integer,
  held_now             integer,
  occupancy_pct        numeric,
  today_revenue_cents  bigint
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
  revenue as (
    select coalesce(sum(p.amount_cents), 0)::bigint as cents
      from public.payments p
      join public.reservations r
        on r.id = p.reservation_id and r.org_id = p.org_id
      cross join tz
     where r.facility_id = p_facility_id
       and p.status = 'succeeded'
       and (p.created_at at time zone tz.zone)::date
           = (now() at time zone tz.zone)::date
  )
  select
    (select count(*) from active_spaces)::integer,
    (select count(*) from held)::integer,
    case
      when (select count(*) from active_spaces) = 0 then 0
      else round(
        (select count(*) from held)::numeric * 100
        / (select count(*) from active_spaces), 1)
    end,
    (select cents from revenue)
$$;

-- ---------------------------------------------------------------------------
-- 3. facility_today_arrivals — reservations checked in on the facility's
--    local calendar day.
-- ---------------------------------------------------------------------------
create or replace function public.facility_today_arrivals(p_facility_id uuid)
returns table (
  reservation_id  uuid,
  space_id        uuid,
  space_number    text,
  zone_name       text,
  customer_name   text,
  checked_in_at   timestamptz,
  during          tstzrange,
  status          public.reservation_status
)
language sql
stable
set search_path = ''
as $$
  select r.id, s.id, s.space_number, z.name, c.full_name,
         r.checked_in_at, r.during, r.status
    from public.reservations r
    join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
    join public.customers c on c.id = r.customer_id and c.org_id = r.org_id
    join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
   where r.facility_id = p_facility_id
     and r.checked_in_at is not null
     and (r.checked_in_at at time zone f.timezone)::date
         = (now() at time zone f.timezone)::date
   order by r.checked_in_at desc
$$;

-- ---------------------------------------------------------------------------
-- 4. facility_today_departures — reservations checked out on the facility's
--    local calendar day.
-- ---------------------------------------------------------------------------
create or replace function public.facility_today_departures(p_facility_id uuid)
returns table (
  reservation_id  uuid,
  space_id        uuid,
  space_number    text,
  zone_name       text,
  customer_name   text,
  checked_out_at  timestamptz,
  during          tstzrange,
  status          public.reservation_status
)
language sql
stable
set search_path = ''
as $$
  select r.id, s.id, s.space_number, z.name, c.full_name,
         r.checked_out_at, r.during, r.status
    from public.reservations r
    join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
    join public.customers c on c.id = r.customer_id and c.org_id = r.org_id
    join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
   where r.facility_id = p_facility_id
     and r.checked_out_at is not null
     and (r.checked_out_at at time zone f.timezone)::date
         = (now() at time zone f.timezone)::date
   order by r.checked_out_at desc
$$;

-- ---------------------------------------------------------------------------
-- 5. facility_overstays — active reservations whose window end has passed but
--    which have not been checked out. Not a "today" query: an overstay that
--    began yesterday is still an overstay until someone checks it out.
-- ---------------------------------------------------------------------------
create or replace function public.facility_overstays(p_facility_id uuid)
returns table (
  reservation_id  uuid,
  space_id        uuid,
  space_number    text,
  zone_name       text,
  customer_name   text,
  ends_at         timestamptz,
  checked_in_at   timestamptz,
  during          tstzrange
)
language sql
stable
set search_path = ''
as $$
  select r.id, s.id, s.space_number, z.name, c.full_name,
         upper(r.during), r.checked_in_at, r.during
    from public.reservations r
    join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
    join public.customers c on c.id = r.customer_id and c.org_id = r.org_id
   where r.facility_id = p_facility_id
     and r.status = 'active'
     and r.checked_out_at is null
     and upper(r.during) < now()
   order by upper(r.during) asc
$$;

-- ---------------------------------------------------------------------------
-- Grants: authenticated may execute; RLS inside each function (they run as the
-- caller) decides which rows come back. No anon access.
-- ---------------------------------------------------------------------------
revoke all on function public.facility_dashboard_summary(uuid) from public;
revoke all on function public.facility_today_arrivals(uuid) from public;
revoke all on function public.facility_today_departures(uuid) from public;
revoke all on function public.facility_overstays(uuid) from public;

grant execute on function public.facility_dashboard_summary(uuid) to authenticated;
grant execute on function public.facility_today_arrivals(uuid) to authenticated;
grant execute on function public.facility_today_departures(uuid) to authenticated;
grant execute on function public.facility_overstays(uuid) to authenticated;
