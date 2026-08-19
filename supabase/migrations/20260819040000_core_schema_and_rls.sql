-- ParkOS core schema + RLS
-- Follows ARCHITECTURE.md decisions exactly:
--   1. Shared-schema multi-tenancy: org_id on every tenant-scoped table; isolation via RLS.
--   2. timestamptz/UTC (created_at, archived_at). Facilities carry an IANA timezone string.
--   4. uuid PKs via gen_random_uuid().
--   5. archived_at soft deletes on tables with historical/referential significance.
--
-- NOTE on decision 1 vs. the `organizations` table: `organizations` is the tenant ROOT.
-- Its own `id` IS the tenant key, so it does not carry a separate self-referential `org_id`
-- (the task's explicit column list for organizations also omits it). Every OTHER table
-- carries `org_id uuid not null references organizations(id)`. RLS on organizations keys off
-- its own `id`; RLS on every other table keys off `org_id`.

-- ---------------------------------------------------------------------------
-- Enums (decision: proper enum types for role, space_type, status)
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'manager', 'attendant', 'customer', 'owner_viewer');
create type public.space_type as enum ('standard', 'compact', 'accessible', 'ev', 'oversized', 'motorcycle');
create type public.space_status as enum ('available', 'occupied', 'reserved', 'blocked', 'maintenance', 'permit_assigned');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Tenant root. Its `id` is the tenant key referenced by every other table's org_id.
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- One profile per user (PK = FK to auth.users). org_id is the user's org.
-- (memberships is the multi-org authorization table; profiles holds display identity.)
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  org_id     uuid not null references public.organizations(id),
  full_name  text,
  created_at timestamptz not null default now()
);

-- Authorization table. Every RLS policy resolves the caller's role from HERE,
-- but ONLY through the SECURITY DEFINER helpers below (never an inline subquery).
create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.app_role not null,
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create table public.facilities (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id),
  name            text not null,
  address         text,
  timezone        text not null default 'America/Los_Angeles',
  operating_hours jsonb,
  archived_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table public.zones (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id),
  facility_id uuid not null references public.facilities(id),
  name        text not null,
  level       int,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

create table public.spaces (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  zone_id      uuid not null references public.zones(id),
  space_number text not null,
  space_type   public.space_type not null default 'standard',
  status       public.space_status not null default 'available',
  archived_at  timestamptz,
  created_at   timestamptz not null default now()
);

create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id),
  full_name   text not null,
  email       text,
  phone       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

