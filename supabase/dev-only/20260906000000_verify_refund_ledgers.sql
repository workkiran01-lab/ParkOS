-- DEV-ONLY verification of the booth and permit refund ledgers.
--
--   npx supabase db query --linked --file supabase/dev-only/20260906000000_verify_refund_ledgers.sql
--
-- Assertion-only: every check RAISES on failure. One transaction, ends in
-- ROLLBACK, so no fixture survives.
--
-- THE TRAP THIS EXISTS TO CATCH. Six functions read a payment ledger, and every
-- one of them summed BOOTH money with no status predicate at all. Adding a
-- status column without touching them would have left a refunded booth payment
-- counted as revenue -- silently, because the row is still present and still
-- positive. CHECK 4 drives all six through four stages and pins every number.
--
-- FIXTURE (facility F, all money created today so every report bins it here):
--   R1  total 10000c  space A1 (standard)
--   R2  total  5000c  space A2 (ev)
--   M1  permit        space A3 (standard)
--   P1  stripe   6000c on R1   status succeeded, intent pi_devtest_refund_res
--   B1  booth cash 3000c on R1 (collected by the ADMIN)
--   B2  booth card 2000c on R2 (collected by an ATTENDANT -- collection keeps
--                               the attendant role, only reversal does not)
--   PP1 permit  15000c on M1   intent pi_devtest_refund_permit
--
-- HAND-COMPUTED EXPECTATIONS, four stages. Nothing below is read back out of
-- the functions; each number is derived from the fixture above.
--
--   stage 0  baseline, nothing refunded
--     dashboard    stripe 6000 + cash 3000 + card 2000 + permit 15000 = 26000
--     by_period    count 4, revenue 26000, refunded_count 0
--     space_type   standard = 6000 + 3000 + 15000 = 24000 over 3 payments
--                  ev       = 2000 over 1
--     split        hourly = 6000 + 3000 + 2000 = 11000; permit = 15000
--     manifest R1  paid 6000 + 3000 = 9000, balance 10000 - 9000 = 1000
--     balance  R1  1000   (must equal 10000 - manifest paid: the twins agree)
--
--   stage 1  after the BOOTH refund of B1 (3000c cash)
--     dashboard    cash 0            -> 6000 + 0 + 2000 + 15000 = 23000
--     by_period    count 3, revenue 23000, refunded_count 1
--     space_type   standard = 6000 + 15000 = 21000 over 2; ev unchanged
--     split        hourly = 6000 + 0 + 2000 = 8000; permit 15000
--     manifest R1  paid 6000, balance 4000
--     balance  R1  4000   <- the point: the money is collectable AGAIN
--
--   stage 2  after the PERMIT refund of PP1 (15000c)
--     dashboard    permit 0          -> 6000 + 0 + 2000 + 0 = 8000
--     by_period    count 2, revenue 8000, refunded_count 2
--     space_type   standard = 6000 over 1; ev unchanged
--     split        hourly 8000; permit 0
--     manifest/balance R1 unchanged at 6000 / 4000 -- permit money never
--                  touched a reservation balance
--
--   stage 3  after the RESERVATION refund of P1 (6000c), driven through
--            charge.refunded exactly as it works today
--     dashboard    stripe 0          -> 0 + 0 + 2000 + 0 = 2000
--     by_period    count 1, revenue 2000, refunded_count 3  <- all THREE
--                  ledgers now reach this tile
--     space_type   standard row disappears entirely (0); ev unchanged
--     split        hourly = 0 + 0 + 2000 = 2000; permit 0
--     manifest R1  paid 0, balance 10000
--     balance  R1  10000
--
--   R2's balance is 5000 - 2000 = 3000 at EVERY stage: nothing refunded touches
--   it, which is the control against a predicate that over-filters.
--
-- Depends on the dev seed (DEV_ONLY_seed_dev_orgs.sql) for Org A and its roles:
--   admin     00000000-0000-0000-0000-0000000000a1
--   manager   00000000-0000-0000-0000-0000000000a2
--   attendant 00000000-0000-0000-0000-0000000000a3

