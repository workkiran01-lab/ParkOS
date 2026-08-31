-- DEV-ONLY verification for the permit webhook ordering guard and the
-- detection-only reconciliation report.
--
-- Every transition is driven through the real RPC as the real service role, and
-- every assertion reads the permit row back rather than trusting the RPC's own
-- return value. Fixtures are created inside the transaction and rolled back, so
-- no row survives and the seeded permits are never touched.
--
-- Precedence under test (index position IS the rank):
--   0 pending  <  1 suspended  <  2 active  <  3 cancelled
--
-- The guard must block a BACKWARDS move whose payload is not evidence of a real
-- demotion, and must block nothing else. Both halves are asserted: T1/T6 prove
-- it blocks, T2/T3/T7 prove it does not block real state changes.
--
-- Run after 20260901000000_permit_event_ordering_guard.sql is applied:
--   npx supabase db query --linked --file supabase/dev-only/20260901000000_verify_permit_event_ordering_guard.sql

begin;

-- ---------------------------------------------------------------------------
-- Fixtures in the seeded Harbor Park organization.
-- ---------------------------------------------------------------------------

insert into public.facilities (id, org_id, name, timezone)
values ('ce000000-0000-0000-0000-0000000000f1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'Ordering Guard Test Lot', 'America/Los_Angeles');

insert into public.zones (id, org_id, facility_id, name)
values ('ce000000-0000-0000-0000-0000000000f2',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'ce000000-0000-0000-0000-0000000000f1', 'Guard Zone');

insert into public.spaces (id, org_id, zone_id, space_number, space_type)
values
  ('ce000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f2', 'GRD-1', 'standard'),
  ('ce000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f2', 'GRD-2', 'standard'),
  ('ce000000-0000-0000-0000-0000000000a3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f2', 'GRD-3', 'standard'),
  ('ce000000-0000-0000-0000-0000000000a4', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f2', 'GRD-4', 'standard'),
  ('ce000000-0000-0000-0000-0000000000a5', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f2', 'GRD-5', 'standard'),
  ('ce000000-0000-0000-0000-0000000000a6', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f2', 'GRD-6', 'standard'),
  ('ce000000-0000-0000-0000-0000000000a7', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f2', 'GRD-7', 'standard');

insert into public.customers (id, org_id, full_name)
values ('ce000000-0000-0000-0000-0000000000f4',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Guard Test Driver');

-- P1..P7, one per transition so the tests cannot contaminate each other.
-- The NEW period (Sep 15 -> Oct 15) is what a live permit already holds; the
-- stale events below all carry the OLD period (Aug 1 -> Sep 1).
insert into public.permits
  (id, org_id, facility_id, space_id, customer_id, during,
   monthly_rate_cents, currency, status, stripe_subscription_id,
   current_period_start, current_period_end)
values
  ('ce000000-0000-0000-0000-0000000000b1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f1', 'ce000000-0000-0000-0000-0000000000a1',
   'ce000000-0000-0000-0000-0000000000f4', tstzrange(now(), null, '[)'),
   15000, 'USD', 'active', 'sub_guard_1',
   '2026-09-15 00:00:00+00', '2026-10-15 00:00:00+00'),
  ('ce000000-0000-0000-0000-0000000000b2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f1', 'ce000000-0000-0000-0000-0000000000a2',
   'ce000000-0000-0000-0000-0000000000f4', tstzrange(now(), null, '[)'),
   15000, 'USD', 'active', 'sub_guard_2',
   '2026-09-15 00:00:00+00', '2026-10-15 00:00:00+00'),
  ('ce000000-0000-0000-0000-0000000000b3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f1', 'ce000000-0000-0000-0000-0000000000a3',
   'ce000000-0000-0000-0000-0000000000f4', tstzrange(now(), null, '[)'),
   15000, 'USD', 'active', 'sub_guard_3',
   '2026-09-15 00:00:00+00', '2026-10-15 00:00:00+00'),
  ('ce000000-0000-0000-0000-0000000000b4', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f1', 'ce000000-0000-0000-0000-0000000000a4',
   'ce000000-0000-0000-0000-0000000000f4', tstzrange(now(), null, '[)'),
   15000, 'USD', 'pending', null, null, null),
  ('ce000000-0000-0000-0000-0000000000b5', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f1', 'ce000000-0000-0000-0000-0000000000a5',
   'ce000000-0000-0000-0000-0000000000f4', tstzrange(now(), null, '[)'),
   15000, 'USD', 'pending', null, null, null),
  ('ce000000-0000-0000-0000-0000000000b6', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f1', 'ce000000-0000-0000-0000-0000000000a6',
   'ce000000-0000-0000-0000-0000000000f4', tstzrange(now(), null, '[)'),
   15000, 'USD', 'cancelled', 'sub_guard_6',
   '2026-09-15 00:00:00+00', '2026-10-15 00:00:00+00'),
  ('ce000000-0000-0000-0000-0000000000b7', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ce000000-0000-0000-0000-0000000000f1', 'ce000000-0000-0000-0000-0000000000a7',
   'ce000000-0000-0000-0000-0000000000f4', tstzrange(now(), null, '[)'),
   15000, 'USD', 'active', 'sub_guard_7',
   '2026-09-15 00:00:00+00', '2026-10-15 00:00:00+00');

-- ---------------------------------------------------------------------------
-- All transitions, driven as the signed webhook's service role.
-- ---------------------------------------------------------------------------

do $$
declare
  v_result jsonb;
  v_status text;
  v_pend timestamptz;
  v_sub text;
  v_cancelled timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute 'set local role service_role';

  -- T1. THE REPORTED BUG. A stale customer.subscription.created carrying
  -- 'incomplete' lands after the update that activated the permit. It must not
  -- demote, and its older period must not overwrite the newer one.
  v_result := public.process_stripe_subscription_event(
    p_event_id => 'evt_guard_t1_stale_created',
    p_event_type => 'customer.subscription.created',
    p_permit_id => 'ce000000-0000-0000-0000-0000000000b1',
    p_stripe_subscription_id => 'sub_guard_1',
    p_stripe_status => 'incomplete',
    p_period_start => '2026-08-01 00:00:00+00',
    p_period_end => '2026-09-01 00:00:00+00');
  select status, current_period_end into v_status, v_pend
    from public.permits where id = 'ce000000-0000-0000-0000-0000000000b1';
  if v_status <> 'active' then
    raise exception 'T1 FAIL: stale created demoted active permit to %', v_status;
  end if;
  if v_pend <> '2026-10-15 00:00:00+00'::timestamptz then
    raise exception 'T1 FAIL: stale period overwrote newer period, now %', v_pend;
  end if;
  if v_result ->> 'permit_status' <> 'active' then
    raise exception 'T1 FAIL: RPC reported % rather than active', v_result;
  end if;
  raise notice 'T1 PASS: stale created(incomplete) did not demote active; period held at %', v_pend;

  -- T2. A GENUINE payment failure must still demote. Different branch, unguarded.
  v_result := public.process_stripe_subscription_event(
    p_event_id => 'evt_guard_t2_payment_failed',
    p_event_type => 'invoice.payment_failed',
    p_permit_id => 'ce000000-0000-0000-0000-0000000000b2',
    p_stripe_subscription_id => 'sub_guard_2');
  select status into v_status
    from public.permits where id = 'ce000000-0000-0000-0000-0000000000b2';
  if v_status <> 'suspended' then
    raise exception 'T2 FAIL: real payment failure left permit %', v_status;
  end if;
  raise notice 'T2 PASS: invoice.payment_failed demoted active -> suspended';

  -- T3. A GENUINE cancellation must still apply. Terminal, never a demotion.
  v_result := public.process_stripe_subscription_event(
    p_event_id => 'evt_guard_t3_deleted',
    p_event_type => 'customer.subscription.deleted',
    p_permit_id => 'ce000000-0000-0000-0000-0000000000b3',
    p_stripe_subscription_id => 'sub_guard_3',
    p_stripe_status => 'canceled',
    p_reason => 'T3 cancellation');
  select status, cancelled_at into v_status, v_cancelled
    from public.permits where id = 'ce000000-0000-0000-0000-0000000000b3';
  if v_status <> 'cancelled' or v_cancelled is null then
    raise exception 'T3 FAIL: cancellation left status % cancelled_at %',
      v_status, v_cancelled;
  end if;
  raise notice 'T3 PASS: customer.subscription.deleted cancelled the permit';

  -- T4a. pending -> suspended. The normal first step: created always carries
  -- 'incomplete' because the subscription is made with default_incomplete.
  -- Rank 0 -> 1 is forward, so the guard must allow it.
  v_result := public.process_stripe_subscription_event(
    p_event_id => 'evt_guard_t4a_created',
    p_event_type => 'customer.subscription.created',
    p_permit_id => 'ce000000-0000-0000-0000-0000000000b4',
    p_stripe_subscription_id => 'sub_guard_4',
    p_stripe_status => 'incomplete',
    p_period_start => '2026-09-15 00:00:00+00',
    p_period_end => '2026-10-15 00:00:00+00');
  select status, stripe_subscription_id into v_status, v_sub
    from public.permits where id = 'ce000000-0000-0000-0000-0000000000b4';
  if v_status <> 'suspended' or v_sub <> 'sub_guard_4' then
    raise exception 'T4a FAIL: pending+created gave status % sub %', v_status, v_sub;
  end if;

  -- T4b. suspended -> active once Stripe confirms billing. Rank 1 -> 2.
  v_result := public.process_stripe_subscription_event(
    p_event_id => 'evt_guard_t4b_updated_active',
    p_event_type => 'customer.subscription.updated',
    p_permit_id => 'ce000000-0000-0000-0000-0000000000b4',
    p_stripe_subscription_id => 'sub_guard_4',
    p_stripe_status => 'active');
  select status into v_status
    from public.permits where id = 'ce000000-0000-0000-0000-0000000000b4';
  if v_status <> 'active' then
    raise exception 'T4b FAIL: suspended+active update gave %', v_status;
  end if;

  -- T4c. pending -> active directly, for a permit whose first delivered event
  -- already carries 'active'. Rank 0 -> 2.
  v_result := public.process_stripe_subscription_event(
    p_event_id => 'evt_guard_t4c_pending_to_active',
    p_event_type => 'customer.subscription.updated',
    p_permit_id => 'ce000000-0000-0000-0000-0000000000b5',
    p_stripe_subscription_id => 'sub_guard_5',
    p_stripe_status => 'active',
    p_period_start => '2026-09-15 00:00:00+00',
    p_period_end => '2026-10-15 00:00:00+00');
  select status, stripe_subscription_id into v_status, v_sub
    from public.permits where id = 'ce000000-0000-0000-0000-0000000000b5';
  if v_status <> 'active' or v_sub <> 'sub_guard_5' then
    raise exception 'T4c FAIL: pending -> active gave status % sub %', v_status, v_sub;
  end if;
  raise notice 'T4 PASS: pending -> suspended -> active, and pending -> active, all promote';

  -- T5. A replayed event must be a clean no-op. Re-send T2's event id, but with
  -- a payload that WOULD change state if it were applied.
  v_result := public.process_stripe_subscription_event(
    p_event_id => 'evt_guard_t2_payment_failed',
    p_event_type => 'customer.subscription.updated',
    p_permit_id => 'ce000000-0000-0000-0000-0000000000b2',
    p_stripe_subscription_id => 'sub_guard_2',
    p_stripe_status => 'active');
  select status into v_status
    from public.permits where id = 'ce000000-0000-0000-0000-0000000000b2';
  if coalesce((v_result ->> 'processed')::boolean, true) is not false
     or v_result ->> 'outcome' <> 'duplicate_event' then
    raise exception 'T5 FAIL: replay returned %', v_result;
  end if;
  if v_status <> 'suspended' then
    raise exception 'T5 FAIL: replay changed status to %', v_status;
  end if;
  raise notice 'T5 PASS: replayed event id was a no-op, status still suspended';

  -- T6. THE RESURRECTION HOLE. A reordered 'updated' carrying 'active' landing
  -- after the cancellation. Rank 3 is terminal, so it must be kept. Before this
  -- migration the status CASE matched 'active' first and revived the permit.
  v_result := public.process_stripe_subscription_event(
    p_event_id => 'evt_guard_t6_late_active',
    p_event_type => 'customer.subscription.updated',
    p_permit_id => 'ce000000-0000-0000-0000-0000000000b6',
    p_stripe_subscription_id => 'sub_guard_6',
    p_stripe_status => 'active');
  select status into v_status
    from public.permits where id = 'ce000000-0000-0000-0000-0000000000b6';
  if v_status <> 'cancelled' then
    raise exception 'T6 FAIL: cancelled permit was resurrected to %', v_status;
  end if;
  raise notice 'T6 PASS: cancelled stayed terminal against a late active snapshot';

  -- T7. A REAL post-activation failure delivered as customer.subscription.updated
  -- must still demote. This is the case the guard must NOT block.
  v_result := public.process_stripe_subscription_event(
    p_event_id => 'evt_guard_t7_past_due',
    p_event_type => 'customer.subscription.updated',
    p_permit_id => 'ce000000-0000-0000-0000-0000000000b7',
    p_stripe_subscription_id => 'sub_guard_7',
    p_stripe_status => 'past_due');
  select status into v_status
    from public.permits where id = 'ce000000-0000-0000-0000-0000000000b7';
  if v_status <> 'suspended' then
    raise exception 'T7 FAIL: real past_due demotion was blocked, status %', v_status;
  end if;
  raise notice 'T7 PASS: past_due demoted active -> suspended (guard did not block)';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- The detection report must see the fixtures it is supposed to see.
-- ---------------------------------------------------------------------------

do $$
declare
  v_count integer;
begin
  -- P4 and P5 were promoted out of pending, P1 is active WITH no hold (fixtures
  -- create no holds), so the interesting assertion is the suspended pair.
  select pg_catalog.count(*) into v_count
    from public.report_permit_reconciliation()
   where permit_id in ('ce000000-0000-0000-0000-0000000000b2',
                       'ce000000-0000-0000-0000-0000000000b7')
     and classification = 'suspended_unverified';
  if v_count <> 2 then
    raise exception 'T8 FAIL: report found % of 2 suspended fixtures', v_count;
  end if;

  -- Detection only: the report must not have changed anything it looked at.
  select pg_catalog.count(*) into v_count
    from public.permits
   where id = 'ce000000-0000-0000-0000-0000000000b2' and status = 'suspended';
  if v_count <> 1 then
    raise exception 'T8 FAIL: report mutated a permit';
  end if;
  raise notice 'T8 PASS: report detected both suspended fixtures and mutated nothing';
end $$;

-- ---------------------------------------------------------------------------
-- Evidence, emitted as rows because the Management API suppresses RAISE NOTICE.
--
-- The DO blocks above already abort the whole script on any failure, so reaching
-- this point is itself the pass condition. These rows exist so the outcome is
-- READ BACK from the database rather than asserted: every 'observed' value below
-- is selected from the permit row the RPC actually wrote, and every 'result' is
-- recomputed here rather than copied from the assertion.
--
-- It runs BEFORE the rollback so it can see those rows. cron.job and
-- cron.job_run_details are ordinary tables and read the same either side of it.
-- ---------------------------------------------------------------------------

select 1 as seq,
       'T1 stale created(incomplete) after active -> must NOT demote' as test,
       p.status || ' | period_end=' || p.current_period_end::text as observed,
       case when p.status = 'active'
             and p.current_period_end = '2026-10-15 00:00:00+00'::timestamptz
            then 'PASS' else 'FAIL' end as result
  from public.permits p where p.id = 'ce000000-0000-0000-0000-0000000000b1'
union all
select 2, 'T2 invoice.payment_failed on active -> must demote',
       p.status,
       case when p.status = 'suspended' then 'PASS' else 'FAIL' end
  from public.permits p where p.id = 'ce000000-0000-0000-0000-0000000000b2'
union all
select 3, 'T3 customer.subscription.deleted -> must cancel',
       p.status || ' | cancelled_at=' || coalesce(p.cancelled_at::text, 'null'),
       case when p.status = 'cancelled' and p.cancelled_at is not null
            then 'PASS' else 'FAIL' end
  from public.permits p where p.id = 'ce000000-0000-0000-0000-0000000000b3'
union all
select 4, 'T4ab pending -> suspended -> active (promotions)',
       p.status || ' | sub=' || coalesce(p.stripe_subscription_id, 'null'),
       case when p.status = 'active' and p.stripe_subscription_id = 'sub_guard_4'
            then 'PASS' else 'FAIL' end
  from public.permits p where p.id = 'ce000000-0000-0000-0000-0000000000b4'
union all
select 5, 'T4c pending -> active directly (promotion)',
       p.status || ' | sub=' || coalesce(p.stripe_subscription_id, 'null'),
       case when p.status = 'active' and p.stripe_subscription_id = 'sub_guard_5'
            then 'PASS' else 'FAIL' end
  from public.permits p where p.id = 'ce000000-0000-0000-0000-0000000000b5'
union all
select 6, 'T5 replayed event id with a state-changing payload -> no-op',
       p.status,
       case when p.status = 'suspended' then 'PASS' else 'FAIL' end
  from public.permits p where p.id = 'ce000000-0000-0000-0000-0000000000b2'
union all
select 7, 'T6 late updated(active) after cancel -> must stay terminal',
       p.status,
       case when p.status = 'cancelled' then 'PASS' else 'FAIL' end
  from public.permits p where p.id = 'ce000000-0000-0000-0000-0000000000b6'
union all
select 8, 'T7 updated(past_due) on active -> must demote (guard must not block)',
       p.status,
       case when p.status = 'suspended' then 'PASS' else 'FAIL' end
  from public.permits p where p.id = 'ce000000-0000-0000-0000-0000000000b7'
union all
select 9, 'T8 report detects both suspended fixtures, mutates nothing',
       'found=' || pg_catalog.count(*)::text,
       case when pg_catalog.count(*) = 2 then 'PASS' else 'FAIL' end
  from public.report_permit_reconciliation() r
 where r.permit_id in ('ce000000-0000-0000-0000-0000000000b2',
                       'ce000000-0000-0000-0000-0000000000b7')
   and r.classification = 'suspended_unverified'
union all
-- pg_cron evidence. cron.job proves the job is registered and active;
-- cron.job_run_details proves it actually executes. A migration NOTICE proves
-- neither, which is exactly why 20260819130000's pattern was not reused.
select 10, 'pg_cron job: ' || j.jobname,
       j.schedule || ' | active=' || j.active::text
         || ' | runs=' || pg_catalog.count(d.runid)::text
         || ' | failed=' || pg_catalog.count(*) filter (where d.status <> 'succeeded')::text
         || ' | last=' || coalesce(pg_catalog.max(d.start_time)::text, 'never'),
       case when j.active
             and pg_catalog.count(*) filter (where d.status <> 'succeeded') = 0
            then 'PASS' else 'FAIL' end
  from cron.job j
  left join cron.job_run_details d on d.jobid = j.jobid
 where j.jobname in ('parkos-permit-reconciliation', 'parkos-no-show-sweep')
 group by j.jobname, j.schedule, j.active
 order by seq, test;

rollback;
