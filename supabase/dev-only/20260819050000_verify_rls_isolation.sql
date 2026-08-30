-- DEV-ONLY manual RLS isolation verification (assertion-only; changes no schema or data).
-- Companion to supabase/tests/rls_isolation_checks.sql (the interactive SQL-editor
-- version). Run this manually against parkos-dev after policy changes. Every block
-- RAISES EXCEPTION on failure, so a failed check aborts execution with its message.
--
-- Depends on the dev seed (DEV_ONLY_seed_dev_orgs.sql); like the seed, dev-project only.
-- Every check runs inside one transaction that is unconditionally rolled back;
-- the final summary runs afterwards so the Management API returns visible proof.

begin;

-- ---------------------------------------------------------------------------
-- CHECK 0: the DDL actually landed — 20 RLS-enabled tables, 59 policies,
-- all authorization/bootstrap/lifecycle functions present and SECURITY DEFINER.
-- ---------------------------------------------------------------------------
do $$
declare v int;
begin
  select count(*) into v from pg_tables
   where schemaname = 'public' and rowsecurity
     and tablename in ('organizations','profiles','memberships','facilities',
                       'zones','spaces','customers','vehicles','reservations',
                       'permits','price_rules','space_holds','invites','audit_log',
                       'payments','processed_stripe_events','vehicle_photos',
                       'booth_payments','receipts','account_status');
  if v <> 20 then
    raise exception 'CHECK0 FAIL: expected 20 RLS-enabled tables, found %', v;
  end if;

  -- 36 through Week 4, +1 in Week 5 (space_holds_update for release-early),
  -- +1 in Week 6 (price_rules_update), +9 in Week 7 (customer self-service:
  -- customers x3, vehicles x3, reservations x2, space_holds insert x1),
  -- +1 in Week 8 (audit_log_select), +2 in Week 9 (payments SELECT for
  -- members and owners; processed_stripe_events intentionally has none),
  -- +2 in Week 10 (vehicle_photos SELECT for members, INSERT for staff),
  -- +2 in Week 12 (permit own SELECT and staff UPDATE),
  -- +3 for account deactivation (account_status), which this count had drifted
  -- behind, and +2 for booth_payments (SELECT for members, SELECT for owners).
  select count(*) into v from pg_policies where schemaname = 'public';
  if v <> 59 then
    raise exception 'CHECK0 FAIL: expected 59 policies, found %', v;
  end if;

  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('get_user_role','has_any_role',
                       'create_organization_with_admin','accept_invite',
                       'create_facility_with_zones_and_spaces',
                       'get_public_facility','get_public_availability',
                       'public_quote_reservation','public_ensure_customer',
                       'public_create_reservation',
                       'cancel_reservation','extend_reservation',
                       'confirm_reservation','mark_no_shows','get_my_reservations',
                       'process_stripe_event',
                       'check_in_reservation','check_in_walk_in','check_out_reservation',
                       'issue_permit','cancel_permit','get_my_permits',
                       'process_stripe_subscription_event')
      and p.prosecdef;
  if v <> 23 then
    raise exception 'CHECK0 FAIL: helper functions missing or not SECURITY DEFINER (found %)', v;
  end if;

  -- is_own_customer must stay SECURITY INVOKER: it is safe from recursion only
  -- because it is never called from a policy on customers itself.
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'is_own_customer' and not p.prosecdef;
  if v <> 1 then
    raise exception 'CHECK0 FAIL: is_own_customer missing or wrongly SECURITY DEFINER';
  end if;
  raise notice 'CHECK0 PASS: 20 RLS tables, 59 policies, 23 SECURITY DEFINER functions';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 0c: Week 9 payment grants/policies. Authenticated callers may SELECT
-- rows allowed by RLS but have no INSERT/UPDATE/DELETE grant and no write
-- policy (including an ALL policy). service_role has the DML grants used by
-- checkout/webhook handlers. processed_stripe_events is service-role-only.
-- ---------------------------------------------------------------------------
do $$
declare v int;
begin
  select count(*) into v
    from pg_policies
   where schemaname = 'public'
     and tablename = 'payments'
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if v <> 0 then
    raise exception 'CHECK0c FAIL: payments has % write-capable policies', v;
  end if;

  select count(*) into v
    from pg_policies
   where schemaname = 'public'
     and tablename = 'payments'
     and cmd = 'SELECT';
  if v <> 2 then
    raise exception 'CHECK0c FAIL: payments has % SELECT policies, expected 2', v;
  end if;

  select count(*) into v
    from pg_policies
   where schemaname = 'public'
     and tablename = 'processed_stripe_events';
  if v <> 0 then
    raise exception 'CHECK0c FAIL: processed_stripe_events unexpectedly has % policies', v;
  end if;

  if not has_table_privilege('authenticated', 'public.payments', 'SELECT') then
    raise exception 'CHECK0c FAIL: authenticated lacks SELECT on payments';
  end if;
  if has_table_privilege('authenticated', 'public.payments', 'INSERT')
     or has_table_privilege('authenticated', 'public.payments', 'UPDATE')
     or has_table_privilege('authenticated', 'public.payments', 'DELETE') then
    raise exception 'CHECK0c FAIL: authenticated has payment DML privileges';
  end if;
  if has_table_privilege('authenticated', 'public.processed_stripe_events', 'SELECT')
     or has_table_privilege('authenticated', 'public.processed_stripe_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.processed_stripe_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.processed_stripe_events', 'DELETE') then
    raise exception 'CHECK0c FAIL: authenticated can access processed Stripe events';
  end if;

  if not has_table_privilege('service_role', 'public.payments', 'SELECT')
     or not has_table_privilege('service_role', 'public.payments', 'INSERT')
     or not has_table_privilege('service_role', 'public.payments', 'UPDATE')
     or not has_table_privilege('service_role', 'public.processed_stripe_events', 'INSERT') then
    raise exception 'CHECK0c FAIL: service_role lacks required Stripe table privileges';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.process_stripe_event(text,text,uuid,uuid,text,text,integer,text,integer)',
    'EXECUTE'
  ) then
    raise exception 'CHECK0c FAIL: service_role cannot execute process_stripe_event';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.process_stripe_event(text,text,uuid,uuid,text,text,integer,text,integer)',
    'EXECUTE'
  ) then
    raise exception 'CHECK0c FAIL: authenticated can execute process_stripe_event';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.process_stripe_subscription_event(text,text,uuid,text,text,timestamp with time zone,timestamp with time zone,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.process_stripe_subscription_event(text,text,uuid,text,text,timestamp with time zone,timestamp with time zone,text)',
    'EXECUTE'
  ) then
    raise exception 'CHECK0c FAIL: Stripe subscription processor grants are unsafe';
  end if;

  raise notice 'CHECK0c PASS: payment writes and Stripe event processing are service-role-only';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 0b: table privileges for `authenticated` are what migration 040000
