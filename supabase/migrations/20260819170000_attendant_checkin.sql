-- ParkOS Week 10: attendant check-in / check-out.
-- Adds the physical-session columns and transitions (active/completed),
-- vehicle photo storage, and staff-only SECURITY DEFINER functions for
-- check-in, walk-in check-in, and check-out. create_reservation,
-- quote_reservation, and the Week 7/8/9 functions are NOT modified.

-- ---------------------------------------------------------------------------
-- Physical-session columns
-- ---------------------------------------------------------------------------

alter table public.reservations
  add column checked_in_at   timestamptz,
  add column checked_in_by   uuid references auth.users(id),
  add column checked_out_at  timestamptz,
  add column checked_out_by  uuid references auth.users(id);

-- ---------------------------------------------------------------------------
-- Reservation state machine — extended for physical check-in / check-out
-- ---------------------------------------------------------------------------
--
-- Legal status transitions (cumulative through Week 10):
--
--     FROM        ->  TO
--     ----------      ------------------------
--     pending     ->  confirmed        (manual staff confirm / Week 9 payment)
--     pending     ->  cancelled
--     pending     ->  no_show
--     pending     ->  active           (Week 10: walk-in checked in with no prior confirm)
--     confirmed   ->  cancelled
--     confirmed   ->  no_show
--     confirmed   ->  active           (Week 10: check-in)
--     active      ->  completed        (Week 10: check-out)
--
-- Everything else is ILLEGAL and raises, including:
--   * any transition FROM a terminal state (cancelled / no_show / completed)
--   * active -> anything except completed
--   * a same-status UPDATE that tries to touch the cancellation columns
--     without actually transitioning to 'cancelled'
--
-- A plain same-status UPDATE that leaves the cancellation columns alone is
-- still allowed (extend_reservation's reprice path).
create or replace function public.enforce_reservation_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending'   and new.status in ('confirmed','cancelled','no_show','active'))
      or (old.status = 'confirmed' and new.status in ('cancelled','no_show','active'))
      or (old.status = 'active'    and new.status = 'completed')
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'ILLEGAL_RESERVATION_TRANSITION: ' || old.status || ' -> ' || new.status;
    end if;
  else
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

-- ---------------------------------------------------------------------------
-- vehicle_photos + private storage bucket
-- ---------------------------------------------------------------------------

create table public.vehicle_photos (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id),
  reservation_id uuid not null references public.reservations(id),
  storage_path   text not null,
  uploaded_by    uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  constraint vehicle_photos_org_id_reservation_id_fkey
    foreign key (org_id, reservation_id)
    references public.reservations (org_id, id)
);

create index vehicle_photos_org_idx on public.vehicle_photos (org_id);
create index vehicle_photos_reservation_idx on public.vehicle_photos (reservation_id);

grant select, insert on public.vehicle_photos to authenticated;

alter table public.vehicle_photos enable row level security;
create policy vehicle_photos_select on public.vehicle_photos
  for select using (public.get_user_role(org_id) is not null);
create policy vehicle_photos_insert on public.vehicle_photos
  for insert with check (public.has_any_role(org_id, array['admin','manager','attendant']));

-- Private bucket. Objects are stored under an org_id/ prefix so a single set of
-- storage policies can tenant-scope every read and write by path.
insert into storage.buckets (id, name, public)
values ('vehicle-photos', 'vehicle-photos', false)
on conflict (id) do nothing;

-- Storage RLS: the first path segment is the owning org_id. Members of that org
-- may read; admin/manager/attendant of that org may write. A non-uuid first
-- segment fails the cast and is denied.
create policy "vehicle_photos_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vehicle-photos'
    and public.get_user_role(((storage.foldername(name))[1])::uuid) is not null
  );

create policy "vehicle_photos_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vehicle-photos'
    and public.has_any_role(
      ((storage.foldername(name))[1])::uuid,
      array['admin','manager','attendant']
    )
  );

