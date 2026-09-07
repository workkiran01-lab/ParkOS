-- Complete staff reservation creation with authoritative operating-hour checks.
-- Existing facilities use {"type":"daily","open":"HH:MM","close":"HH:MM"}.
-- NULL means unrestricted for backward compatibility. The weekly/closed forms
-- are accepted here so one server-side predicate can also serve later UI work.

create or replace function public.facility_accepts_reservation_window(
  p_facility_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_timezone text;
  v_hours jsonb;
  v_schedule jsonb;
  v_first_date date;
  v_last_date date;
  v_date date;
  v_day_key text;
  v_open time;
  v_close time;
  v_interval_start timestamptz;
  v_interval_end timestamptz;
  v_covered_until timestamptz;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return false;
  end if;

  select f.timezone, f.operating_hours
    into v_timezone, v_hours
    from public.facilities f
   where f.id = p_facility_id
     and f.archived_at is null;

  if not found then
    return false;
  end if;

  -- Facilities created before operating hours were collected remain 24-hour.
  if v_hours is null or v_hours ->> 'type' = '24_hours' then
    return true;
  end if;

  v_first_date := (p_start at time zone v_timezone)::date - 1;
  v_last_date := ((p_end - interval '1 microsecond') at time zone v_timezone)::date;
  v_covered_until := p_start;

  for v_date in
    select day_value::date
      from pg_catalog.generate_series(v_first_date, v_last_date, interval '1 day')
        as day_value
  loop
    if v_hours ->> 'type' = 'weekly' then
      v_day_key := (array['mon','tue','wed','thu','fri','sat','sun'])[
        extract(isodow from v_date)::integer
      ];
      v_schedule := v_hours -> 'days' -> v_day_key;
    else
      v_schedule := v_hours;
    end if;

    if v_schedule is null
       or v_schedule = 'null'::jsonb
       or (pg_catalog.jsonb_typeof(v_schedule) = 'string'
           and v_schedule #>> '{}' = 'closed')
       or v_schedule ->> 'type' = 'closed' then
      continue;
    end if;

    if (pg_catalog.jsonb_typeof(v_schedule) = 'string'
        and v_schedule #>> '{}' = '24_hours')
       or v_schedule ->> 'type' = '24_hours' then
      v_interval_start := v_date::timestamp at time zone v_timezone;
      v_interval_end := (v_date + 1)::timestamp at time zone v_timezone;
    else
      v_open := (v_schedule ->> 'open')::time;
      v_close := (v_schedule ->> 'close')::time;
      v_interval_start := (v_date + v_open) at time zone v_timezone;
      v_interval_end := case
        when v_close > v_open
          then (v_date + v_close) at time zone v_timezone
        else ((v_date + 1) + v_close) at time zone v_timezone
      end;
    end if;

    if v_interval_start <= v_covered_until
       and v_interval_end > v_covered_until then
      v_covered_until := v_interval_end;
      if v_covered_until >= p_end then
        return true;
      end if;
    end if;
  end loop;

  return false;
end;
$$;

comment on function public.facility_accepts_reservation_window(uuid, timestamptz, timestamptz) is
  'True only when a UTC reservation interval is continuously covered by the facility local operating schedule. Daily equal open/close and explicit 24_hours mean continuous operation; weekly null/closed days are closed.';

revoke all on function public.facility_accepts_reservation_window(uuid, timestamptz, timestamptz) from public;
grant execute on function public.facility_accepts_reservation_window(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

create or replace function public.enforce_reservation_operating_hours()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.facility_accepts_reservation_window(
    new.facility_id,
    lower(new.during),
    upper(new.during)
  ) then
    raise exception using
      errcode = '22007',
      message = 'OUTSIDE_OPERATING_HOURS';
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_operating_hours on public.reservations;
create trigger reservations_operating_hours
before insert or update of facility_id, during on public.reservations
for each row execute function public.enforce_reservation_operating_hours();

revoke all on function public.enforce_reservation_operating_hours() from public;

-- Availability is advisory; the reservation trigger and exclusion constraint
-- remain the authoritative checks at insert time and close the concurrency gap.
create or replace function public.find_available_spaces(
  p_facility_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_space_type public.space_type default null
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
     and (p_space_type is null or s.space_type = p_space_type)
     and public.facility_accepts_reservation_window(
       p_facility_id, p_start, p_end
     )
     and not exists (
       select 1
         from public.space_holds h
        where h.space_id = s.id
          and h.released_at is null
          and h.during && tstzrange(p_start, p_end, '[)')
     )
   order by s.space_number;
$$;

create or replace function public.get_public_availability(
  p_facility_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_space_type public.space_type default null
)
returns table (
  space_id uuid,
  space_number text,
  zone_name text,
  space_type public.space_type
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.space_number, z.name, s.space_type
    from public.spaces s
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
    join public.facilities f on f.id = z.facility_id and f.org_id = z.org_id
   where z.facility_id = p_facility_id
     and f.archived_at is null
     and s.archived_at is null
     and z.archived_at is null
     and (p_space_type is null or s.space_type = p_space_type)
     and public.facility_accepts_reservation_window(
       p_facility_id, p_start, p_end
     )
     and not exists (
       select 1
         from public.space_holds h
        where h.space_id = s.id
          and h.released_at is null
          and h.during && tstzrange(p_start, p_end, '[)')
     )
   order by s.space_number;
$$;
