-- =============================================================================
-- ParkOS RLS isolation checks — run these in the Supabase SQL editor (parkos-dev)
-- =============================================================================
-- These PROVE the isolation properties that matter, rather than assuming them:
--   (1) an org admin sees only their own org's rows,
--   (2) an org admin cannot insert rows into another org,
--   (3) selecting memberships does NOT recurse/hang (the infinite-recursion trap),
--   (4) a customer cannot read another customer's payment, and
--   (5) authenticated clients have no payment write privilege or policy.
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
-- CHECK 5 — payment isolation + write lockdown.
-- Creates two same-org customer reservations/payments as postgres, then proves
-- each customer sees exactly their own payment. The catalog assertions prove
-- there is no INSERT/UPDATE/ALL payment policy and authenticated has no DML
-- grant, while service_role has the privileges required by trusted handlers.
-- Everything synthetic is removed before the block commits.
-- -----------------------------------------------------------------------------
do $$
declare
  v int;
  v_role text := current_user;
  c_user1 uuid := '00000000-0000-0000-0000-0000000000e1';
  c_user2 uuid := '00000000-0000-0000-0000-0000000000e2';
  org_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  org_b_admin uuid := '00000000-0000-0000-0000-0000000000b1';
  v_customer1 uuid;
  v_customer2 uuid;
  v_facility uuid;
  v_space uuid;
  v_reservation1 uuid;
  v_reservation2 uuid;
  v_payment1 uuid;
  v_payment2 uuid;
  v_start timestamptz := date_trunc('hour', now()) + interval '500 days';
begin
  select count(*) into v
    from pg_policies
   where schemaname = 'public'
     and tablename = 'payments'
     and cmd in ('INSERT', 'UPDATE', 'ALL');
  if v <> 0 then
    raise exception 'CHECK5 FAIL: payments has % authenticated-write-capable policies', v;
  end if;

  if has_table_privilege('authenticated', 'public.payments', 'INSERT')
     or has_table_privilege('authenticated', 'public.payments', 'UPDATE') then
    raise exception 'CHECK5 FAIL: authenticated has INSERT or UPDATE on payments';
  end if;

  if not has_table_privilege('service_role', 'public.payments', 'INSERT')
     or not has_table_privilege('service_role', 'public.payments', 'UPDATE') then
    raise exception 'CHECK5 FAIL: service_role lacks payment write privileges';
  end if;

  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000', c_user1, 'authenticated', 'authenticated',
     'rls-payment-e1@parkos.dev', 'x', now(), now(), now(), '{}', '{}'),
    ('00000000-0000-0000-0000-000000000000', c_user2, 'authenticated', 'authenticated',
     'rls-payment-e2@parkos.dev', 'x', now(), now(), now(), '{}', '{}')
  on conflict (id) do nothing;

  insert into public.customers (org_id, user_id, full_name)
  values (org_a, c_user1, '__RLS_PAYMENT_E1__')
  returning id into v_customer1;
  insert into public.customers (org_id, user_id, full_name)
  values (org_a, c_user2, '__RLS_PAYMENT_E2__')
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
    raise exception 'CHECK5 FAIL: no Org A space available for payment fixtures';
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
    org_a, v_reservation1, 'cs_test_rls_payment_e1', 1000, 'USD', 'pending'
  ) returning id into v_payment1;

  insert into public.payments (
    org_id, reservation_id, stripe_checkout_session_id,
    amount_cents, currency, status
  ) values (
    org_a, v_reservation2, 'cs_test_rls_payment_e2', 1200, 'USD', 'pending'
  ) returning id into v_payment2;

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', c_user1), true);
  perform set_config('request.jwt.claim.sub', c_user1::text, true);
  execute 'set local role authenticated';

  select count(*) into v from public.payments;
  if v <> 1 then
    raise exception 'CHECK5 FAIL: customer 1 sees % payments, expected exactly own 1', v;
  end if;
  select count(*) into v from public.payments where id = v_payment2;
  if v <> 0 then
    raise exception 'CHECK5 FAIL: customer 1 can read customer 2 payment';
  end if;

  begin
    update public.payments set status = 'succeeded' where id = v_payment1;
    raise exception 'CHECK5 FAIL: authenticated customer updated a payment';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.payments (
      org_id, reservation_id, stripe_checkout_session_id,
      amount_cents, currency, status
    ) values (
      org_a, v_reservation1, 'cs_test_rls_forged', 1000, 'USD', 'succeeded'
    );
    raise exception 'CHECK5 FAIL: authenticated customer inserted a payment';
  exception
    when insufficient_privilege then null;
  end;

  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', c_user2), true);
  perform set_config('request.jwt.claim.sub', c_user2::text, true);
  execute 'set local role authenticated';

  select count(*) into v from public.payments;
  if v <> 1 then
    raise exception 'CHECK5 FAIL: customer 2 sees % payments, expected exactly own 1', v;
  end if;
  select count(*) into v from public.payments where id = v_payment1;
  if v <> 0 then
    raise exception 'CHECK5 FAIL: customer 2 can read customer 1 payment';
  end if;

  -- A member of the other organization must see neither payment.
  execute format('set local role %I', v_role);
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', org_b_admin), true);
  perform set_config('request.jwt.claim.sub', org_b_admin::text, true);
  execute 'set local role authenticated';

  select count(*) into v from public.payments;
  if v <> 0 then
    raise exception 'CHECK5 FAIL: Org B admin sees % Org A payments', v;
  end if;

  execute format('set local role %I', v_role);
  delete from public.payments where id in (v_payment1, v_payment2);
  delete from public.reservations where id in (v_reservation1, v_reservation2);
  delete from public.customers where id in (v_customer1, v_customer2);
  delete from auth.users where id in (c_user1, c_user2);

  raise notice 'CHECK5 PASS: customer payments isolated; authenticated writes impossible';
end $$;


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
