-- ParkOS Week 8: reservation lifecycle + manager override.
-- Adds cancellation columns, a state-machine trigger, an append-only audit
-- log, and SECURITY DEFINER lifecycle functions. create_reservation,
-- quote_reservation, find_available_spaces, and the Week 7 public_* wrappers
-- are NOT modified — everything here is built alongside them.

-- ---------------------------------------------------------------------------
-- Cancellation columns
-- ---------------------------------------------------------------------------

alter table public.reservations
  add column cancelled_at         timestamptz,
  add column cancelled_by         uuid references auth.users(id),
  add column cancellation_reason  text;

-- ---------------------------------------------------------------------------
-- Reservation state machine
-- ---------------------------------------------------------------------------
--
-- Legal status transitions (this week's scope):
--
--     FROM        ->  TO
--     ----------      ------------------------
--     pending     ->  confirmed        (manual staff confirm; real trigger = Week 9 payment)
--     pending     ->  cancelled
--     pending     ->  no_show
--     confirmed   ->  cancelled
--     confirmed   ->  no_show
--
-- Everything else is ILLEGAL and raises, including:
--   * any transition FROM a terminal state (cancelled / no_show / completed)
--   * pending/confirmed -> active/completed  (that is Week 10 physical check-in)
--   * a same-status UPDATE that tries to touch the cancellation columns
--     without actually transitioning to 'cancelled'
--
-- A plain same-status UPDATE that leaves the cancellation columns alone is
-- allowed: that is the path extend_reservation uses to rewrite
-- during/total_cents/price_breakdown without changing status.
create or replace function public.enforce_reservation_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending'   and new.status in ('confirmed','cancelled','no_show'))
      or (old.status = 'confirmed' and new.status in ('cancelled','no_show'))
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'ILLEGAL_RESERVATION_TRANSITION: ' || old.status || ' -> ' || new.status;
    end if;
  else
    -- Status unchanged: the cancellation columns belong exclusively to a
    -- ->cancelled transition (handled above), so they must not move here.
    if new.cancelled_at is distinct from old.cancelled_at
       or new.cancelled_by is distinct from old.cancelled_by
       or new.cancellation_reason is distinct from old.cancellation_reason then
      raise exception using
        errcode = 'P0001',
        message = 'ILLEGAL_RESERVATION_LIFECYCLE_EDIT';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_reservation_lifecycle() from public;

create trigger reservations_enforce_lifecycle
before update on public.reservations
for each row
execute function public.enforce_reservation_lifecycle();

-- ---------------------------------------------------------------------------
-- Append-only audit log
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  actor_id     uuid references auth.users(id),  -- null for automated (cron) actions
  action       text not null,
  target_table text not null,
  target_id    uuid,
  reason       text,
  created_at   timestamptz not null default now()
);

create index audit_log_org_created_idx on public.audit_log (org_id, created_at desc);

-- SELECT for admin/manager in their org. Deliberately NO insert/update/delete
-- policy and NO insert grant: the log is append-only from SECURITY DEFINER
-- functions (which run as the table owner and bypass both grant and RLS), so a
-- client can never forge, alter, or delete the record of what it did.
grant select on public.audit_log to authenticated;

alter table public.audit_log enable row level security;
create policy audit_log_select on public.audit_log
  for select using (public.has_any_role(org_id, array['admin','manager']));