-- granted. First push attempt failed with GRANT-level "permission denied for
-- table customers" (not an RLS denial), implying grants were missing/revoked
-- on the remote. This block names exactly which table/privilege pairs are
-- absent so the failure is diagnosable from the push output alone.
-- ---------------------------------------------------------------------------
do $$
declare
  t text; p text; missing text := '';
begin
  foreach t in array array['organizations','profiles','memberships','facilities',
                           'zones','spaces','customers','vehicles','reservations',
                           'price_rules','space_holds','invites'] loop
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('authenticated', 'public.' || t, p) then
        missing := missing || t || ':' || p || ' ';
      end if;
    end loop;
  end loop;
  if not has_table_privilege('authenticated', 'public.permits', 'SELECT')
     or has_table_privilege('authenticated', 'public.permits', 'INSERT')
     or has_table_privilege('authenticated', 'public.permits', 'UPDATE')
     or has_table_privilege('authenticated', 'public.permits', 'DELETE') then
    missing := missing || 'permits:expected-SELECT-only ';
  end if;
  if missing <> '' then
    raise exception 'CHECK0b FAIL: authenticated is missing grants: %', missing;
  end if;
  raise notice 'CHECK0b PASS: authenticated holds S/I/U/D on 12 tables; permits is SELECT-only';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 5: invite RLS. Org A admin can manage invites; Org A manager cannot.
-- ---------------------------------------------------------------------------
do $$
declare v_role text := current_user;
begin
  delete from public.invites where email = '__rls_invite_check__@parkos.dev';

  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  execute 'set local role authenticated';

  insert into public.invites (org_id, email, role, invited_by)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '__rls_invite_check__@parkos.dev',
          'attendant', '00000000-0000-0000-0000-0000000000a1');

  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  execute 'set local role authenticated';

  begin
    insert into public.invites (org_id, email, role, invited_by)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'manager-denied@parkos.dev',
            'attendant', '00000000-0000-0000-0000-0000000000a2');
    raise exception 'CHECK5 FAIL: manager created an invite';
  exception
    when sqlstate '42501' then
      if sqlerrm not like '%row-level security%' then
        raise exception 'CHECK5 FAIL: manager denied by GRANTs, not RLS: %', sqlerrm;
      end if;
  end;

  execute format('set local role %I', v_role);
  delete from public.invites where email = '__rls_invite_check__@parkos.dev';
  raise notice 'CHECK5 PASS: admin created invite; manager rejected by RLS';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 1: As Org A admin — sees exactly 2 facilities, all Org A; 165 spaces.
-- ---------------------------------------------------------------------------
do $$
declare v int; v_role text := current_user;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  execute 'set local role authenticated';

  select count(*) into v from public.facilities;
  if v <> 2 then raise exception 'CHECK1 FAIL: Org A admin sees % facilities, expected 2', v; end if;

  select count(*) into v from public.facilities
   where org_id <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if v <> 0 then raise exception 'CHECK1 FAIL: Org A admin sees % foreign-org facilities — LEAK', v; end if;

  select count(*) into v from public.spaces;
  if v <> 165 then raise exception 'CHECK1 FAIL: Org A admin sees % spaces, expected 165', v; end if;

  execute format('set local role %I', v_role);
  raise notice 'CHECK1 PASS: Org A admin sees exactly 2 facilities / 165 spaces, all Org A';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 1b: As Org B admin — the mirror: 1 facility, 10 spaces, all Org B.
-- ---------------------------------------------------------------------------
do $$
declare v int; v_role text := current_user;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
  execute 'set local role authenticated';

  select count(*) into v from public.facilities;
  if v <> 1 then raise exception 'CHECK1b FAIL: Org B admin sees % facilities, expected 1', v; end if;
  select count(*) into v from public.facilities
   where org_id <> 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if v <> 0 then raise exception 'CHECK1b FAIL: Org B admin sees % foreign-org facilities — LEAK', v; end if;
  select count(*) into v from public.spaces;
  if v <> 10 then raise exception 'CHECK1b FAIL: Org B admin sees % spaces, expected 10', v; end if;

  execute format('set local role %I', v_role);
  raise notice 'CHECK1b PASS: Org B admin sees exactly 1 facility / 10 spaces, all Org B';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 2: As Org A admin, inserting a facility with Org B's org_id MUST fail
-- with an RLS violation (SQLSTATE 42501). If the insert SUCCEEDS, isolation is
-- broken and we abort loudly.
-- ---------------------------------------------------------------------------
do $$
declare v_role text := current_user;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  execute 'set local role authenticated';

  begin
    insert into public.facilities (org_id, name)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CROSS-ORG INJECTION ATTEMPT');
    -- Reaching this line means the insert was ALLOWED -> isolation broken.
    raise exception 'CHECK2 FAIL: cross-org insert SUCCEEDED — RLS isolation is broken';
  exception
    when sqlstate '42501' then
      -- Both RLS denials and missing GRANTs raise 42501; only the RLS message
      -- proves isolation. A grant-level denial would mask an RLS hole.
      if sqlerrm not like '%row-level security%' then
        raise exception 'CHECK2 FAIL: denied by GRANTs not RLS ("%") — RLS unproven', sqlerrm;
      end if;
  end;

  execute format('set local role %I', v_role);
  raise notice 'CHECK2 PASS: cross-org insert rejected with RLS violation (42501)';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 3: As Org A admin, SELECT on memberships must return 6 rows and must
-- NOT raise "infinite recursion detected in policy" (SQLSTATE 42P17). This is
-- the specific proof the SECURITY DEFINER helper pattern avoided the trap —
-- any recursion error here propagates and fails the push with that message.
-- ---------------------------------------------------------------------------
do $$
declare v int; v_role text := current_user;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  execute 'set local role authenticated';

  select count(*) into v from public.memberships;   -- recursion would raise 42P17 HERE
  if v <> 6 then raise exception 'CHECK3 FAIL: Org A admin sees % memberships, expected 6', v; end if;

  select count(*) into v from public.memberships
   where org_id <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if v <> 0 then raise exception 'CHECK3 FAIL: sees % foreign-org memberships — LEAK', v; end if;

  execute format('set local role %I', v_role);
  raise notice 'CHECK3 PASS: memberships returned 6 rows, no recursion error';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 4: Role gradation. An Org A ATTENDANT cannot create a facility
