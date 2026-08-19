-- ParkOS Week 3: concurrency-safe reservation core
-- Follows ARCHITECTURE.md: shared-schema tenancy, UTC timestamptz values,
-- integer cents + currency + JSONB price breakdowns, UUID PKs, and soft deletes.

-- ---------------------------------------------------------------------------
-- Extension and enums
-- ---------------------------------------------------------------------------

create extension if not exists btree_gist;

create type public.hold_type as enum ('reservation', 'permit', 'maintenance', 'block');
create type public.reservation_status as enum (
  'pending', 'confirmed', 'active', 'completed', 'cancelled', 'no_show'
);
create type public.permit_status as enum ('active', 'suspended', 'cancelled');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.reservations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id),
  facility_id     uuid not null references public.facilities(id),
  space_id        uuid not null references public.spaces(id),
  customer_id     uuid not null references public.customers(id),
  vehicle_id      uuid references public.vehicles(id),
  during          tstzrange not null,
  status          public.reservation_status not null default 'pending',
  price_breakdown jsonb not null,
  total_cents     integer not null check (total_cents >= 0),
  currency        text not null default 'USD' check (char_length(currency) = 3),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  check (not isempty(during))
);

create table public.permits (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id),
  facility_id        uuid not null references public.facilities(id),
  space_id           uuid not null references public.spaces(id),
  customer_id        uuid not null references public.customers(id),
  during             tstzrange not null,
  monthly_rate_cents integer not null check (monthly_rate_cents >= 0),
  currency           text not null default 'USD' check (char_length(currency) = 3),
  status             public.permit_status not null default 'active',
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  check (not isempty(during))
);

create table public.price_rules (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id),
  facility_id       uuid not null references public.facilities(id),
  zone_id           uuid references public.zones(id),
  space_type        public.space_type,
  hourly_rate_cents integer not null check (hourly_rate_cents >= 0),
  daily_cap_cents   integer check (daily_cap_cents is null or daily_cap_cents >= 0),
  currency          text not null default 'USD' check (char_length(currency) = 3),
  priority          integer not null default 0,
  archived_at       timestamptz,
  created_at        timestamptz not null default now()
);

create table public.space_holds (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id),
  space_id       uuid not null references public.spaces(id),
  hold_type      public.hold_type not null,
  during         tstzrange not null,
  reservation_id uuid references public.reservations(id),
  permit_id      uuid references public.permits(id),
  released_at    timestamptz,
  created_at     timestamptz not null default now(),
  check (not isempty(during)),
  check (
    (hold_type = 'reservation' and reservation_id is not null and permit_id is null)
    or (hold_type = 'permit' and permit_id is not null and reservation_id is null)
    or (hold_type in ('maintenance', 'block') and reservation_id is null and permit_id is null)
  )
);

-- btree_gist is required because the UUID equality check inside this GiST index
-- needs the UUID operator class it provides; plain GiST has no UUID equality
-- operator class. The partial predicate is equally important: without
-- `released_at is null`, an old hold from a cancelled reservation would keep
-- blocking that space and time window forever. This database constraint makes
-- double-booking mechanically impossible regardless of application behavior.
alter table public.space_holds
  add constraint space_holds_no_overlap
  exclude using gist (
    space_id with =,
    during with &&
  ) where (released_at is null);

-- Tenant and relationship indexes support RLS predicates, joins, and cleanup.
create index on public.reservations (org_id);
create index on public.reservations (facility_id);
create index on public.reservations (space_id);
create index on public.reservations (customer_id);
create index on public.reservations (vehicle_id);
create index on public.permits (org_id);
create index on public.permits (facility_id);
create index on public.permits (space_id);
create index on public.permits (customer_id);
create index on public.price_rules (org_id);
create index on public.price_rules (facility_id, zone_id, space_type, priority desc)
  where archived_at is null;
create index on public.space_holds (org_id);
create index on public.space_holds (reservation_id);
create index on public.space_holds (permit_id);

-- ---------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------

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
    raise exception using errcode = '22007', message = 'INVALID_RESERVATION_WINDOW';
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

