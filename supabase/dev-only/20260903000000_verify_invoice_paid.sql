-- DEV-ONLY verification that subscribing to invoice.paid alongside
-- invoice.payment_succeeded books out-of-band money exactly once and never
-- double-books a normal payment.
--
--   npx supabase db query --linked --file supabase/dev-only/20260903000000_verify_invoice_paid.sql
--
-- Assertion-only: every check RAISES on failure, so a failure aborts the run
-- with its message. Everything runs inside one transaction ending in ROLLBACK,
-- so no fixture survives.
--
-- WHAT THIS IS ACTUALLY TESTING. record_permit_payment is UNCHANGED by this
-- commit; the change is which webhook events reach it. Stripe sends BOTH
-- invoice.paid and invoice.payment_succeeded for every successful payment, with
-- identical invoice data under DIFFERENT event ids, and sends invoice.paid
-- ALONE for an out-of-band payment. So the two properties that matter are:
--   * an out-of-band invoice (no PaymentIntent at all) still books, and
--   * the same invoice arriving twice under two event ids books ONCE.
-- The second is what makes subscribing to both events safe rather than a
-- revenue-doubling bug, so it is tested in BOTH delivery orders.
--
-- Depends on the dev seed (DEV_ONLY_seed_dev_orgs.sql) for Org A:
--   Org A (Harbor Park Group) = aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
--
-- The permit bills $150.00/month, the real subscription price, so every figure
-- below is hand-computed against 15000 cents rather than read back out of the
-- same code path that wrote it. Counts are reported as DELTAS against a
-- baseline captured before any fixture is written, so the file is correct
-- whether or not the table already holds rows.

begin;

-- ---------------------------------------------------------------------------
-- Baseline, captured before anything is written. Every expected figure below
-- is baseline + a hand-computed delta.
-- ---------------------------------------------------------------------------
create temporary table baseline on commit drop as
select
  (select count(*) from public.permit_payments)                   as rows0,
  (select coalesce(sum(amount_cents), 0) from public.permit_payments) as cents0,
  (select count(*) from public.audit_log
    where action = 'record_permit_payment')                       as audit0;

