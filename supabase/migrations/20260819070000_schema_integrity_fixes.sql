-- ParkOS schema integrity corrections
-- Reconciles Week 2/3 with ARCHITECTURE.md soft-delete and tenant-isolation rules.

-- ---------------------------------------------------------------------------
-- Soft deletes
-- ---------------------------------------------------------------------------

-- Historically significant parking records are archived through UPDATE.
-- With no DELETE policy, only the service role can hard-delete them.
drop policy if exists facilities_delete on public.facilities;
drop policy if exists zones_delete on public.zones;
drop policy if exists spaces_delete on public.spaces;

alter table public.profiles
  add column archived_at timestamptz;

-- ---------------------------------------------------------------------------
-- Tenant-safe foreign keys
-- ---------------------------------------------------------------------------

-- `organizations` is the tenant root: its primary key `id` is the tenant key,
-- so it deliberately has no self-referential org_id. Composite parent keys are
-- required on the tenant-scoped tables referenced below.
alter table public.facilities
  add constraint facilities_org_id_id_key unique (org_id, id);
alter table public.zones
  add constraint zones_org_id_id_key unique (org_id, id);
alter table public.customers
  add constraint customers_org_id_id_key unique (org_id, id);
alter table public.spaces
  add constraint spaces_org_id_id_key unique (org_id, id);

-- Replace ID-only foreign keys with composite keys. A child can no longer carry
-- one org_id while pointing at a parent row belonging to another organization.
alter table public.zones
  drop constraint zones_facility_id_fkey,
  add constraint zones_org_id_facility_id_fkey
    foreign key (org_id, facility_id)
    references public.facilities (org_id, id);

alter table public.spaces
  drop constraint spaces_zone_id_fkey,
  add constraint spaces_org_id_zone_id_fkey
    foreign key (org_id, zone_id)
    references public.zones (org_id, id);

alter table public.vehicles
  drop constraint vehicles_customer_id_fkey,
  add constraint vehicles_org_id_customer_id_fkey
    foreign key (org_id, customer_id)
    references public.customers (org_id, id);

alter table public.reservations
  drop constraint reservations_space_id_fkey,
  drop constraint reservations_customer_id_fkey,
  add constraint reservations_org_id_space_id_fkey
    foreign key (org_id, space_id)
    references public.spaces (org_id, id),
  add constraint reservations_org_id_customer_id_fkey
    foreign key (org_id, customer_id)
    references public.customers (org_id, id);

alter table public.permits
  drop constraint permits_space_id_fkey,
  drop constraint permits_customer_id_fkey,
  add constraint permits_org_id_space_id_fkey
    foreign key (org_id, space_id)
    references public.spaces (org_id, id),
  add constraint permits_org_id_customer_id_fkey
    foreign key (org_id, customer_id)
    references public.customers (org_id, id);

alter table public.space_holds
  drop constraint space_holds_space_id_fkey,
  add constraint space_holds_org_id_space_id_fkey
    foreign key (org_id, space_id)
    references public.spaces (org_id, id);

-- ---------------------------------------------------------------------------
-- Profile tenant immutability
-- ---------------------------------------------------------------------------

create or replace function public.prevent_profile_org_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception using
      errcode = 'P0001',
      message = 'PROFILE_ORG_ID_IMMUTABLE';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_profile_org_id_change() from public;

create trigger profiles_prevent_org_id_change
before update of org_id on public.profiles
for each row
execute function public.prevent_profile_org_id_change();
