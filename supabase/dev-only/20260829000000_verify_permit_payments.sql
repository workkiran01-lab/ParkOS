-- DEV-ONLY verification for permit_payments and record_permit_payment.
-- Assertion-only: every check RAISES on failure, so a failure aborts the run
-- with its message. Everything runs inside a single transaction that ends in
-- ROLLBACK, so no fixture survives.
--
--   npx supabase db query --linked --file supabase/dev-only/20260829000000_verify_permit_payments.sql
--
-- Depends on the dev seed (20260819040100) for its two orgs and their admin
-- users; every other row it needs, it creates and then throws away:
--   Org A (Harbor Park Group)  = aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
--   Org B (Pier Point Parking) = bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
--   Org A admin user           = 00000000-0000-0000-0000-0000000000a1
--   Org B admin user           = 00000000-0000-0000-0000-0000000000b1
--
-- The permit under test bills $150.00/month, the real subscription price, so
-- every expected figure below is hand-computed against 15000 cents rather than
-- read back out of the same code path that wrote it.
--
-- auth.role() reads request.jwt.claims, so setting that claim is how these
-- checks impersonate the webhook's service-role client and, separately, a
-- browser that should be refused.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: one Org A facility with two permits.
--   P1 is billed and is the subject of the money checks. Its customer is linked
--      to the ORG B ADMIN's login -- a driver who happens to be staff somewhere
--      else -- which is what makes the "customer sees their own payment" policy
--      separable from the "org member sees the org's payments" policy.
--   P2 belongs to a different driver and is never paid; it exists so a
--      cross-org read has something it must NOT return.
-- ---------------------------------------------------------------------------

