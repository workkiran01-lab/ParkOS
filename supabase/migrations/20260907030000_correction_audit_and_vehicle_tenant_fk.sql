-- Corrections stay global: customer and vehicle records are the single source
-- of truth per org, and correcting one reservation is meant to update them for
-- every reservation that references them. The defect was that the blast radius
-- was silent -- collaterally-updated reservations carried no audit evidence and
-- the caller was told nothing -- so staff could not see it before or after.
--
-- This migration makes the blast radius discoverable rather than changing it.
-- No per-reservation contact snapshot is introduced.

-- Which other reservations dereference the same customer or vehicle row. One
-- implementation, shared by the preview and the correction, so the count staff
-- are shown before confirming is by construction the set that is audited after.
-- SECURITY INVOKER: it is only ever called from inside a SECURITY DEFINER
-- function, so it inherits that context and is never RLS-filtered below the
-- true blast radius.
create or replace function public.reservation_correction_siblings(
  p_reservation_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'reservation_id', s.id,
        'booking_code', s.booking_code,
        'shared', case
          when s.customer_id = r.customer_id
           and r.vehicle_id is not null
           and s.vehicle_id = r.vehicle_id then 'customer+vehicle'
          when s.customer_id = r.customer_id then 'customer'
          else 'vehicle'
        end
      )
      order by s.booking_code
    ),
    '[]'::jsonb
  )
    from public.reservations r
    join public.reservations s
      on s.org_id = r.org_id
     and s.id <> r.id
     and s.archived_at is null
     and (
       s.customer_id = r.customer_id
       or (r.vehicle_id is not null and s.vehicle_id = r.vehicle_id)
     )
   where r.id = p_reservation_id;
$$;

comment on function public.reservation_correction_siblings(uuid) is
  'Reservations sharing the corrected reservation''s customer or vehicle row. Internal: called only from SECURITY DEFINER correction functions.';

revoke all on function public.reservation_correction_siblings(uuid)
  from public, anon, authenticated;

-- Read-only preview so the dialog can warn staff BEFORE they confirm, using the
-- same definition of "affected" the correction itself will apply.
create or replace function public.reservation_correction_scope(
  p_reservation_id uuid
)
returns table (
  booking_code text,
  affected_count integer,
  affected_reservations jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_affected jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select r.* into v_reservation
    from public.reservations r
   where r.id = p_reservation_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if not public.has_any_role(
    v_reservation.org_id,
    array['admin','manager','attendant']
  ) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  v_affected := public.reservation_correction_siblings(p_reservation_id);

  return query
  select
    v_reservation.booking_code,
    pg_catalog.jsonb_array_length(v_affected),
    v_affected;
end;
$$;

comment on function public.reservation_correction_scope(uuid) is
  'Staff-only preview of which other reservations a correction to this one would also change, because they share its customer or vehicle record.';

revoke all on function public.reservation_correction_scope(uuid)
  from public, anon;
grant execute on function public.reservation_correction_scope(uuid)
  to authenticated;

-- Recreated (not replaced) because the return type gains affected_reservations.
drop function public.correct_reservation(
  uuid, uuid, timestamptz, timestamptz, text, text, text, text, text
);

create function public.correct_reservation(
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

-- Tenant integrity: reservations.customer_id already carries a composite FK to
-- customers(org_id, id), but reservations.vehicle_id referenced vehicles(id)
-- alone, so only correct_reservation's own org_id guard stood between a
-- reservation and another tenant's vehicle row. Match the customer pattern.
do $$
declare
  v_offenders text;
begin
  select pg_catalog.string_agg(
           r.id::text || ' (reservation org ' || r.org_id::text ||
           ' -> vehicle org ' || v.org_id::text || ')',
           ', ' order by r.id
         )
    into v_offenders
    from public.reservations r
    join public.vehicles v on v.id = r.vehicle_id
   where r.vehicle_id is not null
     and v.org_id is distinct from r.org_id;

  if v_offenders is not null then
    raise exception using
      errcode = '23503',
      message = 'CROSS_TENANT_RESERVATION_VEHICLES: ' || v_offenders,
      hint = 'Repoint each reservation at a vehicle in its own org, or clear vehicle_id, before retrying.';
  end if;
end $$;

alter table public.vehicles
  add constraint vehicles_org_id_id_key unique (org_id, id);

alter table public.reservations
  drop constraint reservations_vehicle_id_fkey;

alter table public.reservations
  add constraint reservations_org_id_vehicle_id_fkey
  foreign key (org_id, vehicle_id) references public.vehicles(org_id, id);