-- (admin+manager only) but CAN create a customer (attendant allowed).
-- The successful customer row is deleted afterwards as postgres (owner bypasses
-- RLS), so this migration remains data-neutral.
-- ---------------------------------------------------------------------------
do $$
declare v int; v_role text := current_user;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
  execute 'set local role authenticated';

  begin
    insert into public.facilities (org_id, name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Attendant-made facility');
    raise exception 'CHECK4 FAIL: attendant created a facility — role gradation broken';
  exception
    when sqlstate '42501' then
      if sqlerrm not like '%row-level security%' then
        raise exception 'CHECK4 FAIL: denied by GRANTs not RLS ("%") — gradation unproven', sqlerrm;
      end if;
  end;

  insert into public.customers (org_id, full_name)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '__RLS_CHECK_TEMP_CUSTOMER__');

  execute format('set local role %I', v_role);

  -- cleanup as postgres; verify exactly the one temp row existed and is gone
  delete from public.customers where full_name = '__RLS_CHECK_TEMP_CUSTOMER__';
  get diagnostics v = row_count;
  if v <> 1 then raise exception 'CHECK4 FAIL: expected to clean up 1 temp customer, cleaned %', v; end if;

  raise notice 'CHECK4 PASS: attendant blocked from facilities, allowed on customers';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 6: create_facility_with_zones_and_spaces RPC. An Org A ATTENDANT must
-- be rejected with ROLE_NOT_ALLOWED before any row is written; an Org A ADMIN
-- must succeed and produce exactly the facility/zones/spaces requested, all
-- carrying Org A's org_id. Created rows are deleted afterwards as postgres so
-- the script stays data-neutral.
-- ---------------------------------------------------------------------------
do $$
declare
  v int;
  v_role text := current_user;
  v_facility_id uuid;
  v_payload jsonb := '[
    {"zone_name": "RLS Check Zone 1", "level": 1,
     "space_batches": [{"prefix": "T1-", "starting_number": 1, "count": 2, "space_type": "standard"}]},
    {"zone_name": "RLS Check Zone 2", "level": 2,
     "space_batches": [{"prefix": "T2-", "starting_number": 5, "count": 3, "space_type": "ev"}]}
  ]'::jsonb;
begin
  -- attendant (a3): must be refused with the function's own role check
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
  execute 'set local role authenticated';

  begin
    perform public.create_facility_with_zones_and_spaces(
      '__RLS_CHECK_FACILITY__', null, 'America/Los_Angeles', null, v_payload);
    raise exception 'CHECK6 FAIL: attendant created a facility via RPC';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'ROLE_NOT_ALLOWED' then
        raise exception 'CHECK6 FAIL: attendant rejected with "%" not ROLE_NOT_ALLOWED', sqlerrm;
      end if;
  end;

  -- admin (a1): must succeed atomically
  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  execute 'set local role authenticated';

  v_facility_id := public.create_facility_with_zones_and_spaces(
    '__RLS_CHECK_FACILITY__', '1 Test Way', 'America/Los_Angeles',
    '{"type":"daily","open":"06:00","close":"22:00"}'::jsonb, v_payload);

  execute format('set local role %I', v_role);

  select count(*) into v from public.zones
   where facility_id = v_facility_id
     and org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if v <> 2 then raise exception 'CHECK6 FAIL: expected 2 Org A zones, found %', v; end if;

  select count(*) into v from public.spaces
   where zone_id in (select id from public.zones where facility_id = v_facility_id)
     and org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if v <> 5 then raise exception 'CHECK6 FAIL: expected 5 Org A spaces, found %', v; end if;

  select count(*) into v from public.spaces
   where zone_id in (select id from public.zones where facility_id = v_facility_id)
     and space_number in ('T1-001', 'T1-002', 'T2-005', 'T2-006', 'T2-007');
  if v <> 5 then raise exception 'CHECK6 FAIL: space numbering wrong (matched % of 5)', v; end if;

  -- cleanup as postgres; child rows first (no cascade on the composite FKs)
  delete from public.spaces
   where zone_id in (select id from public.zones where facility_id = v_facility_id);
  delete from public.zones where facility_id = v_facility_id;
  delete from public.facilities where id = v_facility_id;

  raise notice 'CHECK6 PASS: facility RPC denies attendant, admin bootstrap atomic and org-scoped';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 7: customer isolation. Two synthetic customer logins (no memberships)
-- both linked to Org A. Proves: (a) customer 2 cannot see customer 1's
-- reservations; (b) customer 2 cannot book with customer 1's customer_id via
-- public_create_reservation (clear exception, not a wrong-owner insert);
-- (c) get_public_availability with an arbitrary (Org B) facility id surfaces
-- ONLY that facility's own spaces — no cross-tenant rows. All synthetic rows
-- (auth users, customers, price rule, reservation, hold) are deleted at the
-- end as postgres, so the script stays data-neutral.
-- ---------------------------------------------------------------------------
do $$
declare
  v int;
  v_role text := current_user;
  c_user1 uuid := '00000000-0000-0000-0000-0000000000c1';
  c_user2 uuid := '00000000-0000-0000-0000-0000000000c2';
  v_customer1 uuid;
  v_customer2 uuid;
  v_facility_a uuid;
  v_facility_b uuid;
  v_space uuid;
  v_rule uuid;
  v_reservation uuid;
  v_b_space_ids uuid[];
  v_start timestamptz := date_trunc('hour', now()) + interval '200 days';
