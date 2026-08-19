-- DEV-ONLY manual seed for parkos-dev. Run with the Supabase CLI's file-query
-- command; this file deliberately lives outside migrations and must never be pushed.
-- Creates two isolated fake orgs so cross-org RLS
-- isolation can be PROVEN (see supabase/tests/rls_isolation_checks.sql), not assumed.
-- Do NOT apply this migration to a production project: it inserts fake auth.users.
--
-- Fixed UUIDs (so the isolation test script can reference them):
--   Org A  (Harbor Park Group) : aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
--   Org B  (Pier Point Parking): bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
--   Org A admin  user          : 00000000-0000-0000-0000-0000000000a1  (admin@harborpark.dev)
--   Org A manager               : 00000000-0000-0000-0000-0000000000a2
--   Org A attendants (x4)       : ...a3 / ...a4 / ...a5 / ...a6
--   Org B admin  user          : 00000000-0000-0000-0000-0000000000b1  (admin@pierpoint.dev)
--
-- Expected row counts after seeding (verification targets):
--   Org A: 2 facilities, 4 zones, 165 spaces (120 Lot A + 45 Lot B); 6 memberships
--          spaces: 8 ev, 4 accessible, 40 permit_assigned (Lot A L3), rest standard/available
--   Org B: 1 facility, 1 zone, 10 spaces; 1 membership

-- ---- fake auth users (dev only) --------------------------------------------
insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password,
   email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'admin@harborpark.dev',    '$2a$10$devseedhashdevseedhashdevseedhashdevseedhashdev', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000a2', 'authenticated', 'authenticated', 'manager@harborpark.dev',  '$2a$10$devseedhashdevseedhashdevseedhashdevseedhashdev', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000a3', 'authenticated', 'authenticated', 'att1@harborpark.dev',     '$2a$10$devseedhashdevseedhashdevseedhashdevseedhashdev', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000a4', 'authenticated', 'authenticated', 'att2@harborpark.dev',     '$2a$10$devseedhashdevseedhashdevseedhashdevseedhashdev', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000a5', 'authenticated', 'authenticated', 'att3@harborpark.dev',     '$2a$10$devseedhashdevseedhashdevseedhashdevseedhashdev', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000a6', 'authenticated', 'authenticated', 'att4@harborpark.dev',     '$2a$10$devseedhashdevseedhashdevseedhashdevseedhashdev', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000b1', 'authenticated', 'authenticated', 'admin@pierpoint.dev',     '$2a$10$devseedhashdevseedhashdevseedhashdevseedhashdev', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}')
on conflict (id) do nothing;

-- ---- organizations ---------------------------------------------------------
insert into public.organizations (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Harbor Park Group'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Pier Point Parking')
on conflict (id) do nothing;

-- ---- profiles --------------------------------------------------------------
insert into public.profiles (id, org_id, full_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Harbor Owner'),
  ('00000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Harbor Manager'),
  ('00000000-0000-0000-0000-0000000000a3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Attendant One'),
  ('00000000-0000-0000-0000-0000000000a4', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Attendant Two'),
  ('00000000-0000-0000-0000-0000000000a5', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Attendant Three'),
  ('00000000-0000-0000-0000-0000000000a6', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Attendant Four'),
  ('00000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Pier Point Owner')
on conflict (id) do nothing;

-- ---- memberships (the table RLS checks) ------------------------------------
insert into public.memberships (org_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-0000000000a2', 'manager'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-0000000000a3', 'attendant'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-0000000000a4', 'attendant'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-0000000000a5', 'attendant'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-0000000000a6', 'attendant'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-0000000000b1', 'admin')
on conflict (org_id, user_id) do nothing;

-- ---- Org A facilities: Harbor Park Group, 2 lots in Long Beach --------------
insert into public.facilities (id, org_id, name, address, timezone, operating_hours) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Lot A', '100 Harbor Plaza, Long Beach, CA', 'America/Los_Angeles',
   '{"type":"24/7","gated":true,"attendant_booth":true}'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Lot B', '250 Shoreline Dr, Long Beach, CA', 'America/Los_Angeles',
   '{"type":"daily","open":"06:00","close":"22:00","attended":false}')
on conflict (id) do nothing;

-- ---- Org A zones -----------------------------------------------------------
insert into public.zones (id, org_id, facility_id, name, level) values
  ('a1a1a1a1-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Level 1', 1),
  ('a1a1a1a1-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Level 2', 2),
  ('a1a1a1a1-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Level 3', 3),
  ('b1b1b1b1-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Surface', 1)
on conflict (id) do nothing;

-- ---- Org A spaces ----------------------------------------------------------
-- Lot A Level 1 (40): 8 EV + 4 accessible + 28 standard, all available.
insert into public.spaces (org_id, zone_id, space_number, space_type, status)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-0000-0000-0000-000000000001',
       'L1-' || lpad(n::text, 3, '0'),
       (case when n <= 8 then 'ev' when n <= 12 then 'accessible' else 'standard' end)::public.space_type,
       'available'::public.space_status
from generate_series(1, 40) as n;

-- Lot A Level 2 (40): standard, available.
insert into public.spaces (org_id, zone_id, space_number, space_type, status)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-0000-0000-0000-000000000002',
       'L2-' || lpad(n::text, 3, '0'), 'standard'::public.space_type, 'available'::public.space_status
from generate_series(1, 40) as n;

-- Lot A Level 3 (40): the 40 monthly permit holders -> status permit_assigned.
insert into public.spaces (org_id, zone_id, space_number, space_type, status)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-0000-0000-0000-000000000003',
       'L3-' || lpad(n::text, 3, '0'), 'standard'::public.space_type, 'permit_assigned'::public.space_status
from generate_series(1, 40) as n;

-- Lot B surface (45): standard, available.
insert into public.spaces (org_id, zone_id, space_number, space_type, status)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'b1b1b1b1-0000-0000-0000-000000000001',
       'B-' || lpad(n::text, 3, '0'), 'standard'::public.space_type, 'available'::public.space_status
from generate_series(1, 45) as n;

-- ---- A couple of Org A customers + vehicles (exercise those tables) ---------
insert into public.customers (id, org_id, full_name, email, phone) values
  ('ca000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Dana Rivera', 'dana@example.com', '562-555-0101'),
  ('ca000002-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Sam Cho', 'sam@example.com', '562-555-0102')
on conflict (id) do nothing;

insert into public.vehicles (org_id, customer_id, license_plate, make, model, color, year, vehicle_type) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ca000001-0000-0000-0000-000000000001', '8ABC123', 'Toyota', 'Camry', 'Silver', 2021, 'sedan'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ca000002-0000-0000-0000-000000000002', '7XYZ890', 'Ford', 'F-150', 'Blue', 2019, 'truck');

-- ---- Org B: smaller org, 1 facility, 10 spaces (isolation counterpart) ------
insert into public.facilities (id, org_id, name, address, timezone, operating_hours) values
  ('33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'Pier Point Lot', '9 Ocean Ave, Santa Monica, CA', 'America/Los_Angeles',
   '{"type":"daily","open":"08:00","close":"20:00"}')
on conflict (id) do nothing;

insert into public.zones (id, org_id, facility_id, name, level) values
  ('c1c1c1c1-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'Surface', 1)
on conflict (id) do nothing;

insert into public.spaces (org_id, zone_id, space_number, space_type, status)
select 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'c1c1c1c1-0000-0000-0000-000000000001',
       'P-' || lpad(n::text, 3, '0'), 'standard'::public.space_type, 'available'::public.space_status
from generate_series(1, 10) as n;
