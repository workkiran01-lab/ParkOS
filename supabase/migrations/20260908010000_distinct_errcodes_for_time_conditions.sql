-- Stop raising application conditions as 22007 (invalid_datetime_format).
--
-- 22007 is PostgreSQL's own code for a value it could not parse as a datetime.
-- Four ParkOS conditions borrowed it, so a caller reading SQLSTATE could not
-- tell a policy decision from corrupt data:
--
--   OUTSIDE_OPERATING_HOURS        a window the facility schedule refuses
--   INVALID_RESERVATION_WINDOW     end not after start, from the caller
--   NONEXISTENT_FACILITY_LOCAL_TIME  a local time inside a DST spring-forward gap
--
-- The collision is reachable, not theoretical. facility_accepts_reservation_window
-- casts (v_schedule ->> 'open')::time, and a facility row whose operating_hours
-- are malformed makes that cast raise a genuine 22007 out of the same trigger
-- that raises OUTSIDE_OPERATING_HOURS. 20260907000000 installs that consumer two
-- migrations before 20260907020000 installs the validator that would have
-- rejected such a row, so the window where one exists is real. A caller keying
-- on 22007 reports "outside operating hours" -- a window the operator can just
-- change -- when the truth is that the facility's hours are corrupt and no
-- window will work.
--
-- Give each condition a code that matches what it is: P0001 for the policy
-- refusal, matching SPACE_UNAVAILABLE and ROLE_NOT_ALLOWED, and 22023
-- (invalid_parameter_value) for the two bad-input conditions, matching
-- CORRECTION_REASON_REQUIRED and INVALID_FACILITY_TIMEZONE. Messages are
-- unchanged, so every caller that matches on message text is unaffected.
-- After this, a 22007 escaping any of these paths means what it says.

-- quote_reservation: window validation reached by create_reservation and
-- public_quote_reservation.
create or replace function public.quote_reservation(
  p_space_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_zone_id uuid;
  v_facility_id uuid;
  v_space_type public.space_type;
  v_timezone text;
  v_rule_id uuid;
  v_hourly_rate_cents integer;
  v_daily_cap_cents integer;
  v_currency text;
  v_day date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_slice_start timestamptz;
  v_slice_end timestamptz;
  v_hours numeric;
  v_uncapped_cents integer;
  v_subtotal_cents integer;
  v_total_cents integer := 0;
  v_line_items jsonb := '[]'::jsonb;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_WINDOW';
  end if;

  -- Facility, zone, type, organization, and time zone come from the space;
  -- callers cannot submit redundant values that disagree with stored data.
  select s.org_id, s.zone_id, z.facility_id, s.space_type, f.timezone
    into v_org_id, v_zone_id, v_facility_id, v_space_type, v_timezone
    from public.spaces s
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
    join public.facilities f on f.id = z.facility_id and f.org_id = s.org_id
   where s.id = p_space_id
     and s.archived_at is null
     and z.archived_at is null
     and f.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'SPACE_NOT_FOUND';
  end if;

  -- Specificity order: zone+type, zone-only, type-only, facility-wide;
  -- priority breaks ties within the same specificity level.
  select pr.id, pr.hourly_rate_cents, pr.daily_cap_cents, pr.currency
    into v_rule_id, v_hourly_rate_cents, v_daily_cap_cents, v_currency
    from public.price_rules pr
   where pr.org_id = v_org_id
     and pr.facility_id = v_facility_id
     and (pr.zone_id is null or pr.zone_id = v_zone_id)
     and (pr.space_type is null or pr.space_type = v_space_type)
     and pr.archived_at is null
   order by
     case
       when pr.zone_id = v_zone_id and pr.space_type = v_space_type then 3
       when pr.zone_id = v_zone_id and pr.space_type is null then 2
       when pr.zone_id is null and pr.space_type = v_space_type then 1
       else 0
     end desc,
     pr.priority desc,
     pr.id
   limit 1;

  if not found then
    raise exception using errcode = 'P0002', message = 'PRICE_RULE_NOT_FOUND';
  end if;

  -- Split the interval at facility-local midnight. Each line item is therefore
  -- capped independently per local calendar day, including across DST changes.
  for v_day in
    select day_value::date
      from pg_catalog.generate_series(
        (p_start at time zone v_timezone)::date,
        ((p_end - interval '1 microsecond') at time zone v_timezone)::date,
        interval '1 day'
      ) as day_value
  loop
    v_day_start := v_day::timestamp at time zone v_timezone;
    v_day_end := (v_day + 1)::timestamp at time zone v_timezone;
    v_slice_start := greatest(p_start, v_day_start);
    v_slice_end := least(p_end, v_day_end);
    v_hours := extract(epoch from (v_slice_end - v_slice_start)) / 3600.0;
    v_uncapped_cents := round(v_hours * v_hourly_rate_cents)::integer;
    v_subtotal_cents := case
      when v_daily_cap_cents is null then v_uncapped_cents
      else least(v_uncapped_cents, v_daily_cap_cents)
    end;
    v_total_cents := v_total_cents + v_subtotal_cents;

    v_line_items := v_line_items || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'date', v_day,
        'start', v_slice_start,
        'end', v_slice_end,
        'hours', round(v_hours, 4),
        'hourly_rate_cents', v_hourly_rate_cents,
        'uncapped_cents', v_uncapped_cents,
        'daily_cap_cents', v_daily_cap_cents,
        'subtotal_cents', v_subtotal_cents
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'currency', v_currency,
    'price_rule_id', v_rule_id,
    'line_items', v_line_items,
    'total_cents', v_total_cents
  );