begin
  -- setup as postgres
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000', c_user1, 'authenticated', 'authenticated',
     'rls-check-c1@parkos.dev', 'x', now(), now(), now(), '{}', '{}'),
    ('00000000-0000-0000-0000-000000000000', c_user2, 'authenticated', 'authenticated',
     'rls-check-c2@parkos.dev', 'x', now(), now(), now(), '{}', '{}')
  on conflict (id) do nothing;

  insert into public.customers (org_id, user_id, full_name)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', c_user1, '__RLS_CHECK_C1__')
  returning id into v_customer1;
  insert into public.customers (org_id, user_id, full_name)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', c_user2, '__RLS_CHECK_C2__')
  returning id into v_customer2;

  select f.id into v_facility_a from public.facilities f
   where f.org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
     and f.archived_at is null
   order by f.name limit 1;
  select f.id into v_facility_b from public.facilities f
   where f.org_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
     and f.archived_at is null
   order by f.name limit 1;

  -- a space in facility A with no unreleased holds at all
  select s.id into v_space
    from public.spaces s
    join public.zones z on z.id = s.zone_id
   where z.facility_id = v_facility_a
     and s.archived_at is null and z.archived_at is null
     and not exists (
       select 1 from public.space_holds h
        where h.space_id = s.id and h.released_at is null)
   order by s.space_number limit 1;
  if v_space is null then
    raise exception 'CHECK7 FAIL: no hold-free space in facility A to test with';
  end if;

  -- low-priority facility-wide rule so quoting always finds something
  insert into public.price_rules (org_id, facility_id, hourly_rate_cents, priority)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', v_facility_a, 100, -1000)
  returning id into v_rule;

  -- Reference set for the leak check, captured NOW as postgres: once we
  -- impersonate customer 2, RLS hides public.spaces entirely, so a subquery
  -- against it at that point would be empty and falsely flag every row.
  select array_agg(s.id) into v_b_space_ids
    from public.spaces s
    join public.zones z on z.id = s.zone_id
   where z.facility_id = v_facility_b;

  -- (positive control) customer 1 books through the public wrapper
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', c_user1::text, true);
  execute 'set local role authenticated';

  select r.reservation_id into v_reservation
    from public.public_create_reservation(
      v_facility_a, v_space, v_customer1, null,
      v_start, v_start + interval '2 hours') r;

  select count(*) into v from public.reservations;
  if v <> 1 then
    raise exception 'CHECK7 FAIL: customer 1 sees % reservations, expected exactly their 1', v;
  end if;

  -- switch to customer 2
  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', c_user2::text, true);
  execute 'set local role authenticated';

  -- (a) cannot see customer 1's reservations
  select count(*) into v from public.reservations;
  if v <> 0 then
    raise exception 'CHECK7 FAIL: customer 2 sees % foreign reservations — LEAK', v;
  end if;

  -- (a') and sees only their own customers row
  select count(*) into v from public.customers;
  if v <> 1 then
    raise exception 'CHECK7 FAIL: customer 2 sees % customer rows, expected 1 (own)', v;
  end if;

  -- (b) cannot book with customer 1's customer_id
  begin
    perform public.public_create_reservation(
      v_facility_a, v_space, v_customer1, null,
      v_start + interval '10 hours', v_start + interval '12 hours');
    raise exception 'CHECK7 FAIL: customer 2 booked with customer 1''s identity';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'CUSTOMER_NOT_OWNED' then
        raise exception 'CHECK7 FAIL: wrong rejection "%" (expected CUSTOMER_NOT_OWNED)', sqlerrm;
      end if;
  end;

  -- (c) availability for Org B's facility surfaces only that facility's spaces
  select count(*) into v
    from public.get_public_availability(
      v_facility_b, v_start, v_start + interval '2 hours') a
   where a.space_id <> all (v_b_space_ids);
  if v <> 0 then
    raise exception 'CHECK7 FAIL: get_public_availability leaked % cross-tenant spaces', v;
  end if;

  select count(*) into v
    from public.get_public_availability(
      v_facility_b, v_start, v_start + interval '2 hours') a;
  if v = 0 then
    raise exception 'CHECK7 FAIL: availability for facility B returned nothing (degenerate)';
  end if;

  -- cleanup as postgres; children first
  execute format('set local role %I', v_role);
  delete from public.space_holds where reservation_id = v_reservation;
  delete from public.reservations where id = v_reservation;
  delete from public.price_rules where id = v_rule;
  delete from public.customers where id in (v_customer1, v_customer2);
  delete from auth.users where id in (c_user1, c_user2);

  raise notice 'CHECK7 PASS: customer rows isolated; identity spoof rejected; availability tenant-clean';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 8: reservation lifecycle authorization. Proves: (a) a customer cannot
-- cancel OR extend another customer's reservation (clean P0001, not a silent
-- no-op — the row stays pending with its hold intact); (b) an Org A attendant
-- CAN cancel any Org A reservation via cancel_reservation, releasing the hold;
-- (c) an authenticated client cannot INSERT into audit_log directly — only the
-- SECURITY DEFINER functions write it. Synthetic rows removed at the end.
-- ---------------------------------------------------------------------------
do $$
declare
  v int;
  v_role text := current_user;
  c_user1 uuid := '00000000-0000-0000-0000-0000000000d1';
  c_user2 uuid := '00000000-0000-0000-0000-0000000000d2';
  a3 uuid := '00000000-0000-0000-0000-0000000000a3';  -- seeded Org A attendant
  org_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_customer1 uuid;
  v_customer2 uuid;
  v_facility_a uuid;
  v_space uuid;
  v_rule uuid;
  v_res uuid;
  v_start timestamptz := date_trunc('hour', now()) + interval '300 days';
