-- DEV-ONLY manual RLS isolation verification (assertion-only; changes no schema or data).
-- Companion to supabase/tests/rls_isolation_checks.sql (the interactive SQL-editor
-- version). Run this manually against parkos-dev after policy changes. Every block
-- RAISES EXCEPTION on failure, so a failed check aborts execution with its message.
--
-- Depends on the dev seed (20260819040100); like the seed, dev-project only.

-- ---------------------------------------------------------------------------
-- CHECK 0: the DDL actually landed — 13 RLS-enabled tables, 36 policies,
-- all five authorization/bootstrap functions present and SECURITY DEFINER.
-- ---------------------------------------------------------------------------
do $$
declare v int;
begin
  select count(*) into v from pg_tables
   where schemaname = 'public' and rowsecurity
     and tablename in ('organizations','profiles','memberships','facilities',
                       'zones','spaces','customers','vehicles','reservations',
                       'permits','price_rules','space_holds','invites');
  if v <> 13 then
    raise exception 'CHECK0 FAIL: expected 13 RLS-enabled tables, found %', v;
  end if;

  select count(*) into v from pg_policies where schemaname = 'public';
  if v <> 36 then
    raise exception 'CHECK0 FAIL: expected 36 policies, found %', v;
  end if;

  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('get_user_role','has_any_role',
                       'create_organization_with_admin','accept_invite',
                       'create_facility_with_zones_and_spaces')
     and p.prosecdef;
  if v <> 5 then
    raise exception 'CHECK0 FAIL: helper functions missing or not SECURITY DEFINER (found %)', v;
  end if;
  raise notice 'CHECK0 PASS: 13 RLS tables, 36 policies, 5 SECURITY DEFINER functions';
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
                           'permits','price_rules','space_holds','invites'] loop
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('authenticated', 'public.' || t, p) then
        missing := missing || t || ':' || p || ' ';
      end if;
    end loop;
  end loop;
  if missing <> '' then
    raise exception 'CHECK0b FAIL: authenticated is missing grants: %', missing;
  end if;
  raise notice 'CHECK0b PASS: authenticated holds S/I/U/D on all 13 tables';
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

-- The Management API suppresses RAISE NOTICE output. If every assertion above
-- completes, return an explicit, machine-visible summary for CI/manual evidence.
select check_name, result
from (values
  ('CHECK0',  'PASS: 13 RLS tables, 36 policies, 5 SECURITY DEFINER functions'),
  ('CHECK0b', 'PASS: authenticated has S/I/U/D grants on all 13 RLS tables'),
  ('CHECK1',  'PASS: Org A sees exactly 2 facilities / 165 spaces, all Org A'),
  ('CHECK1b', 'PASS: Org B sees exactly 1 facility / 10 spaces, all Org B'),
  ('CHECK2',  'PASS: cross-org insert rejected by RLS with SQLSTATE 42501'),
  ('CHECK3',  'PASS: Org A sees 6 memberships with no policy recursion'),
  ('CHECK4',  'PASS: attendant denied facility insert and allowed customer insert'),
  ('CHECK5',  'PASS: admin created invite; manager rejected by RLS'),
  ('CHECK6',  'PASS: facility RPC denies attendant; admin bootstrap atomic and org-scoped')
) as checks(check_name, result)
order by check_name;
