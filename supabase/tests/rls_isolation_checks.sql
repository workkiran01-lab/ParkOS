-- =============================================================================
-- ParkOS RLS isolation checks — run these in the Supabase SQL editor (parkos-dev)
-- =============================================================================
-- These PROVE the three properties that matter, rather than assuming them:
--   (1) an org admin sees only their own org's rows,
--   (2) an org admin cannot insert rows into another org,
--   (3) selecting memberships does NOT recurse/hang (the infinite-recursion trap).
--
-- HOW THIS WORKS
--   The SQL editor runs as `postgres`, which OWNS the tables and is therefore EXEMPT
--   from RLS — so you must impersonate a normal end user to see policies act:
--     * `set local role authenticated`      -> switches to a role RLS applies to
--     * set request.jwt.claims with `sub`   -> what auth.uid() reads inside policies
--   Each check is its own BEGIN/ROLLBACK block so nothing is persisted and a failing
--   INSERT (which is the POINT of check 2) doesn't abort the other checks.
--
-- Fixed seed UUIDs:
--   Org A (Harbor Park Group) = aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
--   Org B (Pier Point Parking)= bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
--   Org A admin user          = 00000000-0000-0000-0000-0000000000a1
--   Org B admin user          = 00000000-0000-0000-0000-0000000000b1
-- =============================================================================


-- -----------------------------------------------------------------------------
-- CHECK 1 — As Org A admin, `facilities` returns ONLY Org A rows.
-- EXPECT: exactly the 2 Harbor Park facilities (Lot A, Lot B); NEVER Pier Point.
-- -----------------------------------------------------------------------------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  select org_id, name from public.facilities order by name;
  -- PASS if 2 rows, both org_id = aaaaaaaa-...; FAIL if any bbbbbbbb-... row appears.

  select count(*) as org_a_space_count from public.spaces;
  -- PASS if 165 (120 Lot A + 45 Lot B). Org B's 10 spaces must be invisible.
rollback;


-- -----------------------------------------------------------------------------
-- CHECK 1b — As Org B admin, the mirror image: only Pier Point is visible.
-- EXPECT: exactly 1 facility (Pier Point Lot); 10 spaces.
-- -----------------------------------------------------------------------------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);

  select org_id, name from public.facilities order by name;   -- PASS: 1 row, bbbbbbbb-...
  select count(*) as org_b_space_count from public.spaces;    -- PASS: 10
rollback;


-- -----------------------------------------------------------------------------
-- CHECK 2 — As Org A admin, inserting a facility with Org B's org_id MUST FAIL.
-- EXPECT: ERROR: new row violates row-level security policy for table "facilities"
--   (the WITH CHECK calls has_any_role(<Org B id>, ['admin','manager']) -> false).
-- -----------------------------------------------------------------------------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  -- This statement is EXPECTED to raise. If it SUCCEEDS, isolation is broken -> FAIL.
  insert into public.facilities (org_id, name)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CROSS-ORG INJECTION ATTEMPT');
rollback;


-- -----------------------------------------------------------------------------
-- CHECK 3 — As Org A admin, selecting `memberships` returns WITHOUT recursion/hang.
-- This is the specific proof the SECURITY DEFINER helpers avoided the trap:
--   a policy on memberships that queried memberships inline would raise
--   "infinite recursion detected in policy for relation memberships".
-- EXPECT: a plain count (6 for Org A) and NO recursion error, NO hang.
-- -----------------------------------------------------------------------------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  select count(*) as org_a_membership_count from public.memberships;   -- PASS: 6, no error
  select user_id, role from public.memberships order by role;          -- PASS: only Org A rows
rollback;


-- -----------------------------------------------------------------------------
-- CHECK 4 (bonus) — role gradation: an ATTENDANT cannot create a facility
-- (facilities INSERT is admin+manager only), but CAN create a customer.
-- EXPECT: the facilities insert FAILS; the customers insert SUCCEEDS.
-- -----------------------------------------------------------------------------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);  -- Org A attendant

  -- Expected to FAIL (attendant lacks facilities write):
  insert into public.facilities (org_id, name)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Attendant-made facility');
rollback;

begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);  -- Org A attendant

  -- Expected to SUCCEED (attendant may write customers), then rolled back:
  insert into public.customers (org_id, full_name)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Walk-up Customer');
  select full_name from public.customers where full_name = 'Walk-up Customer';
rollback;
