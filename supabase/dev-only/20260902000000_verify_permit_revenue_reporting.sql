-- DEV-ONLY verification for permit revenue in the reporting functions.
--
-- permit_payments is EMPTY on parkos-dev and record_permit_payment has never run
-- there, so there is no real permit money to check against. Ground truth is built
-- here instead: fixed rows with hand-computed totals, asserted against each of the
-- four functions SEPARATELY. Nothing is inferred from one function to another, and
-- no expected figure is read back out of the function it is checking.
-- Everything rolls back.
--
-- FIXTURE. Two facilities, two July dates, three space types, both timezones
-- America/Los_Angeles. July 2026 is deliberately clear of the seeded August data,
-- and CHECK0 below fails if that ever stops being true.
--
--   Permit payments
--     PP1  Lot R  space R1 standard   local 2026-07-10   15000
--     PP2  Lot R  space R2 ev         local 2026-07-10   22000
--     PP3  Lot R  space R1 standard   local 2026-07-11   15000
--     PP4  Lot C  space C1 accessible local 2026-07-11    9000
--     PP5  Lot R  space R1 standard   TODAY               5000
--
--   Reservation money, Lot R, all on space R1 (standard)
--     SP1  stripe succeeded  local 2026-07-10   1000
--     SP2  stripe REFUNDED   local 2026-07-10    700   <- never revenue
--     BP1  booth cash        local 2026-07-10    250
--     BP2  booth card        local 2026-07-11    400
--     SP3  stripe succeeded  TODAY               800
--     BP3  booth cash        TODAY               300
--
-- HAND ARITHMETIC, Lot R over 2026-07-01..2026-07-31
--   07-10: 1000 + 250 + 15000 + 22000            = 38250, 4 payments, 1 refunded
--   07-11:         400 + 15000                   = 15400, 2 payments, 0 refunded
--   range total                                  = 53650
--   by space type: standard 1000+250+400+15000+15000 = 31650 over 5 payments
--                  ev                               = 22000 over 1 payment
--                  31650 + 22000                    = 53650  (agrees with above)
--   split:         hourly 1000+250+400              =  1650
--                  permit 15000+22000+15000         = 52000
--                  1650 + 52000                     = 53650  (agrees with above)
--   dashboard TODAY: 800 + 300 + 0 + 5000           =  6100
--
-- HAND ARITHMETIC, Lot C over the same range
--   07-11: 9000 only. This bucket exists ONLY because of permit money -- before
--   this migration the whole facility returned no rows at all.
--
-- Run after 20260902000000_permit_revenue_reporting.sql is applied:
--   npx supabase db query --linked --file supabase/dev-only/20260902000000_verify_permit_revenue_reporting.sql

begin;

-- ---------------------------------------------------------------------------
-- Fixtures in the seeded Harbor Park organization.
-- ---------------------------------------------------------------------------

insert into public.facilities (id, org_id, name, timezone)
values
  ('da000000-0000-0000-0000-0000000000f1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Permit Revenue Lot R', 'America/Los_Angeles'),
  ('db000000-0000-0000-0000-0000000000f1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Permit Only Lot C', 'America/Los_Angeles');