begin
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000', c_user1, 'authenticated', 'authenticated',
     'rls-check-d1@parkos.dev', 'x', now(), now(), now(), '{}', '{}'),
    ('00000000-0000-0000-0000-000000000000', c_user2, 'authenticated', 'authenticated',
     'rls-check-d2@parkos.dev', 'x', now(), now(), now(), '{}', '{}')
  on conflict (id) do nothing;

  insert into public.customers (org_id, user_id, full_name)
  values (org_a, c_user1, '__RLS_CHECK_D1__') returning id into v_customer1;
  insert into public.customers (org_id, user_id, full_name)
  values (org_a, c_user2, '__RLS_CHECK_D2__') returning id into v_customer2;

  select f.id into v_facility_a from public.facilities f
   where f.org_id = org_a and f.archived_at is null order by f.name limit 1;

  select s.id into v_space
    from public.spaces s join public.zones z on z.id = s.zone_id
   where z.facility_id = v_facility_a
     and s.archived_at is null and z.archived_at is null
     and not exists (select 1 from public.space_holds h
                      where h.space_id = s.id and h.released_at is null)
   order by s.space_number limit 1;
  if v_space is null then
    raise exception 'CHECK8 FAIL: no hold-free space in facility A';
  end if;

  insert into public.price_rules (org_id, facility_id, hourly_rate_cents, priority)
  values (org_a, v_facility_a, 100, -1000) returning id into v_rule;

  -- customer 1 books
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', c_user1), true);
  perform set_config('request.jwt.claim.sub', c_user1::text, true);
  execute 'set local role authenticated';
  select r.reservation_id into v_res
    from public.public_create_reservation(
      v_facility_a, v_space, v_customer1, null,
      v_start, v_start + interval '2 hours') r;

  -- customer 2: cancel someone else's reservation -> NOT_AUTHORIZED
  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', c_user2), true);
  perform set_config('request.jwt.claim.sub', c_user2::text, true);
  execute 'set local role authenticated';

  begin
    perform public.cancel_reservation(v_res, 'malicious');
    raise exception 'CHECK8 FAIL: customer 2 cancelled another customer''s reservation';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'NOT_AUTHORIZED' then
        raise exception 'CHECK8 FAIL: wrong cancel rejection "%" (expected NOT_AUTHORIZED)', sqlerrm;
      end if;
  end;

  -- customer 2: extend someone else's reservation -> NOT_AUTHORIZED
  begin
    perform public.extend_reservation(v_res, v_start + interval '5 hours');
    raise exception 'CHECK8 FAIL: customer 2 extended another customer''s reservation';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'NOT_AUTHORIZED' then
        raise exception 'CHECK8 FAIL: wrong extend rejection "%" (expected NOT_AUTHORIZED)', sqlerrm;
      end if;
  end;

  -- direct audit_log insert by an authenticated client -> denied
  begin
    insert into public.audit_log (org_id, actor_id, action, target_table, target_id)
    values (org_a, c_user2, 'forged', 'reservations', v_res);
    raise exception 'CHECK8 FAIL: authenticated client forged an audit_log row';
  exception
    when insufficient_privilege then null;  -- 42501: no INSERT grant, as intended
  end;

  -- the reservation must still be untouched (no silent no-op cancel)
  execute format('set local role %I', v_role);
  select count(*) into v from public.reservations
   where id = v_res and status = 'pending';
  if v <> 1 then raise exception 'CHECK8 FAIL: reservation not left pending after blocked cancel'; end if;
  select count(*) into v from public.space_holds
   where reservation_id = v_res and released_at is null;
  if v <> 1 then raise exception 'CHECK8 FAIL: hold not left active after blocked cancel'; end if;

  -- attendant a3 cancels via the override path -> allowed
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', a3), true);
  perform set_config('request.jwt.claim.sub', a3::text, true);
  execute 'set local role authenticated';
  perform public.cancel_reservation(v_res, 'override by attendant');

  execute format('set local role %I', v_role);
  select count(*) into v from public.reservations
   where id = v_res and status = 'cancelled' and cancelled_by = a3;
  if v <> 1 then raise exception 'CHECK8 FAIL: attendant cancel did not take effect'; end if;
  select count(*) into v from public.space_holds
   where reservation_id = v_res and released_at is null;
  if v <> 0 then raise exception 'CHECK8 FAIL: attendant cancel did not release the hold'; end if;
  select count(*) into v from public.audit_log
   where target_id = v_res and action = 'cancel_reservation' and actor_id = a3;
  if v <> 1 then raise exception 'CHECK8 FAIL: cancel did not write exactly one audit row'; end if;

  -- cleanup as postgres; children first
  delete from public.audit_log where target_id = v_res;
  delete from public.space_holds where reservation_id = v_res;
  delete from public.reservations where id = v_res;
  delete from public.price_rules where id = v_rule;
  delete from public.customers where id in (v_customer1, v_customer2);
  delete from auth.users where id in (c_user1, c_user2);

  raise notice 'CHECK8 PASS: cross-customer cancel/extend denied; attendant override works; audit_log unforgeable';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 9: payment row isolation, authenticated write lockdown, service-role
-- webhook authorization, and atomic event idempotency. Two same-org customers
-- each see only their own payment; an Org B member sees neither. The service
-- role processes one completion twice, but only one event/audit row is written
-- and the reservation is confirmed once. Synthetic rows are removed at end.
-- ---------------------------------------------------------------------------
do $$
declare
  v int;
  v_role text := current_user;
  c_user1 uuid := '00000000-0000-0000-0000-0000000000f1';
  c_user2 uuid := '00000000-0000-0000-0000-0000000000f2';
  org_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  a1 uuid := '00000000-0000-0000-0000-0000000000a1';
  b1 uuid := '00000000-0000-0000-0000-0000000000b1';
  v_customer1 uuid;
  v_customer2 uuid;
  v_facility uuid;
  v_space uuid;
  v_reservation1 uuid;
  v_reservation2 uuid;
  v_payment1 uuid;
  v_payment2 uuid;
  v_result jsonb;
  v_start timestamptz := date_trunc('hour', now()) + interval '600 days';
