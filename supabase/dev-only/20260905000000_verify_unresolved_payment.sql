-- DEV-ONLY verification that a Stripe charge ParkOS cannot resolve is
-- acknowledged instead of crashing the webhook, and that the charges it CAN
-- resolve are recorded exactly as before.
--
--   npm run verify:unresolved-payment
--
-- Assertion-only: every check RAISES on failure. One transaction, ends in
-- ROLLBACK, so no fixture survives.
--
-- WHAT WAS BROKEN. process_stripe_event raised PAYMENT_NOT_FOUND whenever the
-- charge did not resolve to a public.payments row. PostgREST surfaced that as
-- an error, the webhook returned 500, and Stripe retried an event that could
-- never apply -- for days. A permit refund issued from the Stripe Dashboard is
-- the reachable case: permit money lives in permit_payments, so its payment
-- intent is not in public.payments and never will be.
--
-- HAND-COMPUTED EXPECTATIONS. Every number below is derived from the payment
-- fixture, not read back out of the function:
--
--   CHECK 1  reservation R1, total 4500c USD, payment P1 pending
--            checkout.session.completed(4500, usd) -> 4500 = P1.amount_cents
--            = R1.total_cents and USD = USD = USD, so amount_currency_match is
--            true, payment -> succeeded, reservation pending -> confirmed.
--            charge.refunded(amount 4500, refunded 4500): refund_total = 4500,
--            4500 >= 4500 -> 'refunded', outcome 'payment_refunded'.
--   CHECK 2  payment P2 succeeded, 4500c. charge.refunded(4500, 1500):
--            refund_total = 4500, 1500 < 4500 and 1500 > 0 ->
--            'partially_refunded', outcome 'payment_partially_refunded'.
--   CHECK 3  permit PM1 has a permit_payments row carrying
--            pi_devtest_permit_0001. public.payments has no row with that
--            intent, so resolution misses: processed false, outcome
--            'payment_not_found', NO exception, and nothing written anywhere.
--   CHECK 4  pi_devtest_unknown_0001 exists in neither table: same answer.
--   CHECK 5  the raise sat in the resolution block SHARED by all six routed
--            event types, so all six must answer 'payment_not_found' on a miss,
--            not just charge.refunded. Being handed no identifier at all is
--            still a raise. And no unresolved event may claim an event id --
--            the only claims allowed are the three events that DID resolve in
--            checks 1 and 2.
--   CHECK 6  all six permit event routes acknowledge subscription-only misses
--            without any table changing, including on repeated delivery.
--   CHECK 7  absent/blank identifiers, explicit missing permit ids, mismatches
--            and untrusted callers remain errors in both permit processors.
--   CHECK 8  previously ignored ids can be replayed after subscription binding:
--            one 15000c payment, one audit and one activation; then deduplication.
--
-- Depends on the dev seed (DEV_ONLY_seed_dev_orgs.sql) for Org A:
--   Org A (Harbor Park Group) = aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa

begin;

