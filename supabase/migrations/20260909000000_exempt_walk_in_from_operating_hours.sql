-- Walk-in check-in is no longer refused outside operating hours.
--
-- 20260907000000 put an operating-hours trigger on every reservation window
-- write. That was aimed at scheduled bookings, but check_in_walk_in reaches the
-- same insert through create_reservation, so an attendant recording a car that
-- is physically in the lot outside posted hours was refused, with no override.
-- No commit introducing the gate mentions walk-ins. The refusal does not stop
-- the car parking -- it stops ParkOS recording it and charging for it.
--
-- Scheduled bookings remain gated. The two are distinguished by a
-- transaction-scoped flag that only check_in_walk_in sets, around only its own
-- insert. See the comment in the trigger for why an API caller cannot assert it.

create or replace function public.enforce_reservation_operating_hours()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Walk-in exemption. A walk-in is a car already in the lot with an attendant
  -- standing at it; refusing the row does not stop the parking, only the record
  -- and the payment, which is how a closed-hours arrival becomes unrecorded
  -- revenue. Scheduled bookings stay gated: the point of the gate is to stop a
  -- customer reserving a lot that will be shut when they arrive.
  --
  -- The flag is set by public.check_in_walk_in for its own insert and cleared
  -- immediately after. It is not reachable from a client: PostgREST sets only
  -- request.* GUCs from a request and exposes no function taking a GUC name, so
  -- an API caller cannot assert it. A session with direct SQL can, but such a
  -- caller can already write public.reservations directly.
  if pg_catalog.current_setting('parkos.walk_in_checkin', true) = 'on' then
    return new;
  end if;

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

create or replace function public.check_in_walk_in(
  p_space_id uuid,
  p_customer_id uuid,
  p_vehicle_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns table (reservation_id uuid, total_cents integer, price_breakdown jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_reservation_id uuid;
  v_total integer;
  v_breakdown jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select s.org_id into v_org_id
    from public.spaces s
   where s.id = p_space_id
     and s.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'SPACE_NOT_FOUND';
  end if;

  if not public.has_any_role(v_org_id, array['admin','manager','attendant']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  -- Exempt exactly this insert from the operating-hours trigger, then clear it.
  -- Transaction-scoped (is_local = true), so an error anywhere below reverts it
  -- with the subtransaction rather than leaving the exemption armed. Every other
  -- constraint still applies: create_reservation performs the tenant, customer
  -- and vehicle checks, and the space_holds exclusion constraint still raises
  -- SPACE_UNAVAILABLE for a double book.
  perform pg_catalog.set_config('parkos.walk_in_checkin', 'on', true);

  -- SPACE_UNAVAILABLE from the hold's exclusion constraint propagates unchanged.
  select cr.reservation_id, cr.total_cents, cr.price_breakdown
    into v_reservation_id, v_total, v_breakdown
    from public.create_reservation(
      p_space_id, p_customer_id, p_vehicle_id, p_start, p_end) cr;

  perform pg_catalog.set_config('parkos.walk_in_checkin', 'off', true);

  update public.reservations
     set status = 'active',
         checked_in_at = now(),
         checked_in_by = v_user_id
   where id = v_reservation_id;

  insert into public.audit_log (org_id, actor_id, action, target_table, target_id)
  values (v_org_id, v_user_id, 'check_in_walk_in', 'reservations', v_reservation_id);

  return query select v_reservation_id, v_total, v_breakdown;
end;
$$;