begin;

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
insert into public.facilities (id, org_id, name, timezone)
values ('fc000000-0000-0000-0000-0000000000f1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'Refund Ledger Lot', 'America/Los_Angeles');

insert into public.zones (id, org_id, facility_id, name)
values ('fc000000-0000-0000-0000-0000000000f2',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'fc000000-0000-0000-0000-0000000000f1', 'Refund Ledger Zone');

insert into public.spaces (id, org_id, zone_id, space_number, space_type)
values
  ('fc000000-0000-0000-0000-0000000000a1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fc000000-0000-0000-0000-0000000000f2', 'RL-1', 'standard'),
  ('fc000000-0000-0000-0000-0000000000a2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fc000000-0000-0000-0000-0000000000f2', 'RL-2', 'ev'),
  ('fc000000-0000-0000-0000-0000000000a3',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fc000000-0000-0000-0000-0000000000f2', 'RL-3', 'standard');

insert into public.customers (id, org_id, full_name)
values ('fc000000-0000-0000-0000-0000000000c1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Refund Ledger Driver');

-- Both reservations sit inside today's facility-local day so the manifest and
-- every report bin them on the same date the money does.
do $$
declare v_tz text; v_day date;
begin
  select public.safe_timezone(f.timezone),
         (now() at time zone public.safe_timezone(f.timezone))::date
    into v_tz, v_day
    from public.facilities f
   where f.id = 'fc000000-0000-0000-0000-0000000000f1';

  insert into public.reservations
    (id, org_id, facility_id, space_id, customer_id, during, status,
     booking_code, price_breakdown, total_cents, currency)
  values
    ('fc000000-0000-0000-0000-0000000000d1',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'fc000000-0000-0000-0000-0000000000f1',
     'fc000000-0000-0000-0000-0000000000a1',
     'fc000000-0000-0000-0000-0000000000c1',
     tstzrange((v_day + time '08:00') at time zone v_tz,
               (v_day + time '18:00') at time zone v_tz, '[)'),
     'confirmed', 'PKS-RFNDAA',
     '{"currency":"USD","line_items":[],"total_cents":10000}', 10000, 'USD'),
    ('fc000000-0000-0000-0000-0000000000d2',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'fc000000-0000-0000-0000-0000000000f1',
     'fc000000-0000-0000-0000-0000000000a2',
     'fc000000-0000-0000-0000-0000000000c1',
     tstzrange((v_day + time '09:00') at time zone v_tz,
               (v_day + time '17:00') at time zone v_tz, '[)'),
     'confirmed', 'PKS-RFNDAB',
     '{"currency":"USD","line_items":[],"total_cents":5000}', 5000, 'USD');
end $$;

insert into public.payments
  (id, org_id, reservation_id, stripe_checkout_session_id,
   stripe_payment_intent_id, amount_cents, currency, status)
values ('fc000000-0000-0000-0000-0000000000e1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'fc000000-0000-0000-0000-0000000000d1',
        'cs_devtest_refund_0001', 'pi_devtest_refund_res', 6000, 'USD',
        'succeeded');

insert into public.permits
  (id, org_id, facility_id, space_id, customer_id, during,
   monthly_rate_cents, currency, status, stripe_subscription_id,
   current_period_start, current_period_end)
values ('fc000000-0000-0000-0000-0000000000b1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'fc000000-0000-0000-0000-0000000000f1',
        'fc000000-0000-0000-0000-0000000000a3',
        'fc000000-0000-0000-0000-0000000000c1',
        tstzrange(now() - interval '1 month', null, '[)'),
        15000, 'USD', 'active', 'sub_devtest_refund_0001',
        now() - interval '5 days', now() + interval '25 days');

insert into public.permit_payments
  (id, org_id, permit_id, stripe_invoice_id, stripe_payment_intent_id,
   amount_cents, currency)
values ('fc000000-0000-0000-0000-0000000000b2',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'fc000000-0000-0000-0000-0000000000b1',
        'in_devtest_refund_0001', 'pi_devtest_refund_permit', 15000, 'USD');

-- Snapshot of everything a permit refund must NOT disturb.
create temporary table permit_before on commit drop as
select p.status::text as permit_status,
       p.stripe_subscription_id,
       p.current_period_start,
       p.current_period_end,
       p.archived_at,
       (select pp.stripe_invoice_id from public.permit_payments pp
         where pp.id = 'fc000000-0000-0000-0000-0000000000b2') as invoice_id,
       (select pg_catalog.count(*) from public.permit_payments pp
         where pp.id = 'fc000000-0000-0000-0000-0000000000b2') as invoice_rows
  from public.permits p
 where p.id = 'fc000000-0000-0000-0000-0000000000b1';

-- Booth money is collected through the real path, by real roles.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

create temporary table booth_ids (label text, id uuid) on commit drop;

insert into booth_ids
select 'B1', rb.payment_id
  from public.record_booth_payment(
    'fc000000-0000-0000-0000-0000000000d1', 3000, 'cash', 'stage fixture') rb;

-- Switch to an ATTENDANT: collection must still work for them.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);

insert into booth_ids
select 'B2', rb.payment_id
  from public.record_booth_payment(
    'fc000000-0000-0000-0000-0000000000d2', 2000, 'card', 'stage fixture') rb;


-- ---------------------------------------------------------------------------
-- The reporting matrix. One row per stage, every column hand-computed above.
-- ---------------------------------------------------------------------------
create temporary table expected (
  stage integer,
  dash_total bigint, dash_stripe bigint, dash_cash bigint,
  dash_card bigint, dash_permit bigint,
  per_count bigint, per_revenue bigint, per_refunded bigint,
  per_stripe bigint, per_cash bigint, per_card bigint, per_permit bigint,
  spc_standard_rev bigint, spc_standard_count bigint, spc_ev_rev bigint,
  split_hourly bigint, split_permit bigint,
  man_r1_paid integer, man_r1_balance integer,
  bal_r1 integer, bal_r2 integer
) on commit drop;

insert into expected values
  (0, 26000, 6000, 3000, 2000, 15000,
      4, 26000, 0, 6000, 3000, 2000, 15000,
      24000, 3, 2000,
      11000, 15000,
      9000, 1000,
      1000, 3000),
  (1, 23000, 6000, 0, 2000, 15000,
      3, 23000, 1, 6000, 0, 2000, 15000,
      21000, 2, 2000,
      8000, 15000,
      6000, 4000,
      4000, 3000),
  (2, 8000, 6000, 0, 2000, 0,
      2, 8000, 2, 6000, 0, 2000, 0,
      6000, 1, 2000,
      8000, 0,
      6000, 4000,
      4000, 3000),
  (3, 2000, 0, 0, 2000, 0,
      1, 2000, 3, 0, 0, 2000, 0,
      0, 0, 2000,
      2000, 0,
      0, 10000,
      10000, 3000);

create temporary table actual (like expected) on commit drop;

-- Capture all six functions in one shot, for the stage given.
create or replace function pg_temp.capture(p_stage integer)
returns void
language plpgsql
as $$
declare
  v_day date;
  v_d record; v_p record; v_m record;
  v_std_rev bigint; v_std_cnt bigint; v_ev_rev bigint;
  v_hourly bigint; v_permit bigint;
begin
  select (now() at time zone public.safe_timezone(f.timezone))::date
    into v_day
    from public.facilities f
   where f.id = 'fc000000-0000-0000-0000-0000000000f1';

  select * into v_d
    from public.facility_dashboard_summary('fc000000-0000-0000-0000-0000000000f1');

  select * into v_p
    from public.report_revenue_by_period(
      v_day, v_day, 'fc000000-0000-0000-0000-0000000000f1', 'day');

  select coalesce(pg_catalog.sum(t.revenue_cents) filter (
           where t.space_type = 'standard'), 0::bigint),
         coalesce(pg_catalog.sum(t.payments_count) filter (
           where t.space_type = 'standard'), 0::bigint),
         coalesce(pg_catalog.sum(t.revenue_cents) filter (
           where t.space_type = 'ev'), 0::bigint)
    into v_std_rev, v_std_cnt, v_ev_rev
    from public.report_revenue_by_space_type(
      v_day, v_day, 'fc000000-0000-0000-0000-0000000000f1') t;

  select coalesce(pg_catalog.sum(s.revenue_cents) filter (
           where s.category = 'hourly'), 0::bigint),
         coalesce(pg_catalog.sum(s.revenue_cents) filter (
           where s.category = 'permit'), 0::bigint)
    into v_hourly, v_permit
    from public.report_revenue_split(
      v_day, v_day, 'fc000000-0000-0000-0000-0000000000f1') s;

  select * into v_m
    from public.facility_daily_manifest(
      'fc000000-0000-0000-0000-0000000000f1', v_day) m
   where m.reservation_id = 'fc000000-0000-0000-0000-0000000000d1';

  insert into actual values (
    p_stage,
    v_d.today_revenue_cents, v_d.today_stripe_revenue_cents,
    v_d.today_booth_cash_revenue_cents, v_d.today_booth_card_revenue_cents,
    v_d.today_permit_revenue_cents,
    coalesce(v_p.payments_count, 0), coalesce(v_p.revenue_cents, 0),
    coalesce(v_p.refunded_count, 0), coalesce(v_p.stripe_revenue_cents, 0),
    coalesce(v_p.booth_cash_revenue_cents, 0),
    coalesce(v_p.booth_card_revenue_cents, 0),
    coalesce(v_p.permit_revenue_cents, 0),
    v_std_rev, v_std_cnt, v_ev_rev,
    v_hourly, v_permit,
    v_m.paid_cents, v_m.balance_cents,
    public.reservation_balance_cents('fc000000-0000-0000-0000-0000000000d1'),
    public.reservation_balance_cents('fc000000-0000-0000-0000-0000000000d2'));
end $$;

-- Back to the admin: refunds are admin/manager, and capture() calls
-- reservation_balance_cents, which requires a member.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select pg_temp.capture(0);


-- ---------------------------------------------------------------------------
-- CHECK 1 -- the booth refund itself. Status flips, an attestation lands in
-- audit_log, the balance comes back, and the money is collectable AGAIN --
-- which is what fails if reservation_balance_cents keeps counting the
-- reversed row.
-- ---------------------------------------------------------------------------
do $$
declare
  v_b1 uuid; v_balance integer; v_status text; v_audit bigint;
begin
  select id into v_b1 from booth_ids where label = 'B1';

  -- Balance before: 10000 - 6000 stripe - 3000 cash = 1000.
  if public.reservation_balance_cents('fc000000-0000-0000-0000-0000000000d1') <> 1000 then
    raise exception 'CHECK1 FAIL: pre-refund balance was %, expected 1000',
      public.reservation_balance_cents('fc000000-0000-0000-0000-0000000000d1');
  end if;

  select rb.balance_cents into v_balance
    from public.refund_booth_payment(v_b1, 'customer overcharged') rb;

  select bp.status into v_status
    from public.booth_payments bp where bp.id = v_b1;

  -- 1000 + the reversed 3000 = 4000.
  if v_balance <> 4000 or v_status <> 'refunded' then
    raise exception 'CHECK1 FAIL: returned balance % status %, expected 4000 refunded',
      v_balance, v_status;
  end if;

  select pg_catalog.count(*) into v_audit
    from public.audit_log a
   where a.action = 'refund_booth_payment'
     and a.target_id = v_b1
     and a.actor_id = '00000000-0000-0000-0000-0000000000a1'
     and a.reason like 'cash 3000 cents%customer overcharged%';
  if v_audit <> 1 then
    raise exception 'CHECK1 FAIL: expected 1 attestation in audit_log, found %', v_audit;
  end if;

  -- Re-collectability is proved at the END of CHECK 5, after the last capture:
  -- taking money again here would add a row to every stage that follows and
  -- move numbers this file hand-computed.

  raise notice 'CHECK1 PASS: booth refund flips status, attests, balance 1000 -> 4000';
end $$;

select pg_temp.capture(1);




-- ---------------------------------------------------------------------------
-- CHECK 2 -- the permit refund. Records the reversal and touches NOTHING else:
-- the subscription is not cancelled, the invoice is not voided, the permit
-- keeps its billing period. Also pins the two non-crashing misses.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_result jsonb; v_status text; v_after record; v_before record;
begin
  -- A charge belonging to neither ledger: answer, never raise.
  v_result := public.record_permit_refund(
    'evt_devtest_refund_foreign', 'pi_devtest_refund_unknown', 2000, 2000);
  if v_result ->> 'outcome' <> 'permit_payment_not_found'
     or (v_result ->> 'processed')::boolean is not false then
    raise exception 'CHECK2 FAIL: an unknown intent returned %', v_result;
  end if;

  -- A Dashboard PARTIAL refund: reported, deliberately not written. v1 records
  -- full reversals only, and writing it as one would erase money still held.
  v_result := public.record_permit_refund(
    'evt_devtest_refund_partial', 'pi_devtest_refund_permit', 15000, 5000);
  if v_result ->> 'outcome' <> 'partial_refund_not_supported' then
    raise exception 'CHECK2 FAIL: a partial refund returned %', v_result;
  end if;
  select pp.status into v_status from public.permit_payments pp
   where pp.id = 'fc000000-0000-0000-0000-0000000000b2';
  if v_status <> 'succeeded' then
    raise exception 'CHECK2 FAIL: a partial refund still wrote status %', v_status;
  end if;

  -- The real thing: a full reversal.
  v_result := public.record_permit_refund(
    'evt_devtest_refund_permit', 'pi_devtest_refund_permit', 15000, 15000);
  if (v_result ->> 'processed')::boolean is not true
     or v_result ->> 'outcome' <> 'permit_payment_refunded' then
    raise exception 'CHECK2 FAIL: the full refund returned %', v_result;
  end if;
  select pp.status into v_status from public.permit_payments pp
   where pp.id = 'fc000000-0000-0000-0000-0000000000b2';
  if v_status <> 'refunded' then
    raise exception 'CHECK2 FAIL: status is % after a full refund', v_status;
  end if;

  -- THE PROOF: nothing about the subscription, the permit, or the invoice moved.
  select * into v_before from permit_before;
  select p.status::text as permit_status, p.stripe_subscription_id,
         p.current_period_start, p.current_period_end, p.archived_at,
         (select pp.stripe_invoice_id from public.permit_payments pp
           where pp.id = 'fc000000-0000-0000-0000-0000000000b2') as invoice_id,
         (select pg_catalog.count(*) from public.permit_payments pp
           where pp.id = 'fc000000-0000-0000-0000-0000000000b2') as invoice_rows
    into v_after
    from public.permits p
   where p.id = 'fc000000-0000-0000-0000-0000000000b1';

  if v_after.permit_status is distinct from v_before.permit_status then
    raise exception 'CHECK2 FAIL: permit status moved % -> %',
      v_before.permit_status, v_after.permit_status;
  end if;
  if v_after.stripe_subscription_id is distinct from v_before.stripe_subscription_id then
    raise exception 'CHECK2 FAIL: the subscription id changed -- refund cancelled it';
  end if;
  if v_after.current_period_start is distinct from v_before.current_period_start
     or v_after.current_period_end is distinct from v_before.current_period_end then
    raise exception 'CHECK2 FAIL: the billing period moved -- the subscription was disturbed';
  end if;
  if v_after.archived_at is distinct from v_before.archived_at then
    raise exception 'CHECK2 FAIL: the permit was archived by a refund';
  end if;
  if v_after.invoice_id is distinct from v_before.invoice_id
     or v_after.invoice_rows <> v_before.invoice_rows then
    raise exception 'CHECK2 FAIL: the invoice row was voided or removed';
  end if;
  if v_after.permit_status <> 'active' then
    raise exception 'CHECK2 FAIL: the permit is % , expected still active',
      v_after.permit_status;
  end if;

  raise notice 'CHECK2 PASS: permit refunded; subscription, period and invoice all intact';
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select pg_temp.capture(2);


-- ---------------------------------------------------------------------------
-- CHECK 3 -- a reservation refund still records exactly as it did before this
-- commit, driven through charge.refunded. This is the regression guard: the
-- path that already worked must not have been weakened to make the new ones
-- fit.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare v_result jsonb; v_status text;
begin
  v_result := public.process_stripe_event(
    'evt_devtest_refund_reservation', 'charge.refunded',
    null, null, null, 'pi_devtest_refund_res', 6000, 'usd', 6000);

  select p.status into v_status from public.payments p
   where p.id = 'fc000000-0000-0000-0000-0000000000e1';

  if (v_result ->> 'processed')::boolean is not true
     or v_result ->> 'outcome' <> 'payment_refunded'
     or v_status <> 'refunded' then
    raise exception 'CHECK3 FAIL: reservation refund returned % leaving status %',
      v_result, v_status;
  end if;

  raise notice 'CHECK3 PASS: reservation refund unchanged (6000/6000 -> refunded)';
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select pg_temp.capture(3);


-- ---------------------------------------------------------------------------
-- CHECK 4 -- THE TRAP. All six readers, four stages, every cell hand-computed.
-- A missing status predicate anywhere shows up here as a number that did not
-- move when money was reversed.
-- ---------------------------------------------------------------------------
do $$
declare r record; v integer := 0;
begin
  for r in
    select e.stage, x.col, x.exp, x.got
      from expected e
      join actual a using (stage)
      cross join lateral (values
        ('dashboard.today_revenue_cents',      e.dash_total,        a.dash_total),
        ('dashboard.stripe',                   e.dash_stripe,       a.dash_stripe),
        ('dashboard.booth_cash',               e.dash_cash,         a.dash_cash),
        ('dashboard.booth_card',               e.dash_card,         a.dash_card),
        ('dashboard.permit',                   e.dash_permit,       a.dash_permit),
        ('by_period.payments_count',           e.per_count,         a.per_count),
        ('by_period.revenue_cents',            e.per_revenue,       a.per_revenue),
        ('by_period.refunded_count',           e.per_refunded,      a.per_refunded),
        ('by_period.stripe_revenue',           e.per_stripe,        a.per_stripe),
        ('by_period.booth_cash_revenue',       e.per_cash,          a.per_cash),
        ('by_period.booth_card_revenue',       e.per_card,          a.per_card),
        ('by_period.permit_revenue',           e.per_permit,        a.per_permit),
        ('by_space_type.standard_revenue',     e.spc_standard_rev,  a.spc_standard_rev),
        ('by_space_type.standard_count',       e.spc_standard_count,a.spc_standard_count),
        ('by_space_type.ev_revenue',           e.spc_ev_rev,        a.spc_ev_rev),
        ('revenue_split.hourly',               e.split_hourly,      a.split_hourly),
        ('revenue_split.permit',               e.split_permit,      a.split_permit),
        ('manifest.R1_paid_cents',             e.man_r1_paid::bigint,    a.man_r1_paid::bigint),
        ('manifest.R1_balance_cents',          e.man_r1_balance::bigint, a.man_r1_balance::bigint),
        ('balance_cents.R1',                   e.bal_r1::bigint,    a.bal_r1::bigint),
        ('balance_cents.R2',                   e.bal_r2::bigint,    a.bal_r2::bigint)
      ) as x(col, exp, got)
     where x.exp is distinct from x.got
  loop
    v := v + 1;
    raise warning 'STAGE % %: expected %, got %', r.stage, r.col, r.exp, r.got;
  end loop;
  if v > 0 then
    raise exception 'CHECK4 FAIL: % of 84 reporting cells differ from hand-computed', v;
  end if;

  -- The twins must agree row for row, at every stage, not just match a constant.
  if exists (select 1 from actual a
              where a.man_r1_paid <> 10000 - a.bal_r1) then
    raise exception 'CHECK4 FAIL: facility_daily_manifest and reservation_balance_cents disagree';
  end if;

  raise notice 'CHECK4 PASS: all 6 readers match hand-computed numbers across 4 stages; twins agree';
end $$;



-- ---------------------------------------------------------------------------
-- CHECK 5 -- authorization, plus re-collectability. Both mutate money, so both
-- run AFTER the last capture: reversing B2 or taking cash again mid-matrix
-- would move numbers this file hand-computed.
--
-- The asymmetry IS the control: an attendant may take money and may not reverse
-- it. Also pins the double-refund refusal.
-- ---------------------------------------------------------------------------
do $$
declare v_b2 uuid; v_msg text; v_status text;
begin
  select id into v_b2 from booth_ids where label = 'B2';

  -- ATTENDANT: denied.
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
  begin
    perform public.refund_booth_payment(v_b2, 'attendant attempt');
    raise exception 'CHECK5 FAIL: an attendant was allowed to refund';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'ROLE_NOT_ALLOWED' then raise; end if;
  end;
  select bp.status into v_status from public.booth_payments bp where bp.id = v_b2;
  if v_status <> 'succeeded' then
    raise exception 'CHECK5 FAIL: the denied attempt still changed status to %', v_status;
  end if;

  -- MANAGER: allowed.
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform public.refund_booth_payment(v_b2, 'manager reversal');
  select bp.status into v_status from public.booth_payments bp where bp.id = v_b2;
  if v_status <> 'refunded' then
    raise exception 'CHECK5 FAIL: a manager refund left status %', v_status;
  end if;

  -- Twice is a mistake, not a no-op.
  begin
    perform public.refund_booth_payment(v_b2, 'again');
    raise exception 'CHECK5 FAIL: a second refund was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'ALREADY_REFUNDED' then raise; end if;
  end;

  -- ADMIN: allowed (CHECK 1 already exercised the admin path end to end).
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  raise notice 'CHECK5 PASS: attendant denied, manager and admin allowed, double refund refused';
end $$;

-- The balance is not just a number that moved: the money is collectable again.
-- Runs AFTER the last capture on purpose -- taking money here perturbs nothing.
-- At stage 3 everything on R1 is reversed, so the balance is the full 10000 and
-- a 3000 collection must leave 7000.
do $$
declare v_id uuid; v_balance integer;
begin
  select rb.payment_id, rb.balance_cents into v_id, v_balance
    from public.record_booth_payment(
      'fc000000-0000-0000-0000-0000000000d1', 3000, 'cash', 're-collected') rb;
  if v_id is null or v_balance <> 7000 then
    raise exception
      'CHECK5 FAIL: re-collection returned balance %, expected 7000', v_balance;
  end if;
  raise notice 'CHECK5 PASS: a fully reversed reservation is collectable again (10000 -> 7000)';
end $$;

reset role;

select a.stage,
       a.dash_total, a.dash_cash, a.dash_permit, a.dash_stripe,
       a.per_count, a.per_revenue, a.per_refunded,
       a.spc_standard_rev, a.split_hourly, a.split_permit,
       a.man_r1_paid, a.bal_r1, a.bal_r2
  from actual a
 order by a.stage;

rollback;