insert into public.facilities (id, org_id, name, timezone)
values ('dd000000-0000-0000-0000-0000000000d1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'Permit Test Lot', 'America/Los_Angeles');

insert into public.zones (id, org_id, facility_id, name)
values ('dd000000-0000-0000-0000-0000000000d2',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'dd000000-0000-0000-0000-0000000000d1', 'Permit Test Zone');

insert into public.spaces (id, org_id, zone_id, space_number)
values ('dd000000-0000-0000-0000-0000000000d3',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'dd000000-0000-0000-0000-0000000000d2', 'P001'),
       ('dd000000-0000-0000-0000-0000000000d4',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'dd000000-0000-0000-0000-0000000000d2', 'P002');

insert into public.customers (id, org_id, full_name, user_id)
values ('dd000000-0000-0000-0000-0000000000d5',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Permit Test Driver',
        '00000000-0000-0000-0000-0000000000b1'),
       ('dd000000-0000-0000-0000-0000000000d6',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Other Permit Driver', null);

insert into public.permits
  (id, org_id, facility_id, space_id, customer_id, during,
   monthly_rate_cents, currency, status, stripe_subscription_id)
values
  ('dd000000-0000-0000-0000-0000000000e1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'dd000000-0000-0000-0000-0000000000d1',
   'dd000000-0000-0000-0000-0000000000d3',
   'dd000000-0000-0000-0000-0000000000d5',
   tstzrange(now() - interval '1 month', null, '[)'),
   15000, 'USD', 'active', 'sub_devtest_permit_0001'),
  ('dd000000-0000-0000-0000-0000000000e2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'dd000000-0000-0000-0000-0000000000d1',
   'dd000000-0000-0000-0000-0000000000d4',
   'dd000000-0000-0000-0000-0000000000d6',
   tstzrange(now() - interval '1 month', null, '[)'),
   15000, 'USD', 'active', 'sub_devtest_permit_0002');


-- ---------------------------------------------------------------------------
-- CHECK 1 -- permit_payments is client-READ-ONLY, exactly like payments and
-- booth_payments. No INSERT/UPDATE/DELETE privilege, no non-SELECT policy, and
-- nothing at all for anon (whose default table grant this migration revokes).
-- ---------------------------------------------------------------------------
do $$
declare v int;
begin
  if not has_table_privilege('authenticated', 'public.permit_payments', 'SELECT')
     or has_table_privilege('authenticated', 'public.permit_payments', 'INSERT')
     or has_table_privilege('authenticated', 'public.permit_payments', 'UPDATE')
     or has_table_privilege('authenticated', 'public.permit_payments', 'DELETE') then
    raise exception 'CHECK1 FAIL: permit_payments must be SELECT-only for authenticated';
  end if;

  if has_table_privilege('anon', 'public.permit_payments', 'SELECT')
     or has_table_privilege('anon', 'public.permit_payments', 'INSERT')
     or has_table_privilege('anon', 'public.permit_payments', 'UPDATE')
     or has_table_privilege('anon', 'public.permit_payments', 'DELETE') then
    raise exception 'CHECK1 FAIL: anon holds a privilege on permit_payments';
  end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'permit_payments';
  if v <> 2 then
    raise exception 'CHECK1 FAIL: expected 2 permit_payments policies, found %', v;
  end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'permit_payments' and cmd <> 'SELECT';
  if v <> 0 then
    raise exception 'CHECK1 FAIL: permit_payments has a non-SELECT policy';
  end if;

  if not (select relrowsecurity from pg_class
           where oid = 'public.permit_payments'::regclass) then
    raise exception 'CHECK1 FAIL: RLS is not enabled on permit_payments';
  end if;

  raise notice 'CHECK1 PASS: permit_payments is RLS-enabled and client-read-only';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 2 -- record_permit_payment is not callable by a browser at all. This is
-- the grant, not the function body: Supabase's default privileges hand
-- `authenticated` EXECUTE on every new function, and the migration revokes it
-- by name (the failure mode 20260827000000 was written to fix).
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('authenticated',
       'public.record_permit_payment(text,uuid,text,text,integer,text,text,boolean)',
       'EXECUTE') then
    raise exception 'CHECK2 FAIL: authenticated holds EXECUTE on record_permit_payment';
  end if;
  if has_function_privilege('anon',
       'public.record_permit_payment(text,uuid,text,text,integer,text,text,boolean)',
       'EXECUTE') then
    raise exception 'CHECK2 FAIL: anon holds EXECUTE on record_permit_payment';
  end if;
  if not has_function_privilege('service_role',
       'public.record_permit_payment(text,uuid,text,text,integer,text,text,boolean)',
       'EXECUTE') then
    raise exception 'CHECK2 FAIL: service_role cannot execute record_permit_payment';
  end if;

  raise notice 'CHECK2 PASS: only service_role may execute record_permit_payment';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 3 -- and the body refuses a non-service caller even where EXECUTE was
-- somehow held. Belt and braces on the one function that can assert money moved.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

do $$
declare v_msg text;
begin
  begin
    perform public.record_permit_payment(
      'evt_devtest_reject', null, 'sub_devtest_permit_0001',
      'in_devtest_reject', 15000, 'usd', 'pi_devtest_reject', true);
    raise exception 'CHECK3 FAIL: a non-service caller recorded a payment';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'SERVICE_ROLE_REQUIRED' then raise; end if;
  end;

  raise notice 'CHECK3 PASS: the function body rejects a non-service-role caller';
end $$;


-- Act as the webhook's service-role client for every money check below.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);


-- ---------------------------------------------------------------------------
-- CHECK 4 -- input validation runs before anything is written. Each of these is
-- a payload we would rather reject loudly than book as revenue.
-- ---------------------------------------------------------------------------
do $$
declare v_msg text; v int;
begin
  begin
    perform public.record_permit_payment(
      '', null, 'sub_devtest_permit_0001', 'in_x', 15000, 'usd', null, true);
    raise exception 'CHECK4 FAIL: an empty event id was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'STRIPE_EVENT_ID_REQUIRED' then raise; end if;
  end;

  begin
    perform public.record_permit_payment(
      'evt_x', null, 'sub_devtest_permit_0001', null, 15000, 'usd', null, true);
    raise exception 'CHECK4 FAIL: a missing invoice id was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'STRIPE_INVOICE_ID_REQUIRED' then raise; end if;
  end;

  -- paid = false on a "payment_succeeded" event is a payload we do not
  -- understand. Booking it would invent revenue Stripe never collected.
  begin
    perform public.record_permit_payment(
      'evt_x', null, 'sub_devtest_permit_0001', 'in_x', 15000, 'usd', null, false);
    raise exception 'CHECK4 FAIL: an unpaid invoice was recorded as a payment';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'INVOICE_NOT_PAID' then raise; end if;
  end;

  begin
    perform public.record_permit_payment(
      'evt_x', null, 'sub_devtest_permit_0001', 'in_x', -1, 'usd', null, true);
    raise exception 'CHECK4 FAIL: a negative amount was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'INVALID_PAYMENT_AMOUNT' then raise; end if;
  end;

  begin
    perform public.record_permit_payment(
      'evt_x', null, 'sub_devtest_permit_0001', 'in_x', 15000, 'dollars', null, true);
    raise exception 'CHECK4 FAIL: a malformed currency was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'INVALID_CURRENCY' then raise; end if;
  end;

  begin
    perform public.record_permit_payment(
      'evt_x', null, 'sub_no_such_subscription', 'in_x', 15000, 'usd', null, true);
    raise exception 'CHECK4 FAIL: an unknown subscription resolved to a permit';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'PERMIT_NOT_FOUND' then raise; end if;
  end;

  begin
    perform public.record_permit_payment(
      'evt_x', null, null, 'in_x', 15000, 'usd', null, true);
    raise exception 'CHECK4 FAIL: a payload with no permit identifier was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'PERMIT_IDENTIFIER_REQUIRED' then raise; end if;
  end;

  -- Nothing above may have left a row or claimed an event behind.
  select count(*) into v from public.permit_payments;
  if v <> 0 then
    raise exception 'CHECK4 FAIL: a rejected payload still wrote % row(s)', v;
  end if;
  select count(*) into v from public.processed_stripe_events
   where event_id in ('', 'evt_x');
  if v <> 0 then
    raise exception 'CHECK4 FAIL: a rejected payload claimed % event(s)', v;
  end if;

  raise notice 'CHECK4 PASS: event id, invoice id, paid, amount, currency and permit identity all validated before any write';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 5 -- the happy path, resolved by SUBSCRIPTION ID alone (an invoice may
-- arrive with no permit_id metadata at all). A $150.00 monthly permit invoice
-- is 15000 cents; Stripe sends the currency lower-case and it is stored upper.
-- ---------------------------------------------------------------------------
do $$
declare
  v_result jsonb; v_payment_id uuid; v int;
  v_amount integer; v_currency text; v_status text; v_org uuid; v_permit uuid;
  v_intent text;
begin
  v_result := public.record_permit_payment(
    'evt_devtest_0001', null, 'sub_devtest_permit_0001',
    'in_devtest_0001', 15000, 'usd', 'pi_devtest_0001', true);

  if (v_result ->> 'processed')::boolean is not true then
    raise exception 'CHECK5 FAIL: a first, valid invoice was not processed: %', v_result;
  end if;
  if v_result ->> 'outcome' <> 'permit_payment_recorded' then
    raise exception 'CHECK5 FAIL: outcome was %, expected permit_payment_recorded',
      v_result ->> 'outcome';
  end if;

  v_payment_id := (v_result ->> 'payment_id')::uuid;

  select amount_cents, currency, status, org_id, permit_id, stripe_payment_intent_id
    into v_amount, v_currency, v_status, v_org, v_permit, v_intent
    from public.permit_payments where id = v_payment_id;

  -- Hand-computed: $150.00/month = 15000 cents, stored as USD, succeeded.
  if v_amount <> 15000 then
    raise exception 'CHECK5 FAIL: amount = %c, expected 15000c', v_amount;
  end if;
  if v_currency <> 'USD' then
    raise exception 'CHECK5 FAIL: currency = %, expected USD (upper-cased from usd)',
      v_currency;
  end if;
  if v_status <> 'succeeded' then
    raise exception 'CHECK5 FAIL: status = %, expected succeeded', v_status;
  end if;
  if v_intent <> 'pi_devtest_0001' then
    raise exception 'CHECK5 FAIL: payment intent = %, expected pi_devtest_0001', v_intent;
  end if;
  -- Resolved from the subscription id, so the org and permit must be P1's.
  if v_org <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' then
    raise exception 'CHECK5 FAIL: org_id = %, expected Org A', v_org;
  end if;
  if v_permit <> 'dd000000-0000-0000-0000-0000000000e1' then
    raise exception 'CHECK5 FAIL: permit_id = %, expected P1', v_permit;
  end if;

  select count(*) into v from public.audit_log
   where target_table = 'permit_payments' and target_id = v_payment_id
     and action = 'record_permit_payment' and actor_id is null;
  if v <> 1 then
    raise exception 'CHECK5 FAIL: the payment was not audited (% rows)', v;
  end if;

  -- The event is claimed, exactly as the sibling subscription processor does.
  select count(*) into v from public.processed_stripe_events
   where event_id = 'evt_devtest_0001';
  if v <> 1 then
    raise exception 'CHECK5 FAIL: the Stripe event was not claimed';
  end if;

  raise notice 'CHECK5 PASS: a $150.00 subscription invoice is recorded, upper-cased, audited, and event-claimed';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 6 -- IDEMPOTENCY, the reason this table has a unique invoice id.
--   6a: the SAME event delivered twice (Stripe's ordinary retry).
--   6b: the SAME invoice under a DIFFERENT event id (a replay or manual
--       resend, which the processed_stripe_events claim alone would NOT catch).
-- Either way: exactly one row, and no second audit entry.
-- ---------------------------------------------------------------------------
do $$
declare v_result jsonb; v int;
begin
  v_result := public.record_permit_payment(
    'evt_devtest_0001', null, 'sub_devtest_permit_0001',
    'in_devtest_0001', 15000, 'usd', 'pi_devtest_0001', true);

  if (v_result ->> 'processed')::boolean is not false
     or v_result ->> 'outcome' <> 'duplicate_event' then
    raise exception 'CHECK6a FAIL: a replayed event returned %', v_result;
  end if;

  select count(*) into v from public.permit_payments
   where stripe_invoice_id = 'in_devtest_0001';
  if v <> 1 then
    raise exception 'CHECK6a FAIL: replaying one event produced % rows, expected 1', v;
  end if;

  -- 6b: new event id, same invoice. The event claim succeeds and the unique
  -- constraint is what stops the double-booking.
  v_result := public.record_permit_payment(
    'evt_devtest_0002', null, 'sub_devtest_permit_0001',
    'in_devtest_0001', 15000, 'usd', 'pi_devtest_0001', true);

  if (v_result ->> 'processed')::boolean is not false
     or v_result ->> 'outcome' <> 'duplicate_invoice' then
    raise exception 'CHECK6b FAIL: a re-sent invoice returned %', v_result;
  end if;

  select count(*) into v from public.permit_payments
   where stripe_invoice_id = 'in_devtest_0001';
  if v <> 1 then
    raise exception 'CHECK6b FAIL: the same invoice under a new event id produced % rows, expected 1', v;
  end if;

  select count(*) into v from public.audit_log
   where target_table = 'permit_payments'
     and reason like 'in_devtest_0001 %';
  if v <> 1 then
    raise exception 'CHECK6b FAIL: % audit rows for one invoice, expected 1', v;
  end if;

  select sum(amount_cents) into v from public.permit_payments
   where permit_id = 'dd000000-0000-0000-0000-0000000000e1';
  if v <> 15000 then
    raise exception 'CHECK6b FAIL: permit revenue totals %c after replays, expected 15000c', v;
  end if;

  raise notice 'CHECK6 PASS: replaying an event and re-sending an invoice both leave exactly one 15000c row';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 7 -- the next billing period is a DIFFERENT invoice and must land as a
-- second row. Idempotency must not be so eager that month two disappears.
-- This one resolves by PERMIT ID, the other identifier an invoice can carry.
-- ---------------------------------------------------------------------------
do $$
declare v_result jsonb; v int; v_total integer;
begin
  v_result := public.record_permit_payment(
    'evt_devtest_0003', 'dd000000-0000-0000-0000-0000000000e1', null,
    'in_devtest_0002', 15000, 'usd', 'pi_devtest_0002', true);

  if (v_result ->> 'processed')::boolean is not true then
    raise exception 'CHECK7 FAIL: the second billing period was not recorded: %', v_result;
  end if;

  select count(*), sum(amount_cents) into v, v_total
    from public.permit_payments
   where permit_id = 'dd000000-0000-0000-0000-0000000000e1';
  if v <> 2 or v_total <> 30000 then
    raise exception 'CHECK7 FAIL: % rows totalling %c, expected 2 rows totalling 30000c',
      v, v_total;
  end if;

  raise notice 'CHECK7 PASS: a second invoice is a second row (2 rows, 30000c)';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 8 -- a payment on a CANCELLED permit is still recorded. Stripe already
-- took the money; refusing the row would lose it and make Stripe retry forever.
-- ---------------------------------------------------------------------------
do $$
declare v_result jsonb;
begin
  update public.permits set status = 'cancelled', cancelled_at = now()
   where id = 'dd000000-0000-0000-0000-0000000000e2';

  v_result := public.record_permit_payment(
    'evt_devtest_0004', null, 'sub_devtest_permit_0002',
    'in_devtest_0003', 15000, 'usd', null, true);

  if (v_result ->> 'processed')::boolean is not true then
    raise exception 'CHECK8 FAIL: money collected on a cancelled permit was dropped: %',
      v_result;
  end if;

  raise notice 'CHECK8 PASS: money collected against a cancelled permit is still booked';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 9 -- tenant isolation. The Org B admin is also the DRIVER on permit P1,
-- which separates the two SELECT policies cleanly: they may see their own
-- permit's payments and nothing else in Org A.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);

do $$
declare v int;
begin
  if public.get_user_role('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') is not null then
    raise exception 'CHECK9 FAIL: the Org B admin has a role in Org A';
  end if;

  -- Their own permit's two payments are visible...
  select count(*) into v from public.permit_payments
   where permit_id = 'dd000000-0000-0000-0000-0000000000e1';
  if v <> 2 then
    raise exception 'CHECK9 FAIL: driver sees % of their own 2 permit payments', v;
  end if;

  -- ...and the other driver's payment in the same org is not.
  select count(*) into v from public.permit_payments
   where permit_id = 'dd000000-0000-0000-0000-0000000000e2';
  if v <> 0 then
    raise exception 'CHECK9 FAIL: % permit payments leaked from another driver', v;
  end if;

  -- Every row they can see must belong to a permit of theirs.
  select count(*) into v from public.permit_payments pp
   where not exists (
     select 1 from public.permits p
      where p.id = pp.permit_id and public.is_own_customer(p.customer_id));
  if v <> 0 then
    raise exception 'CHECK9 FAIL: % permit payments leaked to a non-owner', v;
  end if;

  raise notice 'CHECK9 PASS: own-permit reads allowed, another driver''s payments invisible';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 10 -- a browser cannot execute the recorder at all. This is the grant
-- from CHECK2 observed from the client's side: a hard 42501, not a silent no-op.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    perform public.record_permit_payment(
      'evt_devtest_client', null, 'sub_devtest_permit_0001',
      'in_devtest_client', 15000, 'usd', null, true);
    raise exception 'CHECK10 FAIL: an authenticated browser executed record_permit_payment';
  exception when insufficient_privilege then
    null;
  end;

  raise notice 'CHECK10 PASS: record_permit_payment is not executable by a browser';
end $$;

-- ---------------------------------------------------------------------------
-- Summary. Reaching this line means every check above passed: each one RAISES
-- on failure, which aborts the run before here. The figures are printed as
-- evidence of what the fixtures actually produced -- the CLI does not surface
-- RAISE NOTICE, so without this the only signal would be "it did not crash".
--
-- Expected, hand-computed: three invoices at $150.00 (two billing periods on
-- permit P1 plus one on cancelled P2) = 3 rows, 45000 cents, 3 audit entries.
-- ---------------------------------------------------------------------------
reset role;

select
  'ALL CHECKS PASSED' as result,
  (select count(*) from public.permit_payments) as rows_written,
  (select sum(amount_cents) from public.permit_payments) as cents_recorded,
  (select count(*) from public.permit_payments
    where permit_id = 'dd000000-0000-0000-0000-0000000000e1') as p1_invoices,
  (select count(*) from public.audit_log a
    where a.action = 'record_permit_payment'
      and exists (select 1 from public.permit_payments pp
                   where pp.id = a.target_id)) as audit_rows;

rollback;
