-- Establish one strict facility-time model. Inputs are facility-local wall
-- times, storage is timestamptz/UTC, and every report/operation uses the same
-- validated PostgreSQL IANA identifier.

create or replace function public.is_valid_iana_timezone(p_timezone text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from pg_catalog.pg_timezone_names tz
     where tz.name = p_timezone
       and (tz.name = 'UTC' or tz.name like '%/%')
       and tz.name not like 'posix/%'
       and tz.name not like 'right/%'
  );
$$;

create or replace function public.is_valid_operating_hours(p_hours jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_schedule jsonb;
  v_open time;
  v_close time;
begin
  -- NULL retains the pre-hours behavior: the facility operates continuously.
  if p_hours is null then return true; end if;
  if pg_catalog.jsonb_typeof(p_hours) <> 'object' then return false; end if;

  if p_hours ->> 'type' = '24_hours' then return true; end if;

  if p_hours ->> 'type' = 'daily' then
    if p_hours ->> 'open' is null
       or p_hours ->> 'close' is null
       or (p_hours ->> 'open') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (p_hours ->> 'close') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      return false;
    end if;
    v_open := (p_hours ->> 'open')::time;
    v_close := (p_hours ->> 'close')::time;
    return v_open is not null and v_close is not null;
  end if;

  if coalesce(p_hours ->> 'type', '') <> 'weekly'
     or coalesce(pg_catalog.jsonb_typeof(p_hours -> 'days'), '') <> 'object' then
    return false;
  end if;

  foreach v_key in array array['mon','tue','wed','thu','fri','sat','sun'] loop
    v_schedule := p_hours -> 'days' -> v_key;
    if v_schedule is null or v_schedule = 'null'::jsonb then continue; end if;
    if pg_catalog.jsonb_typeof(v_schedule) = 'string' then
      if v_schedule #>> '{}' not in ('closed', '24_hours') then return false; end if;
      continue;
    end if;
    if pg_catalog.jsonb_typeof(v_schedule) <> 'object' then return false; end if;
    if v_schedule ->> 'type' in ('closed', '24_hours') then continue; end if;
    if coalesce(v_schedule ->> 'type', 'daily') <> 'daily'
       or v_schedule ->> 'open' is null
       or v_schedule ->> 'close' is null
       or (v_schedule ->> 'open') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (v_schedule ->> 'close') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      return false;
    end if;
    v_open := (v_schedule ->> 'open')::time;
    v_close := (v_schedule ->> 'close')::time;
    if v_open is null or v_close is null then return false; end if;
  end loop;

  return true;
exception when invalid_datetime_format then
  return false;
end;
$$;

-- This legacy spelling has only one possible interpretation, so normalize it
-- before installing the validator. No invalid timezone is ever guessed here.
update public.facilities
   set operating_hours = pg_catalog.jsonb_set(
     operating_hours, '{type}', '"24_hours"'::jsonb, false
   )
 where operating_hours ->> 'type' = '24/7';

do $$
declare
  v_invalid_timezones text;
  v_invalid_hours text;
begin
  select pg_catalog.string_agg(f.id::text || '=' || f.timezone, ', ' order by f.id)
    into v_invalid_timezones
    from public.facilities f
   where not public.is_valid_iana_timezone(f.timezone);
  if v_invalid_timezones is not null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_FACILITY_TIMEZONES: ' || v_invalid_timezones,
      hint = 'Replace each value with an explicit PostgreSQL IANA timezone before retrying.';
  end if;

  select pg_catalog.string_agg(f.id::text || '=' || f.operating_hours::text, ', ' order by f.id)
    into v_invalid_hours
    from public.facilities f
   where public.is_valid_operating_hours(f.operating_hours) is not true;
  if v_invalid_hours is not null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_FACILITY_OPERATING_HOURS: ' || v_invalid_hours;
  end if;
end $$;

create or replace function public.validate_facility_time_config()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_valid_iana_timezone(new.timezone) is not true then
    raise exception using
      errcode = '22023',
      message = 'INVALID_FACILITY_TIMEZONE',
      detail = coalesce(new.timezone, '<null>'),
      hint = 'Use a PostgreSQL IANA name such as America/Los_Angeles, not PST or EST.';
  end if;
  if public.is_valid_operating_hours(new.operating_hours) is not true then
    raise exception using
      errcode = '22023',
      message = 'INVALID_FACILITY_OPERATING_HOURS';
  end if;
  return new;
end;
$$;

drop trigger if exists facilities_validate_time_config on public.facilities;
create trigger facilities_validate_time_config
before insert or update of timezone, operating_hours on public.facilities
for each row execute function public.validate_facility_time_config();

-- Keep the historic name because report functions depend on it, but make its
-- behavior strict. The migration above inventories legacy errors first.
create or replace function public.safe_timezone(p_tz text)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_valid_iana_timezone(p_tz) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_FACILITY_TIMEZONE',
      detail = coalesce(p_tz, '<null>');
  end if;
  return p_tz;
end;
$$;

comment on function public.safe_timezone(text) is
  'Returns a validated PostgreSQL IANA timezone. Invalid values raise 22023; they are never silently replaced with UTC.';

-- Deterministic local-wall-clock conversion for server-side callers and SQL
-- verification. A DST gap has no matching instant and raises. A DST overlap
-- has two; MIN chooses the earlier occurrence, matching the TypeScript edge.
create or replace function public.facility_local_to_utc(
  p_facility_id uuid,
  p_local timestamp without time zone
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_timezone text;
  v_baseline timestamptz;
  v_result timestamptz;
begin
  select public.safe_timezone(f.timezone) into v_timezone
    from public.facilities f
   where f.id = p_facility_id and f.archived_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'FACILITY_NOT_FOUND';
  end if;

  v_baseline := p_local at time zone v_timezone;
  select min(v_baseline + pg_catalog.make_interval(mins => offset_minute))
    into v_result
    from pg_catalog.generate_series(-180, 180) as offset_minute
   where (v_baseline + pg_catalog.make_interval(mins => offset_minute))
           at time zone v_timezone = p_local;

  if v_result is null then
    raise exception using
      errcode = '22007',
      message = 'NONEXISTENT_FACILITY_LOCAL_TIME',
      detail = p_local::text || ' ' || v_timezone;
  end if;
  return v_result;
end;
$$;

revoke all on function public.is_valid_iana_timezone(text) from public;
revoke all on function public.is_valid_operating_hours(jsonb) from public;
revoke all on function public.validate_facility_time_config() from public;
revoke all on function public.facility_local_to_utc(uuid, timestamp without time zone) from public;
grant execute on function public.is_valid_iana_timezone(text) to authenticated, service_role;
grant execute on function public.is_valid_operating_hours(jsonb) to authenticated, service_role;
grant execute on function public.facility_local_to_utc(uuid, timestamp without time zone)
  to authenticated, service_role;

-- Permit allocation is intentionally separate from reservation availability:
-- a permit hold is open-ended and must not be rejected merely because a lot
-- closes overnight. The exclusion constraint remains authoritative at issue.
create or replace function public.find_available_spaces_for_permit(
  p_facility_id uuid,
  p_start timestamptz
)
returns setof public.spaces
language sql
stable
set search_path = ''
as $$
  select s.*
    from public.spaces s
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
   where z.facility_id = p_facility_id
     and s.archived_at is null
     and z.archived_at is null
     and p_start is not null
     and not exists (
       select 1 from public.space_holds h
        where h.space_id = s.id
          and h.released_at is null
          and h.during && tstzrange(p_start, null, '[)')
     )
   order by s.space_number;
$$;

revoke all on function public.find_available_spaces_for_permit(uuid, timestamptz)
  from public;
grant execute on function public.find_available_spaces_for_permit(uuid, timestamptz)
  to authenticated;

-- Customers need the timezone beside their UTC range so every display and
-- extension input is rendered on the facility clock.
drop function public.get_my_reservations();
create function public.get_my_reservations()
returns table (
  reservation_id uuid,
  booking_code text,
  facility_id uuid,
  facility_name text,
  facility_timezone text,
  space_id uuid,
  space_number text,
  zone_name text,
  during tstzrange,
  status public.reservation_status,
  total_cents integer,
  currency text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.booking_code, z.facility_id, f.name,
         public.safe_timezone(f.timezone), s.id, s.space_number, z.name,
         r.during, r.status, r.total_cents, r.currency, r.created_at
    from public.reservations r
    join public.spaces s on s.id = r.space_id
    join public.zones z on z.id = s.zone_id
    join public.facilities f on f.id = z.facility_id
   where public.is_own_customer(r.customer_id)
   order by r.created_at desc;
$$;

revoke all on function public.get_my_reservations() from public;
grant execute on function public.get_my_reservations() to authenticated;