begin
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000', c_user1, 'authenticated', 'authenticated',
     'rls-payment-f1@parkos.dev', 'x', now(), now(), now(), '{}', '{}'),
    ('00000000-0000-0000-0000-000000000000', c_user2, 'authenticated', 'authenticated',
     'rls-payment-f2@parkos.dev', 'x', now(), now(), now(), '{}', '{}')
  on conflict (id) do nothing;

  insert into public.customers (org_id, user_id, full_name)
  values (org_a, c_user1, '__RLS_PAYMENT_F1__')
  returning id into v_customer1;
  insert into public.customers (org_id, user_id, full_name)
  values (org_a, c_user2, '__RLS_PAYMENT_F2__')
  returning id into v_customer2;

  select s.id, z.facility_id into v_space, v_facility
    from public.spaces s
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
   where s.org_id = org_a
     and s.archived_at is null
     and z.archived_at is null
   order by s.id
   limit 1;

  if v_space is null then
    raise exception 'CHECK9 FAIL: no Org A space available for payment fixtures';
  end if;

  insert into public.reservations (
    org_id, facility_id, space_id, customer_id, during, status,
    price_breakdown, total_cents, currency
  ) values (
    org_a, v_facility, v_space, v_customer1,
    tstzrange(v_start, v_start + interval '1 hour', '[)'), 'pending',
    '{"line_items":[]}'::jsonb, 1000, 'USD'
  ) returning id into v_reservation1;

  insert into public.reservations (
    org_id, facility_id, space_id, customer_id, during, status,
    price_breakdown, total_cents, currency
  ) values (
    org_a, v_facility, v_space, v_customer2,
    tstzrange(v_start + interval '2 hours', v_start + interval '3 hours', '[)'), 'pending',
    '{"line_items":[]}'::jsonb, 1200, 'USD'
  ) returning id into v_reservation2;

  insert into public.payments (
    org_id, reservation_id, stripe_checkout_session_id,
    amount_cents, currency, status
  ) values (
    org_a, v_reservation1, 'cs_test_rls_payment_f1', 1000, 'USD', 'pending'
  ) returning id into v_payment1;

  insert into public.payments (
    org_id, reservation_id, stripe_checkout_session_id,
    amount_cents, currency, status
  ) values (
    org_a, v_reservation2, 'cs_test_rls_payment_f2', 1200, 'USD', 'pending'
  ) returning id into v_payment2;

  -- Customer 1 sees own payment only and cannot mutate it.
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', c_user1), true);
  perform set_config('request.jwt.claim.sub', c_user1::text, true);
  execute 'set local role authenticated';

  select count(*) into v from public.payments;
  if v <> 1 then
    raise exception 'CHECK9 FAIL: customer 1 sees % payments, expected own 1', v;
  end if;
  select count(*) into v from public.payments where id = v_payment2;
  if v <> 0 then
    raise exception 'CHECK9 FAIL: customer 1 can read customer 2 payment';
  end if;

  begin
    update public.payments set status = 'succeeded' where id = v_payment1;
    raise exception 'CHECK9 FAIL: authenticated customer updated a payment';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.payments (
      org_id, reservation_id, stripe_checkout_session_id,
      amount_cents, currency, status
    ) values (
      org_a, v_reservation1, 'cs_test_rls_forged_f1', 1000, 'USD', 'succeeded'
    );
    raise exception 'CHECK9 FAIL: authenticated customer inserted a payment';
  exception
    when insufficient_privilege then null;
  end;

  -- Customer 2 cannot see customer 1's payment.
  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', c_user2), true);
  perform set_config('request.jwt.claim.sub', c_user2::text, true);
  execute 'set local role authenticated';

  select count(*) into v from public.payments;
  if v <> 1 then
    raise exception 'CHECK9 FAIL: customer 2 sees % payments, expected own 1', v;
  end if;
  select count(*) into v from public.payments where id = v_payment1;
  if v <> 0 then
    raise exception 'CHECK9 FAIL: customer 2 can read customer 1 payment';
  end if;

  -- Org A staff sees both, while Org B staff sees neither.
  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', a1), true);
  perform set_config('request.jwt.claim.sub', a1::text, true);
  execute 'set local role authenticated';
  select count(*) into v from public.payments
   where id in (v_payment1, v_payment2);
  if v <> 2 then
    raise exception 'CHECK9 FAIL: Org A admin sees % of 2 Org A payments', v;
  end if;

  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', b1), true);
  perform set_config('request.jwt.claim.sub', b1::text, true);
  execute 'set local role authenticated';
  select count(*) into v from public.payments
   where id in (v_payment1, v_payment2);
  if v <> 0 then
    raise exception 'CHECK9 FAIL: Org B admin sees % Org A payments', v;
  end if;

  -- Signed-webhook equivalent: service role applies completion and then the
  -- same event again. The second call must be a clean no-op.
  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';

  v_result := public.process_stripe_event(
    p_event_id => 'evt_test_rls_checkout_f1',
    p_event_type => 'checkout.session.completed',
    p_payment_id => v_payment1,
    p_reservation_id => v_reservation1,
    p_checkout_session_id => 'cs_test_rls_payment_f1',
    p_payment_intent_id => 'pi_test_rls_payment_f1',
    p_amount_cents => 1000,
    p_currency => 'usd'
  );
  if coalesce((v_result ->> 'processed')::boolean, false) is not true
     or v_result ->> 'outcome' <> 'payment_succeeded_reservation_confirmed' then
    raise exception 'CHECK9 FAIL: first webhook result was %', v_result;
  end if;

  v_result := public.process_stripe_event(
    p_event_id => 'evt_test_rls_checkout_f1',
    p_event_type => 'checkout.session.completed',
    p_payment_id => v_payment1,
    p_reservation_id => v_reservation1,
    p_checkout_session_id => 'cs_test_rls_payment_f1',
    p_payment_intent_id => 'pi_test_rls_payment_f1',
    p_amount_cents => 1000,
    p_currency => 'usd'
  );
  if coalesce((v_result ->> 'processed')::boolean, true) is not false
     or v_result ->> 'outcome' <> 'duplicate_event' then
    raise exception 'CHECK9 FAIL: duplicate webhook result was %', v_result;
  end if;

  execute format('set local role %I', v_role);

  select count(*) into v from public.processed_stripe_events
   where event_id = 'evt_test_rls_checkout_f1' and org_id = org_a;
  if v <> 1 then
    raise exception 'CHECK9 FAIL: processed event count %, expected 1', v;
  end if;
  select count(*) into v from public.payments
   where id = v_payment1
     and status = 'succeeded'
     and stripe_payment_intent_id = 'pi_test_rls_payment_f1';
  if v <> 1 then
    raise exception 'CHECK9 FAIL: webhook did not mark payment succeeded';
  end if;
  select count(*) into v from public.reservations
   where id = v_reservation1 and status = 'confirmed';
  if v <> 1 then
    raise exception 'CHECK9 FAIL: webhook did not confirm reservation';
  end if;
  select count(*) into v from public.audit_log
   where target_id = v_reservation1
     and action = 'confirm_reservation'
     and actor_id is null;
  if v <> 1 then
    raise exception 'CHECK9 FAIL: service confirmation audit count %, expected 1', v;
  end if;

  -- cleanup as postgres; children first
  delete from public.processed_stripe_events
   where event_id = 'evt_test_rls_checkout_f1';
  delete from public.audit_log where target_id in (v_reservation1, v_reservation2);
  delete from public.payments where id in (v_payment1, v_payment2);
  delete from public.reservations where id in (v_reservation1, v_reservation2);
  delete from public.customers where id in (v_customer1, v_customer2);
  delete from auth.users where id in (c_user1, c_user2);

  raise notice 'CHECK9 PASS: payments isolated/read-only; webhook service role is atomic and idempotent';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 10: attendant check-in/out authorization + vehicle photo tenancy.