-- ---------------------------------------------------------------------------
-- check_in_reservation — move an existing pending/confirmed booking to active
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER: staff update reservations via their member policies, but
-- routing through one elevated function keeps the status change + audit write
-- uniform with the rest of the lifecycle API.
create or replace function public.check_in_reservation(p_reservation_id uuid)
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

  if v_status not in ('pending','confirmed') then
    raise exception using errcode = 'P0001',
      message = 'CANNOT_CHECK_IN_FROM_' || upper(v_status::text);
  end if;

  update public.reservations
     set status = 'active',
         checked_in_at = now(),
         checked_in_by = v_user_id
   where id = p_reservation_id;

  insert into public.audit_log (org_id, actor_id, action, target_table, target_id)
  values (v_org_id, v_user_id, 'check_in_reservation', 'reservations', p_reservation_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- check_in_walk_in — create a reservation and immediately check it in
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER, staff-only. Delegates to create_reservation for pricing +
-- the reservation + the exclusion-protected hold (so a walk-in double-book
-- raises SPACE_UNAVAILABLE exactly like any other booking — that error is left
-- to propagate unchanged), then transitions pending -> active.
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

  -- SPACE_UNAVAILABLE from the hold's exclusion constraint propagates unchanged.
  select cr.reservation_id, cr.total_cents, cr.price_breakdown
    into v_reservation_id, v_total, v_breakdown
    from public.create_reservation(
      p_space_id, p_customer_id, p_vehicle_id, p_start, p_end) cr;

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

-- ---------------------------------------------------------------------------
-- check_out_reservation — complete an active session, add any overstay charge
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER, staff-only. Appends an overstay line item to the stored
-- breakdown (never discarding the original items), bumps the total, completes
-- the reservation, releases its hold, and audits.
create or replace function public.check_out_reservation(
  p_reservation_id uuid,
  p_overstay_cents integer default 0
)
returns table (final_total_cents integer, price_breakdown jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_status public.reservation_status;
  v_breakdown jsonb;
  v_total integer;
  v_final integer;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  if p_overstay_cents is null or p_overstay_cents < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_OVERSTAY_AMOUNT';
  end if;

  select r.org_id, r.status, r.price_breakdown, r.total_cents
    into v_org_id, v_status, v_breakdown, v_total
    from public.reservations r
   where r.id = p_reservation_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if not public.has_any_role(v_org_id, array['admin','manager','attendant']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  if v_status <> 'active' then
    raise exception using errcode = 'P0001',
      message = 'CANNOT_CHECK_OUT_FROM_' || upper(v_status::text);
  end if;

  if p_overstay_cents > 0 then
    v_breakdown := pg_catalog.jsonb_set(
      v_breakdown,
      '{line_items}',
      pg_catalog.coalesce(v_breakdown -> 'line_items', '[]'::jsonb)
        || pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object(
               'type', 'overstay',
               'description', 'Overstay charge',
               'subtotal_cents', p_overstay_cents
             )
           )
    );
    v_final := pg_catalog.coalesce((v_breakdown ->> 'total_cents')::integer, v_total)
               + p_overstay_cents;
    v_breakdown := pg_catalog.jsonb_set(
      v_breakdown, '{total_cents}', pg_catalog.to_jsonb(v_final));
  else
    v_final := v_total;
  end if;

  update public.reservations
     set status = 'completed',
         checked_out_at = now(),
         checked_out_by = v_user_id,
         total_cents = v_final,
         price_breakdown = v_breakdown
   where id = p_reservation_id;

  update public.space_holds
     set released_at = now()
   where reservation_id = p_reservation_id
     and released_at is null;

  insert into public.audit_log (org_id, actor_id, action, target_table, target_id, reason)
  values (v_org_id, v_user_id, 'check_out_reservation', 'reservations', p_reservation_id,
          case when p_overstay_cents > 0
               then 'overstay ' || p_overstay_cents || ' cents' end);

  return query select v_final, v_breakdown;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.check_in_reservation(uuid) from public;
revoke all on function public.check_in_walk_in(uuid, uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function public.check_out_reservation(uuid, integer) from public;

grant execute on function public.check_in_reservation(uuid) to authenticated;
grant execute on function public.check_in_walk_in(uuid, uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.check_out_reservation(uuid, integer) to authenticated;