-- ---------------------------------------------------------------------------
-- cancel_reservation
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER: a customer's Week 7 RLS grants only SELECT + INSERT on
-- reservations and INSERT on space_holds — no UPDATE on either. Cancelling
-- must write cancelled_by/cancelled_at on the reservation AND release the
-- hold, neither of which a customer can do under their own privileges. Staff
-- can update via their member policies, but routing both through one elevated
-- function keeps the audit write and hold release atomic and uniform.
create or replace function public.cancel_reservation(
  p_reservation_id uuid,
  p_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_customer_id uuid;
  v_status public.reservation_status;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select r.org_id, r.customer_id, r.status
    into v_org_id, v_customer_id, v_status
    from public.reservations r
   where r.id = p_reservation_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if not (public.is_own_customer(v_customer_id)
          or public.has_any_role(v_org_id, array['admin','manager','attendant'])) then
    raise exception using errcode = 'P0001', message = 'NOT_AUTHORIZED';
  end if;

  -- Early, clean error; the lifecycle trigger also enforces this.
  if v_status not in ('pending','confirmed') then
    raise exception using errcode = 'P0001',
      message = 'CANNOT_CANCEL_FROM_' || upper(v_status::text);
  end if;

  update public.reservations
     set status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = v_user_id,
         cancellation_reason = p_reason
   where id = p_reservation_id;

  update public.space_holds
     set released_at = now()
   where reservation_id = p_reservation_id
     and released_at is null;

  insert into public.audit_log (org_id, actor_id, action, target_table, target_id, reason)
  values (v_org_id, v_user_id, 'cancel_reservation', 'reservations', p_reservation_id, p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- extend_reservation
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER for the same reason as cancel: customers cannot UPDATE the
-- reservation or its hold. Re-quotes the FULL window (original start -> new
-- end) and widens the hold in the same transaction; if widening collides with
-- another active hold the exclusion_violation is re-raised as SPACE_UNAVAILABLE
-- and BOTH writes roll back, so the reservation is never left repriced for a
-- window it could not actually hold.
create or replace function public.extend_reservation(
  p_reservation_id uuid,
  p_new_end timestamptz
)
returns table (total_cents integer, price_breakdown jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_customer_id uuid;
  v_space_id uuid;
  v_status public.reservation_status;
  v_during tstzrange;
  v_start timestamptz;
  v_quote jsonb;
  v_total integer;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select r.org_id, r.customer_id, r.space_id, r.status, r.during
    into v_org_id, v_customer_id, v_space_id, v_status, v_during
    from public.reservations r
   where r.id = p_reservation_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if not (public.is_own_customer(v_customer_id)
          or public.has_any_role(v_org_id, array['admin','manager','attendant'])) then
    raise exception using errcode = 'P0001', message = 'NOT_AUTHORIZED';
  end if;

  if v_status not in ('pending','confirmed') then
    raise exception using errcode = 'P0001',
      message = 'CANNOT_EXTEND_FROM_' || upper(v_status::text);
  end if;

  v_start := lower(v_during);
  if p_new_end <= upper(v_during) then
    raise exception using errcode = 'P0001', message = 'NEW_END_NOT_LATER';
  end if;

  -- Re-price the whole reservation for its new full span.
  v_quote := public.quote_reservation(v_space_id, v_start, p_new_end);
  v_total := (v_quote ->> 'total_cents')::integer;

  begin
    update public.reservations
       set during = tstzrange(v_start, p_new_end, '[)'),
           total_cents = v_total,
           price_breakdown = v_quote,
           currency = v_quote ->> 'currency'
     where id = p_reservation_id;

    update public.space_holds
       set during = tstzrange(v_start, p_new_end, '[)')
     where reservation_id = p_reservation_id
       and released_at is null
       and hold_type = 'reservation';

    -- Both updates share one savepoint: a conflict on the hold widen rolls
    -- back the reservation reprice too before we re-raise.
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'SPACE_UNAVAILABLE';
  end;

  return query select v_total, v_quote;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_reservation (manual staff confirm; Week 9 payment automates this)
-- ---------------------------------------------------------------------------

create or replace function public.confirm_reservation(p_reservation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_status public.reservation_status;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select r.org_id, r.status into v_org_id, v_status
    from public.reservations r
   where r.id = p_reservation_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if not public.has_any_role(v_org_id, array['admin','manager','attendant']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  if v_status <> 'pending' then
    raise exception using errcode = 'P0001',
      message = 'CANNOT_CONFIRM_FROM_' || upper(v_status::text);
  end if;

  update public.reservations set status = 'confirmed' where id = p_reservation_id;

  insert into public.audit_log (org_id, actor_id, action, target_table, target_id)
  values (v_org_id, v_user_id, 'confirm_reservation', 'reservations', p_reservation_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_no_shows
-- ---------------------------------------------------------------------------

-- Marks pending/confirmed reservations whose start + grace has passed as
-- no_show, releases each hold, and writes one 'auto_no_show' audit row per
-- reservation. Two callers:
--   * p_org_id NOT null  -> staff-triggerable; caller must be admin/manager
--     of that org (the "Run sweep now" button).
--   * p_org_id null      -> scan ALL orgs; cron/service-role ONLY. Gated below
--     on the caller NOT being an end user (authenticated). Execute is granted
--     to authenticated for the org path and to service_role for the global
--     path; the internal check is what actually splits them.
create or replace function public.mark_no_shows(
  p_org_id uuid default null,
  p_grace_minutes int default 15
)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count int := 0;
  r record;
begin
  if p_org_id is null then
    -- auth.role() is 'authenticated' for end users, 'service_role' for the
    -- service key, and null for pg_cron (no request JWT). Only the latter two
    -- may sweep every org.
    if auth.role() = 'authenticated' then
      raise exception using errcode = 'P0001',
        message = 'GLOBAL_SWEEP_REQUIRES_SERVICE_ROLE';
    end if;
  else
    if not public.has_any_role(p_org_id, array['admin','manager']) then
      raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
    end if;
  end if;

  for r in
    select res.id, res.org_id
      from public.reservations res
     where res.status in ('pending','confirmed')
       and (p_org_id is null or res.org_id = p_org_id)
       and lower(res.during) + make_interval(mins => p_grace_minutes) < now()
  loop
    update public.reservations set status = 'no_show' where id = r.id;

    update public.space_holds
       set released_at = now()
     where reservation_id = r.id
       and released_at is null;

    insert into public.audit_log (org_id, actor_id, action, target_table, target_id, reason)
    values (r.org_id, auth.uid(), 'auto_no_show', 'reservations', r.id,
            'grace ' || p_grace_minutes || ' min elapsed');

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_my_reservations: the customer's history WITH space/facility labels
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER so it can join spaces/zones/facilities (all RLS-hidden from
-- a non-member customer) to return the space_number and facility name their
-- own reservations RLS alone cannot surface. Scoped strictly to rows the
-- caller owns via is_own_customer — it exposes nothing beyond the caller's own
-- bookings, across every operator they have booked with.
create or replace function public.get_my_reservations()
returns table (
  reservation_id uuid,
  facility_id uuid,
  facility_name text,
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
  select r.id, z.facility_id, f.name, s.id, s.space_number, z.name,
         r.during, r.status, r.total_cents, r.currency, r.created_at
    from public.reservations r
    join public.spaces s on s.id = r.space_id
    join public.zones z on z.id = s.zone_id
    join public.facilities f on f.id = z.facility_id
   where public.is_own_customer(r.customer_id)
   order by r.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.cancel_reservation(uuid, text) from public;
revoke all on function public.extend_reservation(uuid, timestamptz) from public;
revoke all on function public.confirm_reservation(uuid) from public;
revoke all on function public.mark_no_shows(uuid, int) from public;
revoke all on function public.get_my_reservations() from public;

grant execute on function public.cancel_reservation(uuid, text) to authenticated;
grant execute on function public.extend_reservation(uuid, timestamptz) to authenticated;
grant execute on function public.confirm_reservation(uuid) to authenticated;
grant execute on function public.mark_no_shows(uuid, int) to authenticated, service_role;
grant execute on function public.get_my_reservations() to authenticated;

-- ---------------------------------------------------------------------------
-- Best-effort pg_cron schedule for the global no-show sweep (every 5 min).
-- Wrapped so absence of pg_cron on this tier is a NOTICE, not a failed
-- migration. Whether it actually scheduled is verified after push.
-- ---------------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('parkos-no-show-sweep', '*/5 * * * *',
                        'select public.mark_no_shows()');
  raise notice 'PARKOS: pg_cron no-show sweep scheduled every 5 minutes';
exception
  when others then
    raise notice 'PARKOS: pg_cron scheduling skipped (%): %', sqlstate, sqlerrm;
end $$;