end;
$$;

-- enforce_reservation_operating_hours: the trigger behind every reservation
-- window write.
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
      errcode = 'P0001',
      message = 'OUTSIDE_OPERATING_HOURS';
  end if;
  return new;
end;
$$;

-- facility_local_to_utc: DST-gap local times.
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
      errcode = '22023',
      message = 'NONEXISTENT_FACILITY_LOCAL_TIME',
      detail = p_local::text || ' ' || v_timezone;
  end if;
  return v_result;
end;
$$;

-- correct_reservation: same window validation as quote_reservation.
create or replace function public.correct_reservation(
  p_reservation_id uuid,
  p_space_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_license_plate text,
  p_reason text
)
returns table (
  booking_code text,
  total_cents integer,
  price_breakdown jsonb,
  affected_reservations jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_target_org_id uuid;
  v_target_facility_id uuid;
  v_customer_before jsonb;
  v_vehicle_before jsonb;
  v_customer_after jsonb;
  v_vehicle_after jsonb;
  v_affected jsonb;
  v_quote jsonb;
  v_total integer;
  v_currency text;
  v_hold_count integer;
  v_plate text := upper(pg_catalog.regexp_replace(trim(p_license_plate), '\s+', ' ', 'g'));
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select r.* into v_reservation
    from public.reservations r
   where r.id = p_reservation_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if not public.has_any_role(
    v_reservation.org_id,
    array['admin','manager','attendant']
  ) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  if v_reservation.status not in ('pending','confirmed') then
    raise exception using
      errcode = 'P0001',
      message = 'CANNOT_CORRECT_FROM_' || upper(v_reservation.status::text);
  end if;

  if p_reason is null or trim(p_reason) = '' then
    raise exception using errcode = '22023', message = 'CORRECTION_REASON_REQUIRED';
  end if;

  if p_start is null or p_end is null or p_end <= p_start then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_WINDOW';
  end if;

  select s.org_id, z.facility_id
    into v_target_org_id, v_target_facility_id
    from public.spaces s
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
   where s.id = p_space_id
     and s.archived_at is null
     and z.archived_at is null;

  if not found or v_target_org_id is distinct from v_reservation.org_id then
    raise exception using errcode = 'P0001', message = 'WRONG_TENANT';
  end if;

  -- Facility changes have accounting and customer-notification consequences;
  -- this correction path only permits reassignment inside the original lot.
  if v_target_facility_id is distinct from v_reservation.facility_id then
    raise exception using errcode = 'P0001', message = 'WRONG_FACILITY';
  end if;

  if p_customer_name is null or trim(p_customer_name) = '' then
    raise exception using errcode = '22023', message = 'CUSTOMER_NAME_REQUIRED';
  end if;
  if nullif(trim(p_customer_email), '') is not null
     and trim(p_customer_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_EMAIL';
  end if;
  if nullif(trim(p_customer_phone), '') is not null
     and trim(p_customer_phone) !~ '^[+()0-9][+()0-9 .-]{5,23}$' then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_PHONE';
  end if;

  select pg_catalog.jsonb_build_object(
    'full_name', c.full_name,
    'email', c.email,
    'phone', c.phone
  ) into v_customer_before
    from public.customers c
   where c.id = v_reservation.customer_id
     and c.org_id = v_reservation.org_id
     and c.archived_at is null
     -- FOR UPDATE, not a bare read. Two staff correcting DIFFERENT reservations
     -- that share this customer lock different reservation rows, so nothing
     -- serialized them until the UPDATE below -- by which time both had already
     -- read the same before-image. The second correction then recorded a
     -- before-image of a value it did not actually replace. Taking the row lock
     -- here makes the loser block on the READ; under READ COMMITTED it then
     -- re-reads the winner's committed row, so its before-image is true.
     for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;

  if v_reservation.vehicle_id is not null then
    if v_plate !~ '^[A-Z0-9][A-Z0-9 -]{1,14}$' then
      raise exception using errcode = '22023', message = 'INVALID_LICENSE_PLATE';
    end if;
    select pg_catalog.jsonb_build_object('license_plate', v.license_plate)
      into v_vehicle_before
      from public.vehicles v
     where v.id = v_reservation.vehicle_id
       and v.org_id = v_reservation.org_id
       and v.customer_id = v_reservation.customer_id
       and v.archived_at is null
       -- Same reasoning as the customer row above. Locked after the customer so
       -- every correction takes these two locks in one order and cannot deadlock.
       for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'VEHICLE_NOT_FOUND';
    end if;
  elsif nullif(v_plate, '') is not null then
    raise exception using errcode = '22023', message = 'NO_VEHICLE_TO_CORRECT';
  end if;

  -- Captured before the shared rows are written, so each collateral audit row
  -- records the values that reservation actually carried beforehand.
  v_affected := public.reservation_correction_siblings(p_reservation_id);

  v_customer_after := pg_catalog.jsonb_build_object(
    'full_name', trim(p_customer_name),
    'email', nullif(trim(p_customer_email), ''),
    'phone', nullif(trim(p_customer_phone), '')
  );
  v_vehicle_after := case
    when v_reservation.vehicle_id is null then null
    else pg_catalog.jsonb_build_object('license_plate', v_plate)
  end;

  -- Repricing is authoritative; callers cannot supply total/currency fields.
  v_quote := public.quote_reservation(p_space_id, p_start, p_end);
  v_total := (v_quote ->> 'total_cents')::integer;
  v_currency := v_quote ->> 'currency';

  update public.customers
     set full_name = trim(p_customer_name),
         email = nullif(trim(p_customer_email), ''),
         phone = nullif(trim(p_customer_phone), '')
   where id = v_reservation.customer_id
     and org_id = v_reservation.org_id;

  if v_reservation.vehicle_id is not null then
    update public.vehicles
       set license_plate = v_plate
     where id = v_reservation.vehicle_id
       and org_id = v_reservation.org_id;
  end if;

  begin
    update public.reservations
       set space_id = p_space_id,
           during = tstzrange(p_start, p_end, '[)'),
           price_breakdown = v_quote,
           total_cents = v_total,
           currency = v_currency
     where id = p_reservation_id;

    update public.space_holds
       set space_id = p_space_id,
           during = tstzrange(p_start, p_end, '[)')
     where reservation_id = p_reservation_id
       and hold_type = 'reservation'
       and released_at is null;
    get diagnostics v_hold_count = row_count;
    if v_hold_count <> 1 then
      raise exception using errcode = 'P0001', message = 'ACTIVE_HOLD_NOT_FOUND';
    end if;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'SPACE_UNAVAILABLE';
  end;

  insert into public.audit_log (
    org_id, actor_id, action, target_table, target_id, reason
  ) values (
    v_reservation.org_id,
    v_user_id,
    'correct_reservation',
    'reservations',
    p_reservation_id,
    pg_catalog.jsonb_build_object(
      'operator_reason', trim(p_reason),
      'affected_reservations', v_affected,
      'before', pg_catalog.jsonb_build_object(
        'space_id', v_reservation.space_id,
        'during', v_reservation.during,
        'customer', v_customer_before,
        'vehicle', v_vehicle_before,
        'total_cents', v_reservation.total_cents,
        'currency', v_reservation.currency
      ),
      'after', pg_catalog.jsonb_build_object(
        'space_id', p_space_id,
        'during', tstzrange(p_start, p_end, '[)'),
        'customer', v_customer_after,
        'vehicle', v_vehicle_after,
        'total_cents', v_total,
        'currency', v_currency
      )
    )::text
  );

  -- One row per collaterally-changed reservation, keyed on THAT reservation's
  -- id, so the evidence is discoverable from the affected reservation itself
  -- rather than only from the one the operator happened to correct.
  insert into public.audit_log (
    org_id, actor_id, action, target_table, target_id, reason
  )
  select
    v_reservation.org_id,
    v_user_id,
    'correct_reservation_side_effect',
    'reservations',
    (affected.value ->> 'reservation_id')::uuid,
    pg_catalog.jsonb_build_object(
      'operator_reason', trim(p_reason),
      'origin_reservation_id', p_reservation_id,
      'origin_booking_code', v_reservation.booking_code,
      'shared_record', affected.value ->> 'shared',
      'before', pg_catalog.jsonb_build_object(
        'customer', v_customer_before,
        'vehicle', v_vehicle_before
      ),
      'after', pg_catalog.jsonb_build_object(
        'customer', v_customer_after,
        'vehicle', v_vehicle_after
      )
    )::text
  from pg_catalog.jsonb_array_elements(v_affected) as affected(value);

  return query
  select v_reservation.booking_code, v_total, v_quote, v_affected;
end;
$$;

comment on function public.correct_reservation(uuid, uuid, timestamptz, timestamptz, text, text, text, text, text) is
  'Staff-only same-facility correction of customer contact, existing vehicle plate, space, and window. Customer and vehicle records are shared per org, so the correction is global by design: every reservation it also changes receives its own correct_reservation_side_effect audit row, and the full set is returned as affected_reservations.';

revoke all on function public.correct_reservation(uuid, uuid, timestamptz, timestamptz, text, text, text, text, text)
  from public, anon;
grant execute on function public.correct_reservation(uuid, uuid, timestamptz, timestamptz, text, text, text, text, text)
  to authenticated;