-- Per-scenario evidence. The CLI does not surface RAISE NOTICE, so the run's
-- only visible output is the SELECT at the bottom of this file.
create temporary table scenario_log (
  seq            integer generated always as identity,
  scenario       text,
  event_type     text,
  outcome        text,
  rows_before    bigint,
  rows_after     bigint,
  cents_before   bigint,
  cents_after    bigint,
  audit_after    bigint,
  intent_id      text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures: one Org A facility, one space, one active permit at $150.00.
-- ---------------------------------------------------------------------------
insert into public.facilities (id, org_id, name, timezone)
values ('cc000000-0000-0000-0000-0000000000c1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'Invoice Paid Test Lot', 'America/Los_Angeles');

insert into public.zones (id, org_id, facility_id, name)
values ('cc000000-0000-0000-0000-0000000000c2',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'cc000000-0000-0000-0000-0000000000c1', 'Invoice Paid Test Zone');

insert into public.spaces (id, org_id, zone_id, space_number)
values ('cc000000-0000-0000-0000-0000000000c3',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'cc000000-0000-0000-0000-0000000000c2', 'IP001');

insert into public.customers (id, org_id, full_name, user_id)
values ('cc000000-0000-0000-0000-0000000000c4',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Invoice Paid Driver', null);

insert into public.permits
  (id, org_id, facility_id, space_id, customer_id, during,
   monthly_rate_cents, currency, status, stripe_subscription_id)
values
  ('cc000000-0000-0000-0000-0000000000e1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'cc000000-0000-0000-0000-0000000000c1',
   'cc000000-0000-0000-0000-0000000000c3',
   'cc000000-0000-0000-0000-0000000000c4',
   tstzrange(now() - interval '1 month', null, '[)'),
   15000, 'USD', 'active', 'sub_devtest_invoicepaid_01');

-- Impersonate the webhook's service-role client for every call below.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- SCENARIO A -- OUT-OF-BAND payment. Arrives on invoice.paid ALONE, carries no
-- PaymentIntent because no charge was made. Must book exactly once, with
-- stripe_payment_intent_id NULL.
--
-- Hand-computed: baseline + 1 row, baseline + 15000 cents, baseline + 1 audit.
-- ---------------------------------------------------------------------------
do $$
declare
  v_result jsonb; v_rows_b bigint; v_rows_a bigint;
  v_cents_b bigint; v_cents_a bigint; v_audit bigint; v_intent text; v int;
begin
  select count(*), coalesce(sum(amount_cents), 0) into v_rows_b, v_cents_b
    from public.permit_payments;

  v_result := public.record_permit_payment(
    'evt_oob_paid_A', null, 'sub_devtest_invoicepaid_01',
    'in_oob_A', 15000, 'usd',
    null,          -- no PaymentIntent: paid_out_of_band makes no charge
    true);

  if (v_result ->> 'processed')::boolean is not true
     or v_result ->> 'outcome' <> 'permit_payment_recorded' then
    raise exception 'SCENARIO A FAIL: out-of-band invoice returned %', v_result;
  end if;

  select count(*), coalesce(sum(amount_cents), 0) into v_rows_a, v_cents_a
    from public.permit_payments;

  if v_rows_a <> v_rows_b + 1 then
    raise exception 'SCENARIO A FAIL: rows went % -> %, expected +1', v_rows_b, v_rows_a;
  end if;
  if v_cents_a <> v_cents_b + 15000 then
    raise exception 'SCENARIO A FAIL: cents went % -> %, expected +15000', v_cents_b, v_cents_a;
  end if;

  select stripe_payment_intent_id into v_intent
    from public.permit_payments where stripe_invoice_id = 'in_oob_A';
  if v_intent is not null then
    raise exception 'SCENARIO A FAIL: out-of-band row carries payment_intent %, expected NULL', v_intent;
  end if;

  select count(*) into v_audit from public.audit_log
   where action = 'record_permit_payment';

  insert into scenario_log
    (scenario, event_type, outcome, rows_before, rows_after,
     cents_before, cents_after, audit_after, intent_id)
  values ('A out-of-band', 'invoice.paid', v_result ->> 'outcome',
          v_rows_b, v_rows_a, v_cents_b, v_cents_a, v_audit, coalesce(v_intent, 'NULL'));
end $$;

-- ---------------------------------------------------------------------------
-- SCENARIO B -- NORMAL payment, delivered payment_succeeded FIRST then paid.
-- Two different event ids, one invoice. Must book exactly once; the second
-- delivery must return duplicate_invoice and write NO second audit row.
--
-- Hand-computed: first call +1 row / +15000c / +1 audit; second call +0 / +0 / +0.
-- ---------------------------------------------------------------------------
do $$
declare
  v_result jsonb; v_rows_b bigint; v_rows_a bigint;
  v_cents_b bigint; v_cents_a bigint; v_audit_b bigint; v_audit_a bigint;
begin
  select count(*), coalesce(sum(amount_cents), 0) into v_rows_b, v_cents_b
    from public.permit_payments;
  select count(*) into v_audit_b from public.audit_log
   where action = 'record_permit_payment';

  -- Delivery 1: invoice.payment_succeeded
  v_result := public.record_permit_payment(
    'evt_norm_B_succeeded', null, 'sub_devtest_invoicepaid_01',
    'in_both_B', 15000, 'usd', 'pi_both_B', true);
  if v_result ->> 'outcome' <> 'permit_payment_recorded' then
    raise exception 'SCENARIO B FAIL: first delivery returned %', v_result;
  end if;

  select count(*), coalesce(sum(amount_cents), 0) into v_rows_a, v_cents_a
    from public.permit_payments;
  select count(*) into v_audit_a from public.audit_log
   where action = 'record_permit_payment';
  if v_rows_a <> v_rows_b + 1 or v_cents_a <> v_cents_b + 15000
     or v_audit_a <> v_audit_b + 1 then
    raise exception 'SCENARIO B FAIL: first delivery did not book exactly one row';
  end if;

  insert into scenario_log
    (scenario, event_type, outcome, rows_before, rows_after,
     cents_before, cents_after, audit_after, intent_id)
  values ('B succeeded->paid', 'invoice.payment_succeeded', v_result ->> 'outcome',
          v_rows_b, v_rows_a, v_cents_b, v_cents_a, v_audit_a, 'pi_both_B');

  -- Delivery 2: invoice.paid, SAME invoice, DIFFERENT event id. This is the
  -- delivery that the processed_stripe_events claim cannot catch.
  v_rows_b := v_rows_a; v_cents_b := v_cents_a; v_audit_b := v_audit_a;

  v_result := public.record_permit_payment(
    'evt_norm_B_paid', null, 'sub_devtest_invoicepaid_01',
    'in_both_B', 15000, 'usd', 'pi_both_B', true);

  if (v_result ->> 'processed')::boolean is not false
     or v_result ->> 'outcome' <> 'duplicate_invoice' then
    raise exception 'SCENARIO B FAIL: second delivery returned %, expected duplicate_invoice', v_result;
  end if;

  select count(*), coalesce(sum(amount_cents), 0) into v_rows_a, v_cents_a
    from public.permit_payments;
  select count(*) into v_audit_a from public.audit_log
   where action = 'record_permit_payment';

  if v_rows_a <> v_rows_b then
    raise exception 'SCENARIO B FAIL: second delivery added % row(s), expected 0', v_rows_a - v_rows_b;
  end if;
  if v_cents_a <> v_cents_b then
    raise exception 'SCENARIO B FAIL: second delivery added % cents, expected 0', v_cents_a - v_cents_b;
  end if;
  if v_audit_a <> v_audit_b then
    raise exception 'SCENARIO B FAIL: second delivery wrote % audit row(s), expected 0', v_audit_a - v_audit_b;
  end if;

  insert into scenario_log
    (scenario, event_type, outcome, rows_before, rows_after,
     cents_before, cents_after, audit_after, intent_id)
  values ('B succeeded->paid', 'invoice.paid', v_result ->> 'outcome',
          v_rows_b, v_rows_a, v_cents_b, v_cents_a, v_audit_a, 'pi_both_B');
end $$;

-- ---------------------------------------------------------------------------
-- SCENARIO C -- the REVERSE order: invoice.paid arrives FIRST, then
-- invoice.payment_succeeded. Stripe does not guarantee delivery order, so
-- neither event may depend on being the one that arrives first.
--
-- Hand-computed: identical to B -- +1 row then +0.
-- ---------------------------------------------------------------------------
do $$
declare
  v_result jsonb; v_rows_b bigint; v_rows_a bigint;
  v_cents_b bigint; v_cents_a bigint; v_audit_b bigint; v_audit_a bigint;
begin
  select count(*), coalesce(sum(amount_cents), 0) into v_rows_b, v_cents_b
    from public.permit_payments;
  select count(*) into v_audit_b from public.audit_log
   where action = 'record_permit_payment';

  -- Delivery 1: invoice.paid
  v_result := public.record_permit_payment(
    'evt_norm_C_paid', null, 'sub_devtest_invoicepaid_01',
    'in_both_C', 15000, 'usd', 'pi_both_C', true);
  if v_result ->> 'outcome' <> 'permit_payment_recorded' then
    raise exception 'SCENARIO C FAIL: first delivery returned %', v_result;
  end if;

  select count(*), coalesce(sum(amount_cents), 0) into v_rows_a, v_cents_a
    from public.permit_payments;
  select count(*) into v_audit_a from public.audit_log
   where action = 'record_permit_payment';
  if v_rows_a <> v_rows_b + 1 or v_cents_a <> v_cents_b + 15000
     or v_audit_a <> v_audit_b + 1 then
    raise exception 'SCENARIO C FAIL: first delivery did not book exactly one row';
  end if;

  insert into scenario_log
    (scenario, event_type, outcome, rows_before, rows_after,
     cents_before, cents_after, audit_after, intent_id)
  values ('C paid->succeeded', 'invoice.paid', v_result ->> 'outcome',
          v_rows_b, v_rows_a, v_cents_b, v_cents_a, v_audit_a, 'pi_both_C');

  -- Delivery 2: invoice.payment_succeeded, same invoice, new event id.
  v_rows_b := v_rows_a; v_cents_b := v_cents_a; v_audit_b := v_audit_a;

  v_result := public.record_permit_payment(
    'evt_norm_C_succeeded', null, 'sub_devtest_invoicepaid_01',
    'in_both_C', 15000, 'usd', 'pi_both_C', true);

  if (v_result ->> 'processed')::boolean is not false
     or v_result ->> 'outcome' <> 'duplicate_invoice' then
    raise exception 'SCENARIO C FAIL: second delivery returned %, expected duplicate_invoice', v_result;
  end if;

  select count(*), coalesce(sum(amount_cents), 0) into v_rows_a, v_cents_a
    from public.permit_payments;
  select count(*) into v_audit_a from public.audit_log
   where action = 'record_permit_payment';

  if v_rows_a <> v_rows_b or v_cents_a <> v_cents_b or v_audit_a <> v_audit_b then
    raise exception 'SCENARIO C FAIL: reverse order double-booked: rows +%, cents +%, audit +%',
      v_rows_a - v_rows_b, v_cents_a - v_cents_b, v_audit_a - v_audit_b;
  end if;

  insert into scenario_log
    (scenario, event_type, outcome, rows_before, rows_after,
     cents_before, cents_after, audit_after, intent_id)
  values ('C paid->succeeded', 'invoice.payment_succeeded', v_result ->> 'outcome',
          v_rows_b, v_rows_a, v_cents_b, v_cents_a, v_audit_a, 'pi_both_C');
end $$;

-- ---------------------------------------------------------------------------
-- SCENARIO D -- an ordinary single-delivery payment is unaffected: it still
-- books normally, with its PaymentIntent intact.
--
-- Hand-computed: +1 row / +15000c / +1 audit, intent pi_norm_D.
-- ---------------------------------------------------------------------------
do $$
declare
  v_result jsonb; v_rows_b bigint; v_rows_a bigint;
  v_cents_b bigint; v_cents_a bigint; v_audit bigint; v_intent text;
begin
  select count(*), coalesce(sum(amount_cents), 0) into v_rows_b, v_cents_b
    from public.permit_payments;

  v_result := public.record_permit_payment(
    'evt_norm_D', null, 'sub_devtest_invoicepaid_01',
    'in_norm_D', 15000, 'usd', 'pi_norm_D', true);

  if v_result ->> 'outcome' <> 'permit_payment_recorded' then
    raise exception 'SCENARIO D FAIL: a normal payment returned %', v_result;
  end if;

  select count(*), coalesce(sum(amount_cents), 0) into v_rows_a, v_cents_a
    from public.permit_payments;
  select stripe_payment_intent_id into v_intent
    from public.permit_payments where stripe_invoice_id = 'in_norm_D';
  select count(*) into v_audit from public.audit_log
   where action = 'record_permit_payment';

  if v_rows_a <> v_rows_b + 1 or v_cents_a <> v_cents_b + 15000 then
    raise exception 'SCENARIO D FAIL: a normal payment did not book exactly one row';
  end if;
  if v_intent is distinct from 'pi_norm_D' then
    raise exception 'SCENARIO D FAIL: payment_intent = %, expected pi_norm_D', v_intent;
  end if;

  insert into scenario_log
    (scenario, event_type, outcome, rows_before, rows_after,
     cents_before, cents_after, audit_after, intent_id)
  values ('D normal single', 'invoice.payment_succeeded', v_result ->> 'outcome',
          v_rows_b, v_rows_a, v_cents_b, v_cents_a, v_audit, coalesce(v_intent, 'NULL'));
end $$;

-- ---------------------------------------------------------------------------
-- TOTALS, hand-computed against the baseline.
--
-- Four distinct invoices were presented across six deliveries:
--   in_oob_A  (1 delivery)  -> books
--   in_both_B (2 deliveries) -> books once
--   in_both_C (2 deliveries) -> books once
--   in_norm_D (1 delivery)  -> books
-- So: baseline + 4 rows, baseline + 60000 cents ($600.00 = 4 x $150.00),
-- baseline + 4 audit rows. Six deliveries, four rows: the two extra deliveries
-- are the duplicates that must not have become revenue.
-- ---------------------------------------------------------------------------
do $$
declare v_rows bigint; v_cents bigint; v_audit bigint; b record;
begin
  select * into b from baseline;
  select count(*), coalesce(sum(amount_cents), 0) into v_rows, v_cents
    from public.permit_payments;
  select count(*) into v_audit from public.audit_log
   where action = 'record_permit_payment';

  if v_rows <> b.rows0 + 4 then
    raise exception 'TOTALS FAIL: % rows, expected % (baseline % + 4)', v_rows, b.rows0 + 4, b.rows0;
  end if;
  if v_cents <> b.cents0 + 60000 then
    raise exception 'TOTALS FAIL: % cents, expected % (baseline % + 60000)', v_cents, b.cents0 + 60000, b.cents0;
  end if;
  if v_audit <> b.audit0 + 4 then
    raise exception 'TOTALS FAIL: % audit rows, expected % (baseline % + 4)', v_audit, b.audit0 + 4, b.audit0;
  end if;
end $$;

reset role;

-- The CLI surfaces only the LAST result set, so the per-scenario evidence and
-- the totals are unioned into one table rather than selected separately.
select
  s.seq::text                        as seq,
  s.scenario                         as scenario,
  s.event_type                       as event_type,
  s.outcome                          as outcome,
  (s.rows_after - s.rows_before)::text   as rows_delta,
  (s.cents_after - s.cents_before)::text as cents_delta,
  s.intent_id                        as payment_intent
from scenario_log s

union all

select
  '=',
  'TOTAL (vs baseline)',
  '6 deliveries / 4 invoices',
  'ALL CHECKS PASSED',
  ((select count(*) from public.permit_payments) - b.rows0)::text,
  ((select coalesce(sum(amount_cents), 0) from public.permit_payments) - b.cents0)::text,
  'audit rows +'
    || ((select count(*) from public.audit_log
          where action = 'record_permit_payment') - b.audit0)::text
from baseline b

order by seq;

rollback;
