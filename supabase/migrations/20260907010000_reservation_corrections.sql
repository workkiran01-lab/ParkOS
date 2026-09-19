-- Correct reservation mistakes through one narrow, audited authorization path.
-- There is intentionally still no reservations UPDATE policy: direct table
-- writes (including totals, tenant, Stripe, refund, audit, and status fields)
-- remain denied by RLS. Only the columns named by this RPC can change.

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
  price_breakdown jsonb
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
    raise exception using errcode = '22007', message = 'INVALID_RESERVATION_WINDOW';
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
     and c.archived_at is null;

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
       and v.archived_at is null;
    if not found then
      raise exception using errcode = 'P0002', message = 'VEHICLE_NOT_FOUND';
    end if;
  elsif nullif(v_plate, '') is not null then
    raise exception using errcode = '22023', message = 'NO_VEHICLE_TO_CORRECT';
  end if;

  -- Repricing is authoritative; callers cannot supply total/currency fields.
  v_quote := public.quote_reservation(p_space_id, p_start, p_end);
  v_total := (v_quote ->> 'total_cents')::integer;
  v_currency := v_quote ->> 'currency';

  update public.customers
     set full_name = trim(p_customer_name),
         email = nullif(trim(p_customer_email), ''),
         phone = nullif(trim(p_customer_phone), '')
   where id = v_reservation.customer_id;

  if v_reservation.vehicle_id is not null then
    update public.vehicles
       set license_plate = v_plate
     where id = v_reservation.vehicle_id;
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
        'customer', pg_catalog.jsonb_build_object(
          'full_name', trim(p_customer_name),
          'email', nullif(trim(p_customer_email), ''),
          'phone', nullif(trim(p_customer_phone), '')
        ),
        'vehicle', case
          when v_reservation.vehicle_id is null then null
          else pg_catalog.jsonb_build_object('license_plate', v_plate)
        end,
        'total_cents', v_total,
        'currency', v_currency
      )
    )::text
  );

  return query
  select v_reservation.booking_code, v_total, v_quote;
end;
$$;

comment on function public.correct_reservation(uuid, uuid, timestamptz, timestamptz, text, text, text, text, text) is
  'Staff-only same-facility correction of customer contact, existing vehicle plate, space, and window. Reprices server-side, moves the exclusion-protected hold atomically, and records before/after audit JSON.';

revoke all on function public.correct_reservation(uuid, uuid, timestamptz, timestamptz, text, text, text, text, text)
  from public, anon;
grant execute on function public.correct_reservation(uuid, uuid, timestamptz, timestamptz, text, text, text, text, text)
  to authenticated;