-- Proves: (a) an Org A attendant cannot check in OR check out an Org B
-- reservation (ROLE_NOT_ALLOWED, and Org B's reservation is left untouched);
-- (b) vehicle_photos rows are org-scoped — Org A staff see only Org A's,
-- Org B staff only Org B's; (c) the vehicle-photos storage bucket policies
-- enforce the same org boundary on storage.objects by the org_id path prefix.
-- Synthetic customers, reservations, photo rows, and storage objects are all
-- removed at the end, so the script stays data-neutral.
-- ---------------------------------------------------------------------------
-- Storage's protect_delete() trigger forbids direct DELETE on storage.objects,
-- so instead of cleaning up we do ALL of CHECK10 inside a subtransaction and
-- roll it back on success (sentinel) — nothing this block writes persists,
-- including the synthetic storage objects. A real assertion failure re-raises
-- and aborts (its writes also roll back), so the block is data-neutral either
-- way without deleting anything.
do $$
declare
  v int;
  v_role text := current_user;
  org_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  org_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  a1 uuid := '00000000-0000-0000-0000-0000000000a1';
  a3 uuid := '00000000-0000-0000-0000-0000000000a3';
  b1 uuid := '00000000-0000-0000-0000-0000000000b1';
  v_cust_a uuid; v_cust_b uuid;
  v_fac_a uuid;  v_fac_b uuid;
  v_space_a uuid; v_space_b uuid;
  v_res_a uuid;  v_res_b uuid;
  v_photo_a uuid; v_photo_b uuid;
  name_a text; name_b text;
  v_win tstzrange := tstzrange(
    date_trunc('hour', now()) + interval '400 days',
    date_trunc('hour', now()) + interval '400 days 1 hour', '[)');
begin
  begin  -- subtransaction: everything below is rolled back before we return
    select z.facility_id, s.id into v_fac_a, v_space_a
      from public.spaces s join public.zones z on z.id = s.zone_id
     where s.org_id = org_a and s.archived_at is null and z.archived_at is null
     order by s.id limit 1;
    select z.facility_id, s.id into v_fac_b, v_space_b
      from public.spaces s join public.zones z on z.id = s.zone_id
     where s.org_id = org_b and s.archived_at is null and z.archived_at is null
     order by s.id limit 1;

    insert into public.customers (org_id, full_name) values (org_a, '__RLS10_A__')
      returning id into v_cust_a;
    insert into public.customers (org_id, full_name) values (org_b, '__RLS10_B__')
      returning id into v_cust_b;

    insert into public.reservations (org_id, facility_id, space_id, customer_id,
      during, status, price_breakdown, total_cents, currency)
    values (org_a, v_fac_a, v_space_a, v_cust_a, v_win, 'pending',
            '{"line_items":[]}'::jsonb, 1000, 'USD') returning id into v_res_a;
    insert into public.reservations (org_id, facility_id, space_id, customer_id,
      during, status, price_breakdown, total_cents, currency)
    values (org_b, v_fac_b, v_space_b, v_cust_b, v_win, 'pending',
            '{"line_items":[]}'::jsonb, 1000, 'USD') returning id into v_res_b;

    insert into public.vehicle_photos (org_id, reservation_id, storage_path)
    values (org_a, v_res_a, org_a::text || '/' || v_res_a::text || '/__RLS10__.jpg')
      returning id into v_photo_a;
    insert into public.vehicle_photos (org_id, reservation_id, storage_path)
    values (org_b, v_res_b, org_b::text || '/' || v_res_b::text || '/__RLS10__.jpg')
      returning id into v_photo_b;

    name_a := org_a::text || '/__RLS10__/a.jpg';
    name_b := org_b::text || '/__RLS10__/b.jpg';
    insert into storage.objects (bucket_id, name) values ('vehicle-photos', name_a);
    insert into storage.objects (bucket_id, name) values ('vehicle-photos', name_b);

    -- (a) Org A attendant cannot check in / out an Org B reservation.
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', a3), true);
    perform set_config('request.jwt.claim.sub', a3::text, true);
    execute 'set local role authenticated';

    begin
      perform public.check_in_reservation(v_res_b);
      raise exception 'CHECK10 FAIL: Org A attendant checked in an Org B reservation';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'ROLE_NOT_ALLOWED' then
          raise exception 'CHECK10 FAIL: check-in wrong rejection "%"', sqlerrm;
        end if;
    end;

    begin
      perform public.check_out_reservation(v_res_b, 0);
      raise exception 'CHECK10 FAIL: Org A attendant checked out an Org B reservation';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'ROLE_NOT_ALLOWED' then
          raise exception 'CHECK10 FAIL: check-out wrong rejection "%"', sqlerrm;
        end if;
    end;

    execute format('set local role %I', v_role);
    select count(*) into v from public.reservations
     where id = v_res_b and status = 'pending';
    if v <> 1 then raise exception 'CHECK10 FAIL: Org B reservation state changed'; end if;

    -- (b)+(c) Org A admin sees only Org A photo row and storage object.
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', a1), true);
    perform set_config('request.jwt.claim.sub', a1::text, true);
    execute 'set local role authenticated';

    select count(*) into v from public.vehicle_photos where id = v_photo_a;
    if v <> 1 then raise exception 'CHECK10 FAIL: Org A admin cannot see own vehicle_photo'; end if;
    select count(*) into v from public.vehicle_photos where id = v_photo_b;
    if v <> 0 then raise exception 'CHECK10 FAIL: Org A admin read Org B vehicle_photo — LEAK'; end if;

    select count(*) into v from storage.objects
     where bucket_id = 'vehicle-photos' and name = name_a;
    if v <> 1 then raise exception 'CHECK10 FAIL: Org A admin cannot read own storage object'; end if;
    select count(*) into v from storage.objects
     where bucket_id = 'vehicle-photos' and name = name_b;
    if v <> 0 then raise exception 'CHECK10 FAIL: Org A admin read Org B storage object — LEAK'; end if;

    -- Mirror: Org B admin sees only Org B.
    execute format('set local role %I', v_role);
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', b1), true);
    perform set_config('request.jwt.claim.sub', b1::text, true);
    execute 'set local role authenticated';

    select count(*) into v from public.vehicle_photos where id = v_photo_a;
    if v <> 0 then raise exception 'CHECK10 FAIL: Org B admin read Org A vehicle_photo — LEAK'; end if;
    select count(*) into v from storage.objects
     where bucket_id = 'vehicle-photos' and name = name_a;
    if v <> 0 then raise exception 'CHECK10 FAIL: Org B admin read Org A storage object — LEAK'; end if;

    -- All assertions passed: roll the whole subtransaction back via a sentinel.
    execute format('set local role %I', v_role);
    raise exception using errcode = 'P0001', message = '__CHECK10_ROLLBACK_OK__';
  exception
    when others then
      execute format('set local role %I', v_role);
      if sqlerrm <> '__CHECK10_ROLLBACK_OK__' then
        raise;  -- a real failure (or unexpected error): propagate and abort
      end if;
  end;

  raise notice 'CHECK10 PASS: cross-org check-in/out denied; vehicle_photos + storage objects org-scoped';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 12: monthly permit lifecycle, concurrency, and tenant/customer RLS.
-- ---------------------------------------------------------------------------
do $$
declare
  v int;
  v_role text := current_user;
  org_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  a_admin uuid := '00000000-0000-0000-0000-0000000000a1';
  b_admin uuid := '00000000-0000-0000-0000-0000000000b1';
  c_user1 uuid := '00000000-0000-0000-0000-0000000000f1';
  c_user2 uuid := '00000000-0000-0000-0000-0000000000f2';
  v_customer1 uuid;
  v_customer2 uuid;
  v_facility uuid;
  v_space uuid;
  v_permit uuid;
  v_start timestamptz := date_trunc('hour', now()) + interval '900 days';
begin
  begin
    insert into auth.users
      (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    values
      ('00000000-0000-0000-0000-000000000000', c_user1, 'authenticated', 'authenticated',
       'rls-permit-f1@parkos.dev', 'x', now(), now(), now(), '{}', '{}'),
      ('00000000-0000-0000-0000-000000000000', c_user2, 'authenticated', 'authenticated',
       'rls-permit-f2@parkos.dev', 'x', now(), now(), now(), '{}', '{}')
    on conflict (id) do nothing;

    insert into public.customers (org_id, user_id, full_name)
    values (org_a, c_user1, '__RLS12_OWNER__') returning id into v_customer1;
    insert into public.customers (org_id, user_id, full_name)
    values (org_a, c_user2, '__RLS12_OTHER__') returning id into v_customer2;

    select z.facility_id, s.id into v_facility, v_space
      from public.spaces s
      join public.zones z on z.org_id = s.org_id and z.id = s.zone_id
     where s.org_id = org_a and s.archived_at is null and z.archived_at is null
       and not exists (
         select 1 from public.space_holds h
          where h.space_id = s.id and h.released_at is null
            and h.during && tstzrange(v_start, null, '[)')
       )
     order by s.id limit 1;
    if v_space is null then raise exception 'CHECK12 FAIL: no long-term test space'; end if;

    -- A customer can read their eventual permit, but can never issue one.
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', c_user1), true);
    perform set_config('request.jwt.claim.sub', c_user1::text, true);
    execute 'set local role authenticated';
    begin
      perform public.issue_permit(org_a, v_facility, v_space, v_customer1,
                                  v_start, 15000, 'USD');
      raise exception 'CHECK12 FAIL: customer issued a permit';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'ROLE_NOT_ALLOWED' then raise; end if;
    end;

    -- Admin issuance creates permit + open-ended hold atomically.
    execute format('set local role %I', v_role);
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', a_admin), true);
    perform set_config('request.jwt.claim.sub', a_admin::text, true);
    execute 'set local role authenticated';
    select p.id into v_permit
      from public.issue_permit(org_a, v_facility, v_space, v_customer1,
                               v_start, 15000, 'USD') p;
    select count(*) into v from public.space_holds
     where permit_id = v_permit and hold_type = 'permit'
       and released_at is null and upper_inf(during);
    if v <> 1 then raise exception 'CHECK12 FAIL: issue did not create open permit hold'; end if;

    -- The Week 3 reservation path must lose to the shared exclusion constraint.
    begin
      perform public.create_reservation(
        v_space, v_customer1, null, v_start + interval '1 day', v_start + interval '1 day 1 hour'
      );
      raise exception 'CHECK12 FAIL: reservation overlapped active permit';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'SPACE_UNAVAILABLE' then raise; end if;
    end;

    -- Owner sees exactly their row; another customer in the same org sees none.
    execute format('set local role %I', v_role);
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', c_user1), true);
    perform set_config('request.jwt.claim.sub', c_user1::text, true);
    execute 'set local role authenticated';
    select count(*) into v from public.permits where id = v_permit;
    if v <> 1 then raise exception 'CHECK12 FAIL: owner cannot read own permit'; end if;

    execute format('set local role %I', v_role);
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', c_user2), true);
    perform set_config('request.jwt.claim.sub', c_user2::text, true);
    execute 'set local role authenticated';
    select count(*) into v from public.permits where id = v_permit;
    if v <> 0 then raise exception 'CHECK12 FAIL: customer read another customer permit'; end if;

    -- An admin of another tenant also sees none.
    execute format('set local role %I', v_role);
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', b_admin), true);
    perform set_config('request.jwt.claim.sub', b_admin::text, true);
    execute 'set local role authenticated';
    select count(*) into v from public.permits where id = v_permit;
    if v <> 0 then raise exception 'CHECK12 FAIL: Org B admin read Org A permit'; end if;

    -- Staff cancellation releases the same hold and records the lifecycle.
    execute format('set local role %I', v_role);
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', a_admin), true);
    perform set_config('request.jwt.claim.sub', a_admin::text, true);
    execute 'set local role authenticated';
    perform public.cancel_permit(v_permit, 'CHECK12 cleanup cancellation');
    select count(*) into v from public.space_holds
     where permit_id = v_permit and released_at is null;
    if v <> 0 then raise exception 'CHECK12 FAIL: cancelled permit still holds its space'; end if;

    execute format('set local role %I', v_role);
    raise exception using errcode = 'P0001', message = '__CHECK12_ROLLBACK_OK__';
  exception when others then
    execute format('set local role %I', v_role);
    if sqlerrm <> '__CHECK12_ROLLBACK_OK__' then raise; end if;
  end;

  raise notice 'CHECK12 PASS: permit roles/RLS isolated; active permit blocks reservations; cancel releases hold';
end $$;

rollback;

-- The Management API suppresses RAISE NOTICE output. If every assertion above
-- completes, return an explicit, machine-visible summary for CI/manual evidence.
select check_name, result
from (values
  ('CHECK0',  'PASS: 20 RLS tables, 59 policies, 23 SECURITY DEFINER functions'),
  ('CHECK0b', 'PASS: authenticated has normal DML grants; permits is SELECT-only'),
  ('CHECK0c', 'PASS: payment writes and Stripe event processing are service-role-only'),
  ('CHECK1',  'PASS: Org A sees exactly 2 facilities / 165 spaces, all Org A'),
  ('CHECK1b', 'PASS: Org B sees exactly 1 facility / 10 spaces, all Org B'),
  ('CHECK2',  'PASS: cross-org insert rejected by RLS with SQLSTATE 42501'),
  ('CHECK3',  'PASS: Org A sees 6 memberships with no policy recursion'),
  ('CHECK4',  'PASS: attendant denied facility insert and allowed customer insert'),
  ('CHECK5',  'PASS: admin created invite; manager rejected by RLS'),
  ('CHECK6',  'PASS: facility RPC denies attendant; admin bootstrap atomic and org-scoped'),
  ('CHECK7',  'PASS: customer rows isolated; identity spoof rejected; availability tenant-clean'),
  ('CHECK8',  'PASS: cross-customer cancel/extend denied; attendant override works; audit_log unforgeable'),
  ('CHECK9',  'PASS: payments isolated/read-only; webhook service role atomic and idempotent'),
  ('CHECK10', 'PASS: cross-org check-in/out denied; vehicle_photos + storage objects org-scoped'),
  ('CHECK12', 'PASS: permit roles/RLS isolated; active permit blocks reservations; cancel releases hold')
) as checks(check_name, result)
order by check_name;
