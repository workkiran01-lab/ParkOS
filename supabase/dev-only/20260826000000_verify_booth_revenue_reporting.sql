-- DEV-ONLY verification for booth revenue reporting.
--
-- This is intentionally not a function-output-compares-to-function-output
-- check. Fixed raw payment rows are inserted, their ground truth is derived
-- directly from the two ledgers and checked against hand arithmetic, and only
-- then are the reporting RPCs compared with that independent result.
-- Everything rolls back, so no fixture survives.
--
-- Hand arithmetic for Revenue Test Lot:
--   Stripe succeeded 1000c + booth cash 250c + booth card 400c = 1650c.
--   A failed 9000c Stripe attempt and a partially-refunded 300c attempt are
--   not revenue; the latter contributes one refunded_count.
--
-- Hand arithmetic for Stripe-only Control Lot:
--   Stripe succeeded 700c + no booth rows = 700c, exactly the legacy result.
--
-- Run only after both 20260825010000_booth_payments.sql and
-- 20260826000000_booth_revenue_reporting.sql have been applied to parkos-dev:
--
--   npx supabase db query --linked --file supabase/dev-only/20260826000000_verify_booth_revenue_reporting.sql

begin;

-- ---------------------------------------------------------------------------
-- Fixtures in the seeded Harbor Park organization.
-- ---------------------------------------------------------------------------

insert into public.facilities (id, org_id, name, timezone)
values
  ('fe100000-0000-0000-0000-0000000000f1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Revenue Test Lot', 'America/Los_Angeles'),
  ('fe200000-0000-0000-0000-0000000000f1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Stripe-only Control Lot', 'America/Los_Angeles');

insert into public.zones (id, org_id, facility_id, name)
values
  ('fe100000-0000-0000-0000-0000000000f2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe100000-0000-0000-0000-0000000000f1', 'Revenue Zone'),
  ('fe200000-0000-0000-0000-0000000000f2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe200000-0000-0000-0000-0000000000f1', 'Control Zone');

insert into public.spaces
  (id, org_id, zone_id, space_number, space_type)