-- ---------------------------------------------------------------------------
-- Atomic reservation creation
-- ---------------------------------------------------------------------------

create or replace function public.create_reservation(
  p_space_id uuid,
  p_customer_id uuid,
  p_vehicle_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns table (
  reservation_id uuid,
  total_cents integer,
  price_breakdown jsonb
)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_facility_id uuid;
  v_reservation_id uuid;
  v_price_breakdown jsonb;
  v_total_cents integer;
  v_currency text;
begin
  select s.org_id, z.facility_id
    into v_org_id, v_facility_id
    from public.spaces s
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
   where s.id = p_space_id
     and s.archived_at is null
     and z.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'SPACE_NOT_FOUND';
  end if;

  -- RLS makes foreign-tenant rows invisible; these checks also prevent a caller
  -- from attaching a reservation to a same-tenant customer/vehicle mismatch.
  if not exists (
    select 1 from public.customers c
     where c.id = p_customer_id and c.org_id = v_org_id and c.archived_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;

  if p_vehicle_id is not null and not exists (
    select 1 from public.vehicles v
     where v.id = p_vehicle_id
       and v.org_id = v_org_id
       and v.customer_id = p_customer_id
       and v.archived_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'VEHICLE_NOT_FOUND';
  end if;

  v_price_breakdown := public.quote_reservation(p_space_id, p_start, p_end);
  v_total_cents := (v_price_breakdown ->> 'total_cents')::integer;
  v_currency := v_price_breakdown ->> 'currency';

  begin
    insert into public.reservations (
      org_id, facility_id, space_id, customer_id, vehicle_id, during,
      status, price_breakdown, total_cents, currency
    ) values (
      v_org_id, v_facility_id, p_space_id, p_customer_id, p_vehicle_id,
      tstzrange(p_start, p_end, '[)'), 'pending', v_price_breakdown,
      v_total_cents, v_currency
    )
    returning id into v_reservation_id;

    insert into public.space_holds (
      org_id, space_id, hold_type, during, reservation_id
    ) values (
      v_org_id, p_space_id, 'reservation', tstzrange(p_start, p_end, '[)'),
      v_reservation_id
    );

    -- Both inserts are one atomic function call. If the hold conflicts, this
    -- exception block rolls back its reservation insert before re-raising.
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'SPACE_UNAVAILABLE';
  end;

  return query select v_reservation_id, v_total_cents, v_price_breakdown;
end;
$$;

revoke all on function public.quote_reservation(uuid, timestamptz, timestamptz) from public;
revoke all on function public.create_reservation(uuid, uuid, uuid, timestamptz, timestamptz) from public;
grant execute on function public.quote_reservation(uuid, timestamptz, timestamptz)
  to authenticated, service_role;
grant execute on function public.create_reservation(uuid, uuid, uuid, timestamptz, timestamptz)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Grants and RLS (membership checks use only Week 2's SECURITY DEFINER helpers)
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on
  public.reservations, public.permits, public.price_rules, public.space_holds
to authenticated;

alter table public.reservations enable row level security;
create policy reservations_select on public.reservations
  for select using (public.get_user_role(org_id) is not null);
create policy reservations_insert on public.reservations
  for insert with check (
    public.has_any_role(org_id, array['admin','manager','attendant'])
  );

alter table public.space_holds enable row level security;
create policy space_holds_select on public.space_holds
  for select using (public.get_user_role(org_id) is not null);
create policy space_holds_insert on public.space_holds
  for insert with check (
    public.has_any_role(org_id, array['admin','manager','attendant'])
  );

alter table public.permits enable row level security;
create policy permits_select on public.permits
  for select using (public.get_user_role(org_id) is not null);
create policy permits_insert on public.permits
  for insert with check (public.has_any_role(org_id, array['admin','manager']));

alter table public.price_rules enable row level security;
create policy price_rules_select on public.price_rules
  for select using (public.get_user_role(org_id) is not null);
create policy price_rules_insert on public.price_rules
  for insert with check (public.has_any_role(org_id, array['admin','manager']));
