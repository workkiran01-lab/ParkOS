-- ParkOS Week 7: customer-facing reservation flow.
-- Customers are authenticated users WITHOUT memberships: RLS keyed on
-- membership helpers returns nothing for them, so this migration adds
-- (a) an identity link customers.user_id, (b) additive self-service RLS,
-- and (c) SECURITY DEFINER wrappers for the reads/writes that must span
-- tables a non-member can never see. create_reservation, quote_reservation,
-- and find_available_spaces are untouched.

-- ---------------------------------------------------------------------------
-- customers.user_id: link a customer record to a login
-- ---------------------------------------------------------------------------

alter table public.customers
  add column user_id uuid references auth.users(id) on delete set null;

-- One customer record per person per operator; the same login may be a
-- customer of many different operators. Partial: walk-in customers created by
-- staff have no login and must not collide.
create unique index customers_org_id_user_id_key
  on public.customers (org_id, user_id)
  where user_id is not null;

create index customers_user_id_idx
  on public.customers (user_id)
  where user_id is not null;

-- Mirrors Week 4's profiles org_id lock, with one deliberate difference:
-- staff (admin/manager of the row's org) may still edit walk-in customer
-- records freely, including re-linking a login. Only non-staff callers —
-- i.e. the customer updating their own row via the self policies below —
-- are barred from moving the row to another org or another login.
create or replace function public.prevent_customer_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.org_id is distinct from old.org_id
      or new.user_id is distinct from old.user_id)
     and not public.has_any_role(old.org_id, array['admin','manager']) then
    raise exception using
      errcode = 'P0001',
      message = 'CUSTOMER_IDENTITY_IMMUTABLE';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_customer_identity_change() from public;

create trigger customers_prevent_identity_change
before update of org_id, user_id on public.customers
for each row
execute function public.prevent_customer_identity_change();

-- ---------------------------------------------------------------------------
-- is_own_customer: the customer-side analogue of get_user_role
-- ---------------------------------------------------------------------------

-- Deliberately NOT SECURITY DEFINER, unlike get_user_role/has_any_role. The
-- Week 2 trap was recursion: a policy ON memberships that itself queried
-- memberships would re-trigger its own policy forever, so those helpers must
-- bypass RLS. This helper has no such path: it reads customers but is only
-- ever called from policies on OTHER tables (vehicles, reservations,
-- space_holds), never from a policy back on customers itself. Running as
-- invoker, the customers_select_self policy below lets a customer see exactly
-- their own row — which is precisely the check being made.
create or replace function public.is_own_customer(check_customer_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.customers c
     where c.id = check_customer_id
       and c.user_id = auth.uid()
  );
$$;

revoke all on function public.is_own_customer(uuid) from public;
grant execute on function public.is_own_customer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Additive self-service RLS (the Week 2 org-member policies stay in force)
-- ---------------------------------------------------------------------------

create policy customers_select_self on public.customers
  for select using (user_id = auth.uid());
create policy customers_insert_self on public.customers
  for insert with check (user_id = auth.uid());
create policy customers_update_self on public.customers
  for update using (user_id = auth.uid())
             with check (user_id = auth.uid());

-- vehicles: the composite (org_id, customer_id) FK guarantees the vehicle's
-- org matches its customer's org, so ownership is the only check needed here.
create policy vehicles_select_own on public.vehicles
  for select using (public.is_own_customer(customer_id));
create policy vehicles_insert_own on public.vehicles
  for insert with check (public.is_own_customer(customer_id));
create policy vehicles_update_own on public.vehicles
  for update using (public.is_own_customer(customer_id))
             with check (public.is_own_customer(customer_id));

create policy reservations_select_own on public.reservations
  for select using (public.is_own_customer(customer_id));
create policy reservations_insert_own on public.reservations
  for insert with check (
    public.is_own_customer(customer_id) and status = 'pending'
  );

-- Customers may create holds only for their own reservations. Ownership is
-- resolved through reservations (whose own RLS the subquery obeys), NOT
-- through memberships — so there is no recursion risk.
create policy space_holds_insert_own on public.space_holds
  for insert with check (
    hold_type = 'reservation'
    and reservation_id is not null
    and exists (
      select 1
        from public.reservations r
       where r.id = reservation_id
         and public.is_own_customer(r.customer_id)
    )
  );

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER wrappers for the public booking flow
-- ---------------------------------------------------------------------------
-- WHY THESE MUST BE SECURITY DEFINER: a customer has no membership, so the
-- underlying reads on facilities/zones/spaces/price_rules return nothing under
-- their own privileges — RLS correctly hides operator internals from
-- non-members. Each wrapper therefore elevates, exposes only the minimum
-- fields a customer needs, and re-verifies in SQL what RLS would otherwise
-- have checked (facility is active, rows belong to the one facility asked
-- about, the customer record belongs to the caller).