values
  ('fe100000-0000-0000-0000-0000000000f3',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe100000-0000-0000-0000-0000000000f2', 'REV-1', 'standard'),
  ('fe200000-0000-0000-0000-0000000000f3',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe200000-0000-0000-0000-0000000000f2', 'CTL-1', 'standard');

insert into public.customers (id, org_id, full_name)
values ('fe100000-0000-0000-0000-0000000000f4',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Revenue Test Driver');

insert into public.reservations
  (id, org_id, facility_id, space_id, customer_id, during, status,
   booking_code, price_breakdown, total_cents)
values
  ('fe100000-0000-0000-0000-0000000000a1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe100000-0000-0000-0000-0000000000f1',
   'fe100000-0000-0000-0000-0000000000f3',
   'fe100000-0000-0000-0000-0000000000f4',
   tstzrange(now() - interval '1 hour', now() + interval '1 hour', '[)'),
   'confirmed', 'PKS-RPTA23',
   '{"currency":"USD","line_items":[],"total_cents":1550}', 1550),
  ('fe100000-0000-0000-0000-0000000000a2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe100000-0000-0000-0000-0000000000f1',
   'fe100000-0000-0000-0000-0000000000f3',
   'fe100000-0000-0000-0000-0000000000f4',
   tstzrange(now() + interval '2 hours', now() + interval '3 hours', '[)'),
   'confirmed', 'PKS-RPTB24',
   '{"currency":"USD","line_items":[],"total_cents":400}', 400),
  ('fe200000-0000-0000-0000-0000000000a1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe200000-0000-0000-0000-0000000000f1',
   'fe200000-0000-0000-0000-0000000000f3',
   'fe100000-0000-0000-0000-0000000000f4',
   tstzrange(now() - interval '1 hour', now() + interval '1 hour', '[)'),
   'confirmed', 'PKS-RPTC25',
   '{"currency":"USD","line_items":[],"total_cents":700}', 700);

insert into public.payments
  (id, org_id, reservation_id, stripe_checkout_session_id,
   amount_cents, status, created_at)
values
  ('fe100000-0000-0000-0000-0000000000b1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe100000-0000-0000-0000-0000000000a1', 'cs_report_success',
   1000, 'succeeded', now()),
  ('fe100000-0000-0000-0000-0000000000b2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe100000-0000-0000-0000-0000000000a1', 'cs_report_failed',
   9000, 'failed', now()),
  ('fe100000-0000-0000-0000-0000000000b3',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe100000-0000-0000-0000-0000000000a1', 'cs_report_partial_refund',
   300, 'partially_refunded', now()),
  ('fe200000-0000-0000-0000-0000000000b1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe200000-0000-0000-0000-0000000000a1', 'cs_report_control',
   700, 'succeeded', now());

-- A1 deliberately has both Stripe and booth money. Keeping both rows proves
-- that mixed-payment reservations are additive rather than source-selected.
insert into public.booth_payments
  (id, org_id, reservation_id, amount_cents, method, collected_by, created_at)
values
  ('fe100000-0000-0000-0000-0000000000c1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe100000-0000-0000-0000-0000000000a1', 250, 'cash',
   '00000000-0000-0000-0000-0000000000a1', now()),
  ('fe100000-0000-0000-0000-0000000000c2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fe100000-0000-0000-0000-0000000000a2', 400, 'card',
   '00000000-0000-0000-0000-0000000000a1', now());

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------
-- CHECK 1: derive ground truth from raw rows, then check hand arithmetic.
-- ---------------------------------------------------------------------------

do $$
declare
  v_stripe bigint;
  v_cash bigint;
  v_card bigint;
begin
  select coalesce(pg_catalog.sum(p.amount_cents), 0::bigint)
    into v_stripe
    from public.payments p
    join public.reservations r on r.id = p.reservation_id
   where r.facility_id = 'fe100000-0000-0000-0000-0000000000f1'
     and p.status = 'succeeded';

  select coalesce(
           pg_catalog.sum(bp.amount_cents) filter (where bp.method = 'cash'),
           0::bigint
         ),
         coalesce(
           pg_catalog.sum(bp.amount_cents) filter (where bp.method = 'card'),
           0::bigint
         )
    into v_cash, v_card
    from public.booth_payments bp
    join public.reservations r on r.id = bp.reservation_id
   where r.facility_id = 'fe100000-0000-0000-0000-0000000000f1';

  if v_stripe <> 1000 or v_cash <> 250 or v_card <> 400
     or v_stripe + v_cash + v_card <> 1650 then
    raise exception
      'CHECK1 FAIL: raw ground truth online=% cash=% card=% total=%; expected 1000/250/400/1650',
      v_stripe, v_cash, v_card, v_stripe + v_cash + v_card;
  end if;

  raise notice 'CHECK1 PASS: raw rows hand-sum to online=1000 cash=250 card=400 total=1650';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 2: dashboard summary equals the independent raw-row ground truth.
-- ---------------------------------------------------------------------------

do $$
declare
  v_total bigint;
  v_stripe bigint;
  v_cash bigint;
  v_card bigint;
begin
  select today_revenue_cents,
         today_stripe_revenue_cents,
         today_booth_cash_revenue_cents,
         today_booth_card_revenue_cents
    into v_total, v_stripe, v_cash, v_card
    from public.facility_dashboard_summary(
      'fe100000-0000-0000-0000-0000000000f1');

  if v_total <> 1650 or v_stripe <> 1000 or v_cash <> 250 or v_card <> 400 then
    raise exception
      'CHECK2 FAIL: dashboard online=% cash=% card=% total=%; expected 1000/250/400/1650',
      v_stripe, v_cash, v_card, v_total;
  end if;

  raise notice 'CHECK2 PASS: dashboard matches raw ground truth exactly';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 3: period report has the same totals, counts, and refund exclusion.
-- ---------------------------------------------------------------------------

do $$
declare
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_count bigint;
  v_total bigint;
  v_refunds bigint;
  v_stripe_count bigint;
  v_stripe bigint;
  v_cash_count bigint;
  v_cash bigint;
  v_card_count bigint;
  v_card bigint;
begin
  select payments_count, revenue_cents, refunded_count,
         stripe_payments_count, stripe_revenue_cents,
         booth_cash_payments_count, booth_cash_revenue_cents,
         booth_card_payments_count, booth_card_revenue_cents
    into v_count, v_total, v_refunds,
         v_stripe_count, v_stripe, v_cash_count, v_cash, v_card_count, v_card
    from public.report_revenue_by_period(
      v_day, v_day, 'fe100000-0000-0000-0000-0000000000f1', 'day');

  if v_count <> 3 or v_total <> 1650 or v_refunds <> 1
     or v_stripe_count <> 1 or v_stripe <> 1000
     or v_cash_count <> 1 or v_cash <> 250
     or v_card_count <> 1 or v_card <> 400 then
    raise exception
      'CHECK3 FAIL: period count=% total=% refunds=% online=%/% cash=%/% card=%/%',
      v_count, v_total, v_refunds, v_stripe_count, v_stripe,
      v_cash_count, v_cash, v_card_count, v_card;
  end if;

  raise notice 'CHECK3 PASS: period totals/counts match and refunded Stripe is excluded';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 4: space-type and hourly split expose the same additive breakdown.
-- ---------------------------------------------------------------------------

do $$
declare
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_total bigint;
  v_stripe bigint;
  v_cash bigint;
  v_card bigint;
begin
  select revenue_cents, stripe_revenue_cents,
         booth_cash_revenue_cents, booth_card_revenue_cents
    into v_total, v_stripe, v_cash, v_card
    from public.report_revenue_by_space_type(
      v_day, v_day, 'fe100000-0000-0000-0000-0000000000f1')
   where space_type = 'standard';

  if v_total <> 1650 or v_stripe <> 1000 or v_cash <> 250 or v_card <> 400 then
    raise exception 'CHECK4 FAIL: space-type breakdown = %/%/%/%',
      v_total, v_stripe, v_cash, v_card;
  end if;

  select revenue_cents, stripe_revenue_cents,
         booth_cash_revenue_cents, booth_card_revenue_cents
    into v_total, v_stripe, v_cash, v_card
    from public.report_revenue_split(
      v_day, v_day, 'fe100000-0000-0000-0000-0000000000f1')
   where category = 'hourly';

  if v_total <> 1650 or v_stripe <> 1000 or v_cash <> 250 or v_card <> 400 then
    raise exception 'CHECK4 FAIL: hourly breakdown = %/%/%/%',
      v_total, v_stripe, v_cash, v_card;
  end if;

  raise notice 'CHECK4 PASS: space-type and hourly split match raw ground truth';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 5: a facility with zero booth rows is identical to the legacy result.
-- ---------------------------------------------------------------------------

do $$
declare
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_legacy bigint;
  v_booth_count bigint;
  v_dashboard bigint;
  v_period bigint;
  v_stripe bigint;
  v_cash bigint;
  v_card bigint;
begin
  -- This is the exact pre-change revenue definition: succeeded Stripe only.
  select coalesce(pg_catalog.sum(p.amount_cents), 0::bigint)
    into v_legacy
    from public.payments p
    join public.reservations r on r.id = p.reservation_id
   where r.facility_id = 'fe200000-0000-0000-0000-0000000000f1'
     and p.status = 'succeeded';

  select pg_catalog.count(*)::bigint into v_booth_count
    from public.booth_payments bp
    join public.reservations r on r.id = bp.reservation_id
   where r.facility_id = 'fe200000-0000-0000-0000-0000000000f1';

  select today_revenue_cents, today_stripe_revenue_cents,
         today_booth_cash_revenue_cents, today_booth_card_revenue_cents
    into v_dashboard, v_stripe, v_cash, v_card
    from public.facility_dashboard_summary(
      'fe200000-0000-0000-0000-0000000000f1');

  select revenue_cents into v_period
    from public.report_revenue_by_period(
      v_day, v_day, 'fe200000-0000-0000-0000-0000000000f1', 'day');

  if v_legacy <> 700 or v_booth_count <> 0
     or v_dashboard <> v_legacy or v_period <> v_legacy
     or v_stripe <> v_legacy or v_cash <> 0 or v_card <> 0 then
    raise exception
      'CHECK5 FAIL: legacy=% booth_rows=% dashboard=% period=% online=% cash=% card=%',
      v_legacy, v_booth_count, v_dashboard, v_period, v_stripe, v_cash, v_card;
  end if;

  raise notice 'CHECK5 PASS: zero-booth facility remains exactly 700c everywhere';
end $$;

rollback;
