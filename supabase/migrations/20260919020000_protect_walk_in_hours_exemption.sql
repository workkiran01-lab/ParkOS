-- A caller-controlled GUC is not authorization. Only the staff-checked walk-in
-- RPC may mint this single-use, exact-window authorization. It is consumed by
-- the INSERT trigger in the same transaction; clients have no table privileges.
create table public.walk_in_authorizations (
  backend_pid integer not null,
  transaction_id xid8 not null,
  org_id uuid not null references public.organizations(id),
  space_id uuid not null,
  customer_id uuid not null,
  vehicle_id uuid,
  during tstzrange not null,
  primary key (backend_pid, transaction_id)
);
alter table public.walk_in_authorizations enable row level security;
revoke all on table public.walk_in_authorizations from public, anon, authenticated, service_role;

create or replace function public.enforce_reservation_operating_hours()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    delete from public.walk_in_authorizations a
     where a.backend_pid = pg_catalog.pg_backend_pid()
       and a.transaction_id = pg_catalog.pg_current_xact_id()
       and a.org_id = new.org_id
       and a.space_id = new.space_id
       and a.customer_id = new.customer_id
       and a.vehicle_id is not distinct from new.vehicle_id
       and a.during = new.during;
    if found then return new; end if;
  end if;
  if not public.facility_accepts_reservation_window(
    new.facility_id, lower(new.during), upper(new.during)
  ) then
    raise exception using errcode = 'P0001', message = 'OUTSIDE_OPERATING_HOURS';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_reservation_operating_hours()
  from public, anon, authenticated, service_role;

create or replace function public.check_in_walk_in(
  p_space_id uuid, p_customer_id uuid, p_vehicle_id uuid,
  p_start timestamptz, p_end timestamptz
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
  select s.org_id into v_org_id from public.spaces s
   where s.id = p_space_id and s.archived_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'SPACE_NOT_FOUND';
  end if;
  if not public.has_any_role(v_org_id, array['admin','manager','attendant']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  insert into public.walk_in_authorizations
    (backend_pid, transaction_id, org_id, space_id, customer_id, vehicle_id, during)
  values (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), v_org_id,
          p_space_id, p_customer_id, p_vehicle_id, tstzrange(p_start, p_end, '[)'));

  select cr.reservation_id, cr.total_cents, cr.price_breakdown
    into v_reservation_id, v_total, v_breakdown
    from public.create_reservation(p_space_id, p_customer_id, p_vehicle_id, p_start, p_end) cr;

  -- Fail closed if creation ever stops consuming exactly this authorization.
  if exists (select 1 from public.walk_in_authorizations a
              where a.backend_pid = pg_catalog.pg_backend_pid()
                and a.transaction_id = pg_catalog.pg_current_xact_id()) then
    raise exception 'WALK_IN_AUTHORIZATION_NOT_CONSUMED';
  end if;

  update public.reservations
     set status = 'active', checked_in_at = now(), checked_in_by = v_user_id
   where id = v_reservation_id;
  insert into public.audit_log (org_id, actor_id, action, target_table, target_id)
  values (v_org_id, v_user_id, 'check_in_walk_in', 'reservations', v_reservation_id);
  return query select v_reservation_id, v_total, v_breakdown;
end;
$$;
revoke all on function public.check_in_walk_in(uuid, uuid, uuid, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.check_in_walk_in(uuid, uuid, uuid, timestamptz, timestamptz)
  to authenticated, service_role;