-- Facility "storefront" card. Never returns org_id: tenant internals stay
-- server-side. anon may call it so the booking page renders before login.
create or replace function public.get_public_facility(p_facility_id uuid)
returns table (name text, address text, timezone text, operating_hours jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select f.name, f.address, f.timezone, f.operating_hours
    from public.facilities f
   where f.id = p_facility_id
     and f.archived_at is null;
$$;

-- Same overlap logic as find_available_spaces (which stays staff-only in
-- effect, since it returns setof spaces and runs as invoker), scoped strictly
-- to the facility asked about, projecting only customer-safe columns.
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
     and p_start is not null
     and p_end > p_start
     and not exists (
       select 1
         from public.space_holds h
        where h.space_id = s.id
          and h.released_at is null
          and h.during && tstzrange(p_start, p_end, '[)')
     )
   order by s.space_number;
$$;

-- quote_reservation is a pure read but runs as INVOKER: called directly by a
-- customer it sees no spaces/price_rules and raises SPACE_NOT_FOUND. This
-- wrapper elevates just enough to price a window, gated on the caller having
-- a customer record with the space's operator.
create or replace function public.public_quote_reservation(
  p_space_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select s.org_id into v_org_id
    from public.spaces s
   where s.id = p_space_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'SPACE_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.customers c
     where c.org_id = v_org_id
       and c.user_id = auth.uid()
       and c.archived_at is null
  ) then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_REQUIRED';
  end if;

  return public.quote_reservation(p_space_id, p_start, p_end);
end;
$$;

-- Resolves facility -> org server-side and guarantees a customers row for
-- (org, auth.uid()). This exists because the client CANNOT do the upsert
-- itself: get_public_facility intentionally hides org_id, and the self-insert
-- policy needs org_id to satisfy customers.org_id not null. Returns org_id so
-- follow-up self-service writes (vehicles) can include it; knowing an org's
-- uuid grants nothing by itself — every access path still checks membership
-- or ownership.
create or replace function public.public_ensure_customer(
  p_facility_id uuid,
  p_full_name text default null,
  p_email text default null,
  p_phone text default null
)
returns table (customer_id uuid, org_id uuid, full_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_customer public.customers%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select f.org_id into v_org_id
    from public.facilities f
   where f.id = p_facility_id
     and f.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'FACILITY_NOT_FOUND';
  end if;

  select * into v_customer
    from public.customers c
   where c.org_id = v_org_id
     and c.user_id = v_user_id;

  if found then
    return query select v_customer.id, v_customer.org_id, v_customer.full_name;
    return;
  end if;

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    -- Signals the UI to collect details before creating the record.
    raise exception using errcode = 'P0001', message = 'CUSTOMER_DETAILS_REQUIRED';
  end if;

  insert into public.customers (org_id, user_id, full_name, email, phone)
  values (
    v_org_id,
    v_user_id,
    trim(p_full_name),
    nullif(trim(coalesce(p_email, '')), ''),
    nullif(trim(coalesce(p_phone, '')), '')
  )
  on conflict (org_id, user_id) where user_id is not null do nothing;

  -- Re-read instead of RETURNING: a concurrent insert may have won the race.
  select * into v_customer
    from public.customers c
   where c.org_id = v_org_id
     and c.user_id = v_user_id;

  return query select v_customer.id, v_customer.org_id, v_customer.full_name;
end;
$$;

-- The booking write. Verifies everything RLS can't (the caller owns the
-- customer record, the space really belongs to the operator that record is
-- for, the vehicle really belongs to that customer), then delegates to the
-- proven create_reservation for pricing + reservation + hold.
--
-- INHERITANCE NOTE (non-obvious): create_reservation is declared SECURITY
-- INVOKER, but "invoker" here is whoever is executing THIS function's body —
-- and inside a SECURITY DEFINER function that is the function owner, not the
-- customer. The inner call therefore also runs elevated, which is exactly
-- what lets its reads (spaces/zones/customers/price_rules) and inserts
-- (reservations/space_holds) succeed for a non-member. That inheritance is
-- why every ownership check above MUST happen in this wrapper before the
-- delegation: past this point, nothing else will refuse.
create or replace function public.public_create_reservation(
  p_facility_id uuid,
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
  v_customer_org_id uuid;
  v_space_org_id uuid;
  v_space_facility_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select c.org_id into v_customer_org_id
    from public.customers c
   where c.id = p_customer_id
     and c.user_id = v_user_id
     and c.archived_at is null;

  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_NOT_OWNED';
  end if;

  select s.org_id, z.facility_id
    into v_space_org_id, v_space_facility_id
    from public.spaces s
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
   where s.id = p_space_id
     and s.archived_at is null
     and z.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'SPACE_NOT_FOUND';
  end if;

  if v_space_facility_id is distinct from p_facility_id then
    raise exception using errcode = 'P0001', message = 'SPACE_NOT_IN_FACILITY';
  end if;

  if v_space_org_id is distinct from v_customer_org_id then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_ORG_MISMATCH';
  end if;

  if p_vehicle_id is not null and not exists (
    select 1 from public.vehicles v
     where v.id = p_vehicle_id
       and v.customer_id = p_customer_id
       and v.org_id = v_customer_org_id
       and v.archived_at is null
  ) then
    raise exception using errcode = 'P0001', message = 'VEHICLE_NOT_OWNED';
  end if;

  return query
    select * from public.create_reservation(
      p_space_id, p_customer_id, p_vehicle_id, p_start, p_end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.get_public_facility(uuid) from public;
revoke all on function public.get_public_availability(uuid, timestamptz, timestamptz, public.space_type) from public;
revoke all on function public.public_quote_reservation(uuid, timestamptz, timestamptz) from public;
revoke all on function public.public_ensure_customer(uuid, text, text, text) from public;
revoke all on function public.public_create_reservation(uuid, uuid, uuid, uuid, timestamptz, timestamptz) from public;

grant execute on function public.get_public_facility(uuid) to anon, authenticated;
grant execute on function public.get_public_availability(uuid, timestamptz, timestamptz, public.space_type) to authenticated;
grant execute on function public.public_quote_reservation(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.public_ensure_customer(uuid, text, text, text) to authenticated;
grant execute on function public.public_create_reservation(uuid, uuid, uuid, uuid, timestamptz, timestamptz) to authenticated;