-- ---------------------------------------------------------------------------
-- Fixture. Own facility/zone/spaces so nothing here collides with seed data.
-- ---------------------------------------------------------------------------
insert into public.facilities (id, org_id, name, timezone)
values ('fd000000-0000-0000-0000-0000000000f1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'Unresolved Charge Lot', 'America/Los_Angeles');

insert into public.zones (id, org_id, facility_id, name)
values ('fd000000-0000-0000-0000-0000000000f2',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'fd000000-0000-0000-0000-0000000000f1', 'Unresolved Charge Zone');

insert into public.spaces (id, org_id, zone_id, space_number)
values
  ('fd000000-0000-0000-0000-0000000000a1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fd000000-0000-0000-0000-0000000000f2', 'UC-1'),
  ('fd000000-0000-0000-0000-0000000000a2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fd000000-0000-0000-0000-0000000000f2', 'UC-2'),
  ('fd000000-0000-0000-0000-0000000000a3',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fd000000-0000-0000-0000-0000000000f2', 'UC-3');

insert into public.customers (id, org_id, full_name)
values ('fd000000-0000-0000-0000-0000000000c1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Unresolved Charge Driver');

-- R1 stays 'pending' so CHECK 1 can drive the WHOLE legitimate path:
-- completion confirms the reservation, then the refund lands on it.
insert into public.reservations
  (id, org_id, facility_id, space_id, customer_id, during, status,
   booking_code, price_breakdown, total_cents, currency)
values
  ('fd000000-0000-0000-0000-0000000000d1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fd000000-0000-0000-0000-0000000000f1',
   'fd000000-0000-0000-0000-0000000000a1',
   'fd000000-0000-0000-0000-0000000000c1',
   tstzrange(now() - interval '1 hour', now() + interval '1 hour', '[)'),
   'pending', 'PKS-UNRESA',
   '{"currency":"USD","line_items":[],"total_cents":4500}', 4500, 'USD'),
  ('fd000000-0000-0000-0000-0000000000d2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fd000000-0000-0000-0000-0000000000f1',
   'fd000000-0000-0000-0000-0000000000a2',
   'fd000000-0000-0000-0000-0000000000c1',
   tstzrange(now() - interval '3 hours', now() - interval '2 hours', '[)'),
   'confirmed', 'PKS-UNRESB',
   '{"currency":"USD","line_items":[],"total_cents":4500}', 4500, 'USD');

insert into public.payments
  (id, org_id, reservation_id, stripe_checkout_session_id,
   stripe_payment_intent_id, amount_cents, currency, status)
values
  ('fd000000-0000-0000-0000-0000000000e1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fd000000-0000-0000-0000-0000000000d1',
   'cs_devtest_unres_0001', null, 4500, 'USD', 'pending'),
  ('fd000000-0000-0000-0000-0000000000e2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fd000000-0000-0000-0000-0000000000d2',
   'cs_devtest_unres_0002', 'pi_devtest_res_0002', 4500, 'USD', 'succeeded');

-- The permit whose money lives in the OTHER table. This is the Dashboard-refund
-- case: pi_devtest_permit_0001 is a real ParkOS payment intent that public
-- .payments has never heard of.
insert into public.permits
  (id, org_id, facility_id, space_id, customer_id, during,
   monthly_rate_cents, currency, status, stripe_subscription_id)
values ('fd000000-0000-0000-0000-0000000000b1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'fd000000-0000-0000-0000-0000000000f1',
        'fd000000-0000-0000-0000-0000000000a3',
        'fd000000-0000-0000-0000-0000000000c1',
        tstzrange(now() - interval '1 month', null, '[)'),
        15000, 'USD', 'active', 'sub_devtest_unres_0001');

insert into public.permit_payments
  (id, org_id, permit_id, stripe_invoice_id, stripe_payment_intent_id,
   amount_cents, currency)
values ('fd000000-0000-0000-0000-0000000000b2',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'fd000000-0000-0000-0000-0000000000b1',
        'in_devtest_unres_0001', 'pi_devtest_permit_0001', 15000, 'USD');

-- Baseline row counts for CHECK 3, taken before any event is applied.
create temporary table baseline on commit drop as
select (select count(*) from public.processed_stripe_events) as events,
       (select count(*) from public.payments)                as payments,
       (select count(*) from public.permit_payments)         as permit_payments;

-- Act as the webhook's service-role client for every call below.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);


-- ---------------------------------------------------------------------------
-- CHECK 1 -- the path that works still works, end to end. A real reservation
-- payment completes, confirms its reservation, and its full refund records as
-- 'refunded'. This is the check that fails if the crash was "fixed" by
-- weakening resolution.
-- ---------------------------------------------------------------------------
do $$
declare
  v_done jsonb; v_refund jsonb; v_status text; v_res public.reservation_status;
begin
  v_done := public.process_stripe_event(
    'evt_devtest_unres_complete', 'checkout.session.completed',
    'fd000000-0000-0000-0000-0000000000e1'::uuid,
    'fd000000-0000-0000-0000-0000000000d1'::uuid,
    'cs_devtest_unres_0001', 'pi_devtest_res_0001', 4500, 'usd', null);

  if v_done ->> 'outcome' <> 'payment_succeeded_reservation_confirmed'
     or (v_done ->> 'processed')::boolean is not true
     or (v_done ->> 'amount_currency_match')::boolean is not true then
    raise exception 'CHECK1 FAIL: completion returned %', v_done;
  end if;

  v_refund := public.process_stripe_event(
    'evt_devtest_unres_refund_full', 'charge.refunded',
    null, null, null, 'pi_devtest_res_0001', 4500, 'usd', 4500);

  select p.status into v_status
    from public.payments p where p.id = 'fd000000-0000-0000-0000-0000000000e1';
  select r.status into v_res
    from public.reservations r
   where r.id = 'fd000000-0000-0000-0000-0000000000d1';

  if (v_refund ->> 'processed')::boolean is not true
     or v_refund ->> 'outcome' <> 'payment_refunded'
     or v_status <> 'refunded' then
    raise exception 'CHECK1 FAIL: refund returned % leaving payment status %',
      v_refund, v_status;
  end if;
  if v_res <> 'confirmed' then
    raise exception 'CHECK1 FAIL: reservation ended %, expected confirmed', v_res;
  end if;
  if not exists (select 1 from public.processed_stripe_events e
                  where e.event_id = 'evt_devtest_unres_refund_full') then
    raise exception 'CHECK1 FAIL: a resolved refund did not claim its event id';
  end if;

  raise notice 'CHECK1 PASS: reservation refund still records (4500/4500 -> refunded)';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 2 -- the partial arm is intact too. 1500 of 4500 is
-- 'partially_refunded', not 'refunded' and not a no-op.
-- ---------------------------------------------------------------------------
do $$
declare v_refund jsonb; v_status text;
begin
  v_refund := public.process_stripe_event(
    'evt_devtest_unres_refund_part', 'charge.refunded',
    null, null, null, 'pi_devtest_res_0002', 4500, 'usd', 1500);

  select p.status into v_status
    from public.payments p where p.id = 'fd000000-0000-0000-0000-0000000000e2';

  if (v_refund ->> 'processed')::boolean is not true
     or v_refund ->> 'outcome' <> 'payment_partially_refunded'
     or v_status <> 'partially_refunded' then
    raise exception 'CHECK2 FAIL: partial refund returned % leaving status %',
      v_refund, v_status;
  end if;

  raise notice 'CHECK2 PASS: partial reservation refund still records (1500/4500)';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 3 -- THE BUG. A permit refund from the Stripe Dashboard. Before this
-- migration the call below raised PAYMENT_NOT_FOUND and the webhook 500'd
-- forever. It must now answer, write nothing, and claim no event.
-- ---------------------------------------------------------------------------
do $$
declare
  v_result jsonb; v_msg text; v_permit_status text; v_payments bigint;
begin
  begin
    v_result := public.process_stripe_event(
      'evt_devtest_unres_permit', 'charge.refunded',
      null, null, null, 'pi_devtest_permit_0001', 15000, 'usd', 15000);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'CHECK3 FAIL: a permit charge.refunded still raises %', v_msg;
  end;

  if (v_result ->> 'processed')::boolean is not false
     or v_result ->> 'outcome' <> 'payment_not_found' then
    raise exception 'CHECK3 FAIL: expected processed=false payment_not_found, got %',
      v_result;
  end if;

  -- Nothing anywhere may have moved: this commit stops the crash, it does not
  -- build the permit refund ledger.
  select pp.status into v_permit_status
    from public.permit_payments pp
   where pp.id = 'fd000000-0000-0000-0000-0000000000b2';
  if v_permit_status <> 'succeeded' then
    raise exception 'CHECK3 FAIL: the permit payment row changed to %', v_permit_status;
  end if;
  if exists (select 1 from public.processed_stripe_events e
              where e.event_id = 'evt_devtest_unres_permit') then
    raise exception 'CHECK3 FAIL: an unresolved event claimed an event id';
  end if;
  select count(*) into v_payments from public.payments;
  if v_payments <> (select b.payments from baseline b) then
    raise exception 'CHECK3 FAIL: payments row count moved to %', v_payments;
  end if;
  select count(*) into v_payments from public.permit_payments;
  if v_payments <> (select b.permit_payments from baseline b) then
    raise exception 'CHECK3 FAIL: permit_payments row count moved to %', v_payments;
  end if;

  raise notice 'CHECK3 PASS: permit charge.refunded answers payment_not_found, writes nothing';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 4 -- a charge belonging to neither table. Another product on the same
-- Stripe account, or a charge created straight from the Dashboard.
-- ---------------------------------------------------------------------------
do $$
declare v_result jsonb; v_msg text;
begin
  begin
    v_result := public.process_stripe_event(
      'evt_devtest_unres_foreign', 'charge.refunded',
      null, null, null, 'pi_devtest_unknown_0001', 2000, 'usd', 2000);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'CHECK4 FAIL: a foreign charge.refunded still raises %', v_msg;
  end;

  if (v_result ->> 'processed')::boolean is not false
     or v_result ->> 'outcome' <> 'payment_not_found' then
    raise exception 'CHECK4 FAIL: expected processed=false payment_not_found, got %',
      v_result;
  end if;
  if exists (select 1 from public.processed_stripe_events e
              where e.event_id = 'evt_devtest_unres_foreign') then
    raise exception 'CHECK4 FAIL: an unresolved event claimed an event id';
  end if;

  raise notice 'CHECK4 PASS: a charge in neither table answers payment_not_found';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 5 -- the guard is at the SHARED resolution site, not in the
-- charge.refunded arm. Every routed event type must survive a miss. A second
-- live instance rides on this: create-checkout-session creates the Stripe
-- session BEFORE inserting the payments row and expires it if that insert
-- fails, so checkout.session.expired arrives for a session that has no payment
-- row and used to 500 identically.
--
-- Also pinned here: no identifier at all is STILL a raise (a payload we do not
-- understand is not the same as an event that is not ours), and the whole run
-- claimed exactly the 3 event ids that resolved.
-- ---------------------------------------------------------------------------
do $$
declare
  v_type text; v_result jsonb; v_msg text; n integer := 0;
  v_events bigint;
begin
  foreach v_type in array array[
    'checkout.session.completed',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
    'payment_intent.payment_failed',
    'charge.failed',
    'charge.refunded'
  ] loop
    n := n + 1;
    begin
      -- Session events resolve by session id, the rest by payment intent; feed
      -- each the identifier its own branch of normalizeEvent would supply.
      if v_type like 'checkout.session.%' then
        v_result := public.process_stripe_event(
          'evt_devtest_unres_shared_' || n, v_type,
          null, null, 'cs_devtest_unknown_' || n, null, 2000, 'usd', 2000);
      else
        v_result := public.process_stripe_event(
          'evt_devtest_unres_shared_' || n, v_type,
          null, null, null, 'pi_devtest_unknown_' || n, 2000, 'usd', 2000);
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'CHECK5 FAIL: % on a miss still raises %', v_type, v_msg;
    end;

    if (v_result ->> 'processed')::boolean is not false
       or v_result ->> 'outcome' <> 'payment_not_found' then
      raise exception 'CHECK5 FAIL: % on a miss returned %', v_type, v_result;
    end if;
  end loop;

  -- No identifier at all: still a raise, deliberately.
  begin
    perform public.process_stripe_event(
      'evt_devtest_unres_noid', 'charge.refunded',
      null, null, null, null, 2000, 'usd', 2000);
    raise exception 'CHECK5 FAIL: a call with no identifier was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'PAYMENT_IDENTIFIER_REQUIRED' then raise; end if;
  end;

  -- Stated as "no UNRESOLVED event claimed an id" rather than "the table grew
  -- by exactly 3", so this holds when CHECK 5 is run on its own as well as
  -- after checks 1 and 2. The three resolved ids are the only ones allowed.
  select count(*) into v_events
    from public.processed_stripe_events e
   where e.event_id like 'evt\_devtest\_unres\_%'
     and e.event_id not in ('evt_devtest_unres_complete',
                            'evt_devtest_unres_refund_full',
                            'evt_devtest_unres_refund_part');
  if v_events <> 0 then
    raise exception
      'CHECK5 FAIL: % unresolved event(s) claimed an event id, expected 0',
      v_events;
  end if;

  raise notice 'CHECK5 PASS: all 6 routed types survive a miss; only the 3 resolved events claimed ids';
end $$;


-- The permit processors acknowledge subscription-only misses too. Snapshot the
-- full affected tables, not only their counts: an UPDATE must not pass as a no-op.
create temporary view permit_event_state as
select jsonb_build_object(
  'permits', (select jsonb_agg(to_jsonb(p) order by p.id) from public.permits p),
  'permit_payments', (select jsonb_agg(to_jsonb(p) order by p.id) from public.permit_payments p),
  'payments', (select jsonb_agg(to_jsonb(p) order by p.id) from public.payments p),
  'reservations', (select jsonb_agg(to_jsonb(r) order by r.id) from public.reservations r),
  'holds', (select jsonb_agg(to_jsonb(h) order by h.id) from public.space_holds h),
  'events', (select jsonb_agg(to_jsonb(e) order by e.event_id) from public.processed_stripe_events e),
  'audit', (select jsonb_agg(to_jsonb(a) order by a.id) from public.audit_log a)
) as state;

-- CHECK 6: all six permit routes and repeated deliveries return an explicit
-- no-op. None may claim the event id or change any money, lifecycle or audit row.
do $$
declare
  v_type text; v_result jsonb; v_before jsonb; v_attempt integer;
begin
  select state into strict v_before from permit_event_state;
  foreach v_type in array array[
    'invoice.paid', 'invoice.payment_succeeded',
    'customer.subscription.created', 'customer.subscription.updated',
    'customer.subscription.deleted', 'invoice.payment_failed'
  ] loop
    for v_attempt in 1..2 loop
      begin
        if v_type in ('invoice.paid', 'invoice.payment_succeeded') then
          v_result := public.record_permit_payment(
            'evt_unrelated_permit_' || v_type, null, 'sub_unrelated_permit',
            'in_unrelated_permit', 15000, 'usd', 'pi_unrelated_permit', true);
        else
          v_result := public.process_stripe_subscription_event(
            'evt_unrelated_permit_' || v_type, v_type, null,
            'sub_unrelated_permit', 'active',
            '2026-09-01T00:00Z', '2026-10-01T00:00Z', null);
        end if;
      exception when others then
        raise exception 'UNRELATED PERMIT FAIL: % still raises %', v_type, sqlerrm;
      end;
      if v_result is distinct from '{"processed":false,"outcome":"permit_not_found"}'::jsonb then
        raise exception 'UNRELATED PERMIT FAIL: % returned %', v_type, v_result;
      end if;
      if (select state from permit_event_state) is distinct from v_before then
        raise exception 'UNRELATED PERMIT FAIL: % wrote database state', v_type;
      end if;
    end loop;
  end loop;
  raise notice 'CHECK6 PASS: six unrelated permit routes, twice each, no state changes';
end $$;

-- CHECK 7: missing/blank identifiers are malformed, while an explicit ParkOS
-- permit id that cannot be resolved is still a retryable processing failure.
-- Mismatched ids and an untrusted role must also retain their original errors.
do $$
declare
  v_processor text; v_case record; v_before jsonb; v_message text; v_code text;
begin
  select state into strict v_before from permit_event_state;
  foreach v_processor in array array['record_permit_payment', 'process_stripe_subscription_event'] loop
    for v_case in
      select * from (values
        (null::uuid, null::text, 'service_role', '22023', 'PERMIT_IDENTIFIER_REQUIRED'),
        (null::uuid, '', 'service_role', '22023', 'PERMIT_IDENTIFIER_REQUIRED'),
        (null::uuid, '   ', 'service_role', '22023', 'PERMIT_IDENTIFIER_REQUIRED'),
        ('fd000000-0000-0000-0000-000000000099'::uuid, null, 'service_role', 'P0002', 'PERMIT_NOT_FOUND'),
        ('fd000000-0000-0000-0000-000000000099'::uuid, 'sub_devtest_unres_0001', 'service_role', 'P0002', 'PERMIT_NOT_FOUND'),
        ('fd000000-0000-0000-0000-0000000000b1'::uuid, 'sub_wrong', 'service_role', 'P0001', 'PERMIT_IDENTIFIER_MISMATCH'),
        (null::uuid, 'sub_unrelated_permit', 'authenticated', 'P0001', 'SERVICE_ROLE_REQUIRED')
      ) as cases(permit_id, subscription_id, claim_role, expected_code, expected_message)
    loop
      perform set_config('request.jwt.claims', jsonb_build_object('role', v_case.claim_role)::text, true);
      begin
        if v_processor = 'record_permit_payment' then
          perform public.record_permit_payment(
            'evt_unrelated_permit_invalid', v_case.permit_id, v_case.subscription_id,
            'in_unrelated_permit_invalid', 15000, 'usd', null, true);
        else
          perform public.process_stripe_subscription_event(
            'evt_unrelated_permit_invalid', 'customer.subscription.updated',
            v_case.permit_id, v_case.subscription_id, 'active');
        end if;
        raise exception 'unexpected success';
      exception when others then
        get stacked diagnostics v_message = message_text, v_code = returned_sqlstate;
        if v_code is distinct from v_case.expected_code
           or v_message is distinct from v_case.expected_message then
          raise exception 'PERMIT ERROR FAIL: % expected %/%, got %/%',
            v_processor, v_case.expected_code, v_case.expected_message, v_code, v_message;
        end if;
      end;
      if (select state from permit_event_state) is distinct from v_before then
        raise exception 'PERMIT ERROR FAIL: % changed database state', v_processor;
      end if;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'CHECK7 PASS: both processors retain identifier and authorization errors';
end $$;

-- CHECK 8: no-op delivery did not consume either event id. Once the subscription
-- can be resolved, replay the SAME ids and require actual ledger/lifecycle writes.
-- A further delivery must be deduplicated, without changing rows or audit history.
do $$
declare
  v_result jsonb; v_after jsonb; v_payments bigint; v_audits bigint; v_events bigint;
begin
  select count(*) into v_payments from public.permit_payments;
  select count(*) into v_audits from public.audit_log;
  select count(*) into v_events from public.processed_stripe_events;
  update public.permits
     set stripe_subscription_id = 'sub_unrelated_permit', status = 'suspended'
   where id = 'fd000000-0000-0000-0000-0000000000b1';

  v_result := public.record_permit_payment(
    'evt_unrelated_permit_invoice.paid', null, 'sub_unrelated_permit',
    'in_unrelated_permit', 15000, 'usd', 'pi_unrelated_permit', true);
  if (v_result ->> 'processed')::boolean is not true
     or v_result ->> 'outcome' is distinct from 'permit_payment_recorded'
     or v_result ->> 'permit_id' is distinct from 'fd000000-0000-0000-0000-0000000000b1'
     or not exists (
       select 1 from public.permit_payments
        where id = (v_result ->> 'payment_id')::uuid
          and permit_id = 'fd000000-0000-0000-0000-0000000000b1'
          and stripe_invoice_id = 'in_unrelated_permit'
          and stripe_payment_intent_id = 'pi_unrelated_permit'
          and amount_cents = 15000 and currency = 'USD' and status = 'succeeded'
     ) then
    raise exception 'PERMIT REPLAY FAIL: resolved invoice did not record 15000 cents: %', v_result;
  end if;

  v_result := public.process_stripe_subscription_event(
    'evt_unrelated_permit_customer.subscription.updated', 'customer.subscription.updated',
    null, 'sub_unrelated_permit', 'active', '2026-09-01T00:00Z', '2026-10-01T00:00Z');
  if (v_result ->> 'processed')::boolean is not true
     or v_result ->> 'outcome' is distinct from 'permit_active'
     or not exists (
       select 1 from public.permits
        where id = 'fd000000-0000-0000-0000-0000000000b1'
          and status = 'active' and current_period_start = '2026-09-01T00:00Z'
          and current_period_end = '2026-10-01T00:00Z'
     ) then
    raise exception 'PERMIT REPLAY FAIL: resolved subscription did not activate: %', v_result;
  end if;
  if (select count(*) from public.permit_payments) <> v_payments + 1
     or (select count(*) from public.audit_log) <> v_audits + 1
     or (select count(*) from public.processed_stripe_events) <> v_events + 2 then
    raise exception 'PERMIT REPLAY FAIL: expected one payment, one audit and two event claims';
  end if;
  select state into strict v_after from permit_event_state;

  v_result := public.record_permit_payment(
    'evt_unrelated_permit_invoice.paid', null, 'sub_unrelated_permit',
    'in_unrelated_permit', 15000, 'usd', 'pi_unrelated_permit', true);
  if v_result is distinct from '{"processed":false,"outcome":"duplicate_event"}'::jsonb then
    raise exception 'PERMIT REPLAY FAIL: invoice redelivery returned %', v_result;
  end if;
  v_result := public.process_stripe_subscription_event(
    'evt_unrelated_permit_customer.subscription.updated', 'customer.subscription.updated',
    null, 'sub_unrelated_permit', 'past_due', '2026-09-01T00:00Z', '2026-10-01T00:00Z');
  if v_result is distinct from '{"processed":false,"outcome":"duplicate_event"}'::jsonb
     or (select state from permit_event_state) is distinct from v_after then
    raise exception 'PERMIT REPLAY FAIL: redelivery changed database state: %', v_result;
  end if;
  raise notice 'CHECK8 PASS: both ignored ids replay successfully once; redelivery is a no-op';
end $$;

select
  p.id,
  p.stripe_payment_intent_id,
  p.status as payment_status,
  r.status as reservation_status
  from public.payments p
  join public.reservations r on r.id = p.reservation_id
 where p.id in ('fd000000-0000-0000-0000-0000000000e1',
                'fd000000-0000-0000-0000-0000000000e2')
 order by p.stripe_checkout_session_id;

rollback;