create table public.vehicles (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  customer_id   uuid references public.customers(id),
  license_plate text,
  make          text,
  model         text,
  color         text,
  year          int,
  vehicle_type  text,
  archived_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- Helpful indexes for the org_id predicate RLS relies on everywhere.
create index on public.profiles (org_id);
create index on public.memberships (org_id);
create index on public.memberships (user_id);
create index on public.facilities (org_id);
create index on public.zones (org_id);
create index on public.zones (facility_id);
create index on public.spaces (org_id);
create index on public.spaces (zone_id);
create index on public.customers (org_id);
create index on public.vehicles (org_id);
create index on public.vehicles (customer_id);

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helper functions  ***THE CRITICAL PART***
-- ---------------------------------------------------------------------------
--
-- WHY THESE MUST BE SECURITY DEFINER:
--   Every RLS policy needs to know "what role does the calling user have in org X?".
--   That answer lives in `memberships`. But `memberships` itself has RLS enabled. If a
--   policy answered the question with an INLINE subquery like
--       EXISTS (SELECT 1 FROM memberships WHERE user_id = auth.uid() AND ...)
--   then evaluating that subquery would re-invoke the RLS policy ON memberships, whose
--   own USING clause queries memberships again, which invokes the policy again... Postgres
--   detects this and aborts every such query with:
--       "infinite recursion detected in policy for relation \"memberships\"".
--   The result is that NOBODY can read memberships (or anything whose policy depends on it).
--
--   A SECURITY DEFINER function runs as its OWNER (postgres), and the table owner is exempt
--   from RLS. So when these helpers read `memberships`, RLS is NOT applied to that read --
--   the policy is never re-entered, and the recursion cannot occur. This is the standard,
--   supported Supabase pattern for role checks.
--
--   Because SECURITY DEFINER elevates privileges, an unset search_path would be a privilege-
--   escalation vector (a caller could create a `memberships` object in a schema earlier on
--   the search_path and hijack the lookup). We therefore LOCK search_path to '' and fully
--   schema-qualify every identifier (public.memberships, auth.uid()).
--
--   Marked STABLE: they only read, and within a single statement the result does not change,
--   which lets the planner cache the call across the rows a policy is evaluated over.
--
-- RULE for the rest of this file: NO policy may query `memberships` inline. Every policy
-- calls get_user_role() or has_any_role() and nothing else.

create or replace function public.get_user_role(check_org_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role::text
  from public.memberships m
  where m.org_id = check_org_id
    and m.user_id = auth.uid()
  limit 1
$$;

create or replace function public.has_any_role(check_org_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.role::text = any(allowed_roles)
  )
$$;

-- Definer functions run as owner regardless of caller, but callers still need EXECUTE.
revoke all on function public.get_user_role(uuid) from public;
revoke all on function public.has_any_role(uuid, text[]) from public;
grant execute on function public.get_user_role(uuid) to authenticated;
grant execute on function public.has_any_role(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Grants: let the `authenticated` role ATTEMPT access; RLS decides row-by-row.
-- (No grants to `anon` -- these tables are auth-only.)
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.organizations, public.profiles, public.memberships,
  public.facilities, public.zones, public.spaces,
  public.customers, public.vehicles
to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS on EVERY table. A table with RLS enabled and zero policies denies
-- ALL access by default -- that is intentional here for any INSERT/DELETE verb we
-- deliberately leave unpoliced (e.g. creating orgs, deleting audited rows), which is
-- then only reachable by the service role. Each table below gets its policies right
-- after RLS is enabled so no table is ever left enabled-but-empty by oversight.
-- ---------------------------------------------------------------------------

-- organizations: members see their own org; only admin updates it.
-- (No INSERT/DELETE policy -> org creation/removal is service-role only.)
alter table public.organizations enable row level security;
create policy organizations_select on public.organizations
  for select using (public.get_user_role(id) is not null);
create policy organizations_update on public.organizations
  for update using (public.has_any_role(id, array['admin']))
              with check (public.has_any_role(id, array['admin']));

-- memberships: members see memberships in their own org; only admin writes.
-- These policies call the helpers -> the recursion trap described above is avoided.
alter table public.memberships enable row level security;
create policy memberships_select on public.memberships
  for select using (public.get_user_role(org_id) is not null);
create policy memberships_insert on public.memberships
  for insert with check (public.has_any_role(org_id, array['admin']));
create policy memberships_update on public.memberships
  for update using (public.has_any_role(org_id, array['admin']))
              with check (public.has_any_role(org_id, array['admin']));
create policy memberships_delete on public.memberships
  for delete using (public.has_any_role(org_id, array['admin']));

-- profiles: NOT specified in the task's policy list, but RLS must be enabled and a
-- zero-policy table would lock every user out of their own name. Sensible minimum:
-- org members can read profiles in their org; a user manages only their OWN profile row.
-- FLAGGED for confirmation -- these are my defaults, not from the spec.
alter table public.profiles enable row level security;
create policy profiles_select on public.profiles
  for select using (public.get_user_role(org_id) is not null);
create policy profiles_insert_self on public.profiles
  for insert with check (id = auth.uid());
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- facilities / zones / spaces: all org members SELECT; only admin+manager write.
alter table public.facilities enable row level security;
create policy facilities_select on public.facilities
  for select using (public.get_user_role(org_id) is not null);
create policy facilities_insert on public.facilities
  for insert with check (public.has_any_role(org_id, array['admin','manager']));
create policy facilities_update on public.facilities
  for update using (public.has_any_role(org_id, array['admin','manager']))
              with check (public.has_any_role(org_id, array['admin','manager']));
create policy facilities_delete on public.facilities
  for delete using (public.has_any_role(org_id, array['admin','manager']));

alter table public.zones enable row level security;
create policy zones_select on public.zones
  for select using (public.get_user_role(org_id) is not null);
create policy zones_insert on public.zones
  for insert with check (public.has_any_role(org_id, array['admin','manager']));
create policy zones_update on public.zones
  for update using (public.has_any_role(org_id, array['admin','manager']))
              with check (public.has_any_role(org_id, array['admin','manager']));
create policy zones_delete on public.zones
  for delete using (public.has_any_role(org_id, array['admin','manager']));

alter table public.spaces enable row level security;
create policy spaces_select on public.spaces
  for select using (public.get_user_role(org_id) is not null);
create policy spaces_insert on public.spaces
  for insert with check (public.has_any_role(org_id, array['admin','manager']));
create policy spaces_update on public.spaces
  for update using (public.has_any_role(org_id, array['admin','manager']))
              with check (public.has_any_role(org_id, array['admin','manager']));
create policy spaces_delete on public.spaces
  for delete using (public.has_any_role(org_id, array['admin','manager']));

-- vehicles / customers: all org members SELECT; admin+manager+attendant INSERT/UPDATE.
-- (No DELETE policy -> deletes are service-role only; app uses archived_at instead.)
alter table public.vehicles enable row level security;
create policy vehicles_select on public.vehicles
  for select using (public.get_user_role(org_id) is not null);
create policy vehicles_insert on public.vehicles
  for insert with check (public.has_any_role(org_id, array['admin','manager','attendant']));
create policy vehicles_update on public.vehicles
  for update using (public.has_any_role(org_id, array['admin','manager','attendant']))
              with check (public.has_any_role(org_id, array['admin','manager','attendant']));

alter table public.customers enable row level security;
create policy customers_select on public.customers
  for select using (public.get_user_role(org_id) is not null);
create policy customers_insert on public.customers
  for insert with check (public.has_any_role(org_id, array['admin','manager','attendant']));
create policy customers_update on public.customers
  for update using (public.has_any_role(org_id, array['admin','manager','attendant']))
              with check (public.has_any_role(org_id, array['admin','manager','attendant']));