insert into public.zones (id, org_id, facility_id, name)
values
  ('da000000-0000-0000-0000-0000000000f2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000f1', 'Zone R'),
  ('db000000-0000-0000-0000-0000000000f2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'db000000-0000-0000-0000-0000000000f1', 'Zone C');

insert into public.spaces (id, org_id, zone_id, space_number, space_type)
values
  ('da000000-0000-0000-0000-00000000000a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000f2', 'PRV-R1', 'standard'),
  ('da000000-0000-0000-0000-00000000000b', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000f2', 'PRV-R2', 'ev'),
  ('db000000-0000-0000-0000-00000000000a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'db000000-0000-0000-0000-0000000000f2', 'PRV-C1', 'accessible');

insert into public.customers (id, org_id, full_name)
values ('da000000-0000-0000-0000-0000000000c1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Permit Revenue Driver');

insert into public.permits
  (id, org_id, facility_id, space_id, customer_id, during,
   monthly_rate_cents, currency, status)
values
  ('da000000-0000-0000-0000-0000000000e1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000f1', 'da000000-0000-0000-0000-00000000000a',
   'da000000-0000-0000-0000-0000000000c1', tstzrange(now() - interval '60 days', null, '[)'),
   15000, 'USD', 'active'),
  ('da000000-0000-0000-0000-0000000000e2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000f1', 'da000000-0000-0000-0000-00000000000b',
   'da000000-0000-0000-0000-0000000000c1', tstzrange(now() - interval '60 days', null, '[)'),
   22000, 'USD', 'active'),
  ('db000000-0000-0000-0000-0000000000e1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'db000000-0000-0000-0000-0000000000f1', 'db000000-0000-0000-0000-00000000000a',
   'da000000-0000-0000-0000-0000000000c1', tstzrange(now() - interval '60 days', null, '[)'),
   9000, 'USD', 'active');

-- 18:00Z in July is 11:00 local in America/Los_Angeles, so each row lands
-- unambiguously inside its intended local calendar day.
insert into public.permit_payments
  (id, org_id, permit_id, stripe_invoice_id, amount_cents, currency, created_at)
values
  ('da000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000e1', 'in_prv_r1_jul10', 15000, 'USD',
   '2026-07-10 18:00:00+00'),
  ('da000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000e2', 'in_prv_r2_jul10', 22000, 'USD',
   '2026-07-10 18:00:00+00'),
  ('da000000-0000-0000-0000-0000000000a3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000e1', 'in_prv_r1_jul11', 15000, 'USD',
   '2026-07-11 18:00:00+00'),
  ('db000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'db000000-0000-0000-0000-0000000000e1', 'in_prv_c1_jul11', 9000, 'USD',
   '2026-07-11 18:00:00+00'),
  ('da000000-0000-0000-0000-0000000000a4', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000e1', 'in_prv_r1_today', 5000, 'USD',
   now());

insert into public.reservations
  (id, org_id, facility_id, space_id, customer_id, during, status,
   booking_code, price_breakdown, total_cents)
values
  ('da000000-0000-0000-0000-0000000000d1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000f1', 'da000000-0000-0000-0000-00000000000a',
   'da000000-0000-0000-0000-0000000000c1',
   tstzrange(now() - interval '2 hours', now() + interval '2 hours', '[)'),
   'confirmed', 'PKS-PRVA23',
   '{"currency":"USD","line_items":[],"total_cents":1000}', 1000);

insert into public.payments
  (id, org_id, reservation_id, stripe_checkout_session_id,
   amount_cents, status, created_at)
values
  ('da000000-0000-0000-0000-0000000000b1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000d1', 'cs_prv_jul10_ok', 1000, 'succeeded',
   '2026-07-10 18:00:00+00'),
  -- Refunded, so it must never be revenue but must raise refunded_count by one.
  ('da000000-0000-0000-0000-0000000000b2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000d1', 'cs_prv_jul10_refund', 700, 'refunded',
   '2026-07-10 18:00:00+00'),
  ('da000000-0000-0000-0000-0000000000b3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000d1', 'cs_prv_today_ok', 800, 'succeeded',
   now());

insert into public.booth_payments
  (id, org_id, reservation_id, amount_cents, method, collected_by, created_at)
values
  ('da000000-0000-0000-0000-0000000000c2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000d1', 250, 'cash',
   '00000000-0000-0000-0000-0000000000a1', '2026-07-10 18:00:00+00'),
  ('da000000-0000-0000-0000-0000000000c3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000d1', 400, 'card',
   '00000000-0000-0000-0000-0000000000a1', '2026-07-11 18:00:00+00'),
  ('da000000-0000-0000-0000-0000000000c4', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'da000000-0000-0000-0000-0000000000d1', 300, 'cash',
   '00000000-0000-0000-0000-0000000000a1', now());

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------
-- Every expected number below is the hand arithmetic from the header, written
-- as a literal. Nothing is derived from the function under test.
-- ---------------------------------------------------------------------------

select 0 as seq,
       'CHECK0 July 2026 is otherwise empty, so the null-facility totals below are only fixtures'
         as check,
       '0' as expected,
       (
         select pg_catalog.count(*)::text from public.payments p
          where p.created_at >= '2026-07-01+00' and p.created_at < '2026-08-01+00'
            and p.id not in ('da000000-0000-0000-0000-0000000000b1',
                             'da000000-0000-0000-0000-0000000000b2')
       ) as actual
union all
-- ---- 1. report_revenue_by_period, Lot R, day grain -----------------------
select 1, 'by_period Lot R 2026-07-10: revenue|payments|refunded|stripe|cash|card|permit',
       '38250|4|1|1000|250|0|37000',
       revenue_cents || '|' || payments_count || '|' || refunded_count || '|'
         || stripe_revenue_cents || '|' || booth_cash_revenue_cents || '|'
         || booth_card_revenue_cents || '|' || permit_revenue_cents
  from public.report_revenue_by_period(
    '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1', 'day')
 where bucket = '2026-07-10'
union all
select 2, 'by_period Lot R 2026-07-11: revenue|payments|refunded|stripe|cash|card|permit',
       '15400|2|0|0|0|400|15000',
       revenue_cents || '|' || payments_count || '|' || refunded_count || '|'
         || stripe_revenue_cents || '|' || booth_cash_revenue_cents || '|'
         || booth_card_revenue_cents || '|' || permit_revenue_cents
  from public.report_revenue_by_period(
    '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1', 'day')
 where bucket = '2026-07-11'
union all
select 3, 'by_period Lot R permit payment counts per day',
       '2|1',
       (select string_agg(permit_payments_count::text, '|' order by bucket)
          from public.report_revenue_by_period(
            '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1', 'day'))
union all
-- Lot C has no reservation money at all: this bucket exists only because permit
-- revenue now passes the HAVING clause.
select 4, 'by_period Lot C 2026-07-11 (permit-only bucket): revenue|payments|permit',
       '9000|1|9000',
       revenue_cents || '|' || payments_count || '|' || permit_revenue_cents
  from public.report_revenue_by_period(
    '2026-07-01', '2026-07-31', 'db000000-0000-0000-0000-0000000000f1', 'day')
 where bucket = '2026-07-11'
union all
select 5, 'by_period Lot R month grain total revenue',
       '53650',
       revenue_cents::text
  from public.report_revenue_by_period(
    '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1', 'month')
union all
-- ---- 2. report_revenue_by_space_type -------------------------------------
select 6, 'by_space_type Lot R standard: revenue|payments|stripe|cash|card|permit|permitcount',
       '31650|5|1000|250|400|30000|2',
       revenue_cents || '|' || payments_count || '|' || stripe_revenue_cents || '|'
         || booth_cash_revenue_cents || '|' || booth_card_revenue_cents || '|'
         || permit_revenue_cents || '|' || permit_payments_count
  from public.report_revenue_by_space_type(
    '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1')
 where space_type = 'standard'
union all
select 7, 'by_space_type Lot R ev (permit money only): revenue|payments|permit',
       '22000|1|22000',
       revenue_cents || '|' || payments_count || '|' || permit_revenue_cents
  from public.report_revenue_by_space_type(
    '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1')
 where space_type = 'ev'
union all
select 8, 'by_space_type Lot C accessible: revenue|payments|permit',
       '9000|1|9000',
       revenue_cents || '|' || payments_count || '|' || permit_revenue_cents
  from public.report_revenue_by_space_type(
    '2026-07-01', '2026-07-31', 'db000000-0000-0000-0000-0000000000f1')
 where space_type = 'accessible'
union all
-- ---- 3. report_revenue_split ---------------------------------------------
select 9, 'split Lot R hourly: revenue|stripe|cash|card|recorded',
       '1650|1000|250|400|true',
       revenue_cents || '|' || stripe_revenue_cents || '|'
         || booth_cash_revenue_cents || '|' || booth_card_revenue_cents || '|'
         || recorded::text
  from public.report_revenue_split(
    '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1')
 where category = 'hourly'
union all
select 10, 'split Lot R permit: revenue|stripe|cash|card|recorded|note',
       '52000|52000|0|0|true|(null)',
       revenue_cents || '|' || stripe_revenue_cents || '|'
         || booth_cash_revenue_cents || '|' || booth_card_revenue_cents || '|'
         || recorded::text || '|' || coalesce(note, '(null)')
  from public.report_revenue_split(
    '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1')
 where category = 'permit'
union all
-- Ascending, so the pair reads hourly-then-permit: 'hourly' sorts before 'permit'.
select 11, 'split Lot C: hourly|permit',
       '0|9000',
       (select string_agg(revenue_cents::text, '|' order by category)
          from public.report_revenue_split(
            '2026-07-01', '2026-07-31', 'db000000-0000-0000-0000-0000000000f1'))
union all
-- ---- 4. facility_dashboard_summary ---------------------------------------
select 12, 'dashboard Lot R today: total|stripe|cash|card|permit',
       '6100|800|300|0|5000',
       today_revenue_cents || '|' || today_stripe_revenue_cents || '|'
         || today_booth_cash_revenue_cents || '|' || today_booth_card_revenue_cents
         || '|' || today_permit_revenue_cents
  from public.facility_dashboard_summary('da000000-0000-0000-0000-0000000000f1')
union all
select 13, 'dashboard Lot C today (no money today): total|permit',
       '0|0',
       today_revenue_cents || '|' || today_permit_revenue_cents
  from public.facility_dashboard_summary('db000000-0000-0000-0000-0000000000f1')
union all
-- ---- 5. cross-function agreement -----------------------------------------
-- Each side is computed by a DIFFERENT function, so these catch a permit branch
-- that was added to one function but not another.
select 14, 'AGREEMENT split(hourly+permit) = by_period total, Lot R',
       '53650|53650',
       (select sum(revenue_cents)::text from public.report_revenue_split(
          '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1'))
       || '|' ||
       (select revenue_cents::text from public.report_revenue_by_period(
          '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1', 'month'))
union all
select 15, 'AGREEMENT sum(by_space_type) = by_period total, Lot R',
       '53650|53650',
       (select sum(revenue_cents)::text from public.report_revenue_by_space_type(
          '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1'))
       || '|' ||
       (select revenue_cents::text from public.report_revenue_by_period(
          '2026-07-01', '2026-07-31', 'da000000-0000-0000-0000-0000000000f1', 'month'))
union all
select 16, 'AGREEMENT all-facility July total = Lot R + Lot C = 53650 + 9000',
       '62650',
       (select revenue_cents::text from public.report_revenue_by_period(
          '2026-07-01', '2026-07-31', null, 'month'))
 order by seq;

rollback;
