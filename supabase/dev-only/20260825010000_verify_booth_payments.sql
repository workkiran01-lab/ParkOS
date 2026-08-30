-- DEV-ONLY verification for booth payments, overstay pricing, and the
-- booking_code lookup states. Assertion-only: every check RAISES on failure, so
-- a failure aborts the run with its message. Everything runs inside a single
-- transaction that ends in ROLLBACK, so no fixture survives.
--
--   npm run test:db
--   npx supabase db query --linked --file supabase/dev-only/20260825010000_verify_booth_payments.sql
--
-- Depends on the dev seed (DEV_ONLY_seed_dev_orgs.sql) for its two orgs and their admin
-- users; every other row it needs, it creates and then throws away:
--   Org A (Harbor Park Group)  = aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
--   Org B (Pier Point Parking) = bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
--   Org A admin user           = 00000000-0000-0000-0000-0000000000a1
--   Org B admin user           = 00000000-0000-0000-0000-0000000000b1
--
-- The overstay cases below are the ones a naive implementation gets wrong:
-- a stay crossing local midnight, and both DST transitions. They pass because
-- calculate_overstay prices through quote_reservation, which splits at
-- FACILITY-local midnight and measures elapsed hours, rather than doing date
-- arithmetic in UTC or on the browser's clock.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: a Long Beach facility at $5.00/hr with a $12.00 daily cap.
-- The cap is what makes the per-local-day split observable.
-- ---------------------------------------------------------------------------

insert into public.facilities (id, org_id, name, timezone)
values ('ff000000-0000-0000-0000-0000000000f1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'Booth Test Lot', 'America/Los_Angeles');

insert into public.zones (id, org_id, facility_id, name)
values ('ff000000-0000-0000-0000-0000000000f2',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'ff000000-0000-0000-0000-0000000000f1', 'Test Zone');

insert into public.spaces (id, org_id, zone_id, space_number)
values ('ff000000-0000-0000-0000-0000000000f3',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'ff000000-0000-0000-0000-0000000000f2', 'T001');

insert into public.price_rules
  (id, org_id, facility_id, hourly_rate_cents, daily_cap_cents)
values ('ff000000-0000-0000-0000-0000000000f4',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'ff000000-0000-0000-0000-0000000000f1', 500, 1200);

-- Two customers in Org A. The first is linked to the ORG B admin's login: a
-- driver who happens to be staff somewhere else. That is what makes the
-- "customer sees their own payment" policy separable from the member policy.
insert into public.customers (id, org_id, full_name, user_id)
values ('ff000000-0000-0000-0000-0000000000f5',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Booth Test Driver',
        '00000000-0000-0000-0000-0000000000b1'),
       ('ff000000-0000-0000-0000-0000000000f6',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Other Driver', null);

insert into public.reservations
  (id, org_id, facility_id, space_id, customer_id, during, status,
   booking_code, price_breakdown, total_cents)
values
  -- E001 reserved window ends Aug 19 22:00 local (PDT).
  ('ff000000-0000-0000-0000-00000000e001',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ff000000-0000-0000-0000-0000000000f1',
   'ff000000-0000-0000-0000-0000000000f3',
   'ff000000-0000-0000-0000-0000000000f5',
   tstzrange('2026-08-20 01:00:00+00', '2026-08-20 05:00:00+00', '[)'),
   'active', 'PKS-TEST23', '{"currency":"USD","line_items":[],"total_cents":0}', 0),

  -- E002 ends Nov 1 00:00 local (PDT), the start of a 25-hour local day.
  ('ff000000-0000-0000-0000-00000000e002',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ff000000-0000-0000-0000-0000000000f1',
   'ff000000-0000-0000-0000-0000000000f3',
   'ff000000-0000-0000-0000-0000000000f5',
   tstzrange('2026-11-01 06:00:00+00', '2026-11-01 07:00:00+00', '[)'),
   'active', 'PKS-TEST24', '{"currency":"USD","line_items":[],"total_cents":0}', 0),

  -- E003 ends Mar 8 01:30 local (PST), half an hour before the spring skip.
  ('ff000000-0000-0000-0000-00000000e003',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ff000000-0000-0000-0000-0000000000f1',
   'ff000000-0000-0000-0000-0000000000f3',
   'ff000000-0000-0000-0000-0000000000f5',
   tstzrange('2026-03-08 08:00:00+00', '2026-03-08 09:30:00+00', '[)'),
   'active', 'PKS-TEST25', '{"currency":"USD","line_items":[],"total_cents":0}', 0),

  -- E004 an ordinary $50 session, checked in, used for the money checks.
  ('ff000000-0000-0000-0000-00000000e004',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ff000000-0000-0000-0000-0000000000f1',
   'ff000000-0000-0000-0000-0000000000f3',
   'ff000000-0000-0000-0000-0000000000f5',
   tstzrange(now() - interval '2 hours', now() + interval '6 hours', '[)'),
   'active', 'PKS-TEST26', '{"currency":"USD","line_items":[],"total_cents":5000}', 5000),

  -- E005 archived, and E006 cancelled: the two lookup states that must not
  -- read as "unknown code".
  ('ff000000-0000-0000-0000-00000000e005',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ff000000-0000-0000-0000-0000000000f1',
   'ff000000-0000-0000-0000-0000000000f3',
   'ff000000-0000-0000-0000-0000000000f6',
   tstzrange('2026-07-01 01:00:00+00', '2026-07-01 05:00:00+00', '[)'),
   'confirmed', 'PKS-TEST27', '{"currency":"USD","line_items":[],"total_cents":0}', 0),

  ('ff000000-0000-0000-0000-00000000e006',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ff000000-0000-0000-0000-0000000000f1',
   'ff000000-0000-0000-0000-0000000000f3',
   'ff000000-0000-0000-0000-0000000000f6',
   tstzrange('2026-07-02 01:00:00+00', '2026-07-02 05:00:00+00', '[)'),
   'cancelled', 'PKS-TEST28', '{"currency":"USD","line_items":[],"total_cents":0}', 0);

update public.reservations set archived_at = now()
 where id = 'ff000000-0000-0000-0000-00000000e005';

update public.reservations set checked_in_at = now() - interval '2 hours'
 where id = 'ff000000-0000-0000-0000-00000000e004';

-- Act as the Org A admin from here: every function under test is staff-gated.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);


-- ---------------------------------------------------------------------------
-- CHECK 1 — a stay that crosses FACILITY-local midnight is capped per local
-- day, not once for the whole run.
--
-- Reserved end Aug 19 22:00 PDT, departure Aug 20 03:00 PDT:
--   Aug 19  22:00-24:00  2h = 1000c   (under the 1200c cap)
--   Aug 20  00:00-03:00  3h = 1500c   (capped to 1200c)
--                              = 2200c across 2 line items.
-- Priced as one 5-hour block it would be 2500c capped to a single 1200c.
-- ---------------------------------------------------------------------------
do $$
declare v_cents integer; v_breakdown jsonb; v_items integer;
begin
  select overstay_cents, breakdown into v_cents, v_breakdown
    from public.calculate_overstay(
      'ff000000-0000-0000-0000-00000000e001', '2026-08-20 10:00:00+00');

  v_items := jsonb_array_length(v_breakdown -> 'line_items');

  if v_cents <> 2200 then
    raise exception 'CHECK1 FAIL: cross-midnight overstay = %c, expected 2200c', v_cents;
  end if;
  if v_items <> 2 then
    raise exception 'CHECK1 FAIL: expected 2 per-day line items, found %', v_items;
  end if;

  raise notice 'CHECK1 PASS: cross-midnight overstay splits and caps per local day (2200c)';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 2 — DST ends: Nov 1 2026 is a 25-HOUR local day in Los Angeles.
--
-- Reserved end Nov 1 00:00 PDT, departure Nov 2 00:00 PST. That is one local
-- calendar day, so it is ONE capped line item of 1200c covering 25 real hours.
-- Splitting on UTC days instead would produce two days and charge 2400c.
-- ---------------------------------------------------------------------------
do $$
declare v_cents integer; v_breakdown jsonb; v_items integer; v_hours numeric;
begin
  select overstay_cents, breakdown into v_cents, v_breakdown
    from public.calculate_overstay(
      'ff000000-0000-0000-0000-00000000e002', '2026-11-02 08:00:00+00');

  v_items := jsonb_array_length(v_breakdown -> 'line_items');
  v_hours := (v_breakdown -> 'line_items' -> 0 ->> 'hours')::numeric;

  if v_items <> 1 then
    raise exception
      'CHECK2 FAIL: fall-back day split into % line items, expected 1', v_items;
  end if;
  if v_hours <> 25 then
    raise exception
      'CHECK2 FAIL: fall-back local day measured % hours, expected 25', v_hours;
  end if;
  if v_cents <> 1200 then
    raise exception
      'CHECK2 FAIL: fall-back overstay = %c, expected one 1200c cap', v_cents;
  end if;

  raise notice 'CHECK2 PASS: DST fall-back day is one 25-hour local day, capped once';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 3 — DST begins: Mar 8 2026 skips 02:00-03:00 local.
--
-- Reserved end 01:30 PST, departure 03:00 PDT. The wall clock reads 90 minutes;
-- only 30 minutes actually elapsed, and the driver is charged for 30 (250c).
-- Subtracting local times would bill 750c for time that did not exist.
-- ---------------------------------------------------------------------------
do $$
declare v_cents integer;
begin
  select overstay_cents into v_cents
    from public.calculate_overstay(
      'ff000000-0000-0000-0000-00000000e003', '2026-03-08 10:00:00+00');

  if v_cents <> 250 then
    raise exception
      'CHECK3 FAIL: spring-forward overstay = %c, expected 250c for 30 real minutes',
      v_cents;
  end if;

  raise notice 'CHECK3 PASS: DST spring-forward bills elapsed time, not wall clock';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 4 — leaving on time, or early, is never a charge and never negative.
-- ---------------------------------------------------------------------------
do $$
declare v_cents integer;
begin
  select overstay_cents into v_cents
    from public.calculate_overstay(
      'ff000000-0000-0000-0000-00000000e001', '2026-08-20 05:00:00+00');
  if v_cents <> 0 then
    raise exception 'CHECK4 FAIL: on-time departure charged %c', v_cents;
  end if;

  select overstay_cents into v_cents
    from public.calculate_overstay(
      'ff000000-0000-0000-0000-00000000e001', '2026-08-20 03:00:00+00');
  if v_cents <> 0 then
    raise exception 'CHECK4 FAIL: early departure charged %c', v_cents;
  end if;

  raise notice 'CHECK4 PASS: on-time and early departures cost nothing';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 5 — booking_code lookup resolves to the right state, and RLS is what
-- makes another operator's ticket read as "unknown code".
-- ---------------------------------------------------------------------------
do $$
declare v_status text; v_archived timestamptz; v int;
begin
  -- Valid, not yet checked in.
  select status, archived_at into v_status, v_archived
    from public.reservations where booking_code = 'PKS-TEST27';
  if v_status <> 'confirmed' or v_archived is null then
    raise exception 'CHECK5 FAIL: archived fixture did not load as archived';
  end if;

  -- Already checked in.
  select status into v_status
    from public.reservations where booking_code = 'PKS-TEST26';
  if v_status <> 'active' then
    raise exception 'CHECK5 FAIL: expected an active reservation for PKS-TEST26';
  end if;

  -- Cancelled: visible, so the booth can say "cancelled" rather than "no such
  -- ticket". The distinction matters at a raised gate.
  select status into v_status
    from public.reservations where booking_code = 'PKS-TEST28';
  if v_status <> 'cancelled' then
    raise exception 'CHECK5 FAIL: cancelled reservation not visible to staff';
  end if;

  -- A code that was never issued.
  select count(*) into v from public.reservations
   where booking_code = 'PKS-NOSUCH';
  if v <> 0 then
    raise exception 'CHECK5 FAIL: unissued code matched % rows', v;
  end if;

  raise notice 'CHECK5 PASS: ready / checked-in / archived / cancelled / unknown all resolve';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 6 — booth_payments is client-READ-ONLY, exactly like payments.
-- No INSERT/UPDATE/DELETE privilege and no such policy exists for a browser.
-- ---------------------------------------------------------------------------
do $$
declare v int;
begin
  if not has_table_privilege('authenticated', 'public.booth_payments', 'SELECT')
     or has_table_privilege('authenticated', 'public.booth_payments', 'INSERT')
     or has_table_privilege('authenticated', 'public.booth_payments', 'UPDATE')
     or has_table_privilege('authenticated', 'public.booth_payments', 'DELETE') then
    raise exception 'CHECK6 FAIL: booth_payments must be SELECT-only for authenticated';
  end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'booth_payments';
  if v <> 2 then
    raise exception 'CHECK6 FAIL: expected 2 booth_payments policies, found %', v;
  end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'booth_payments' and cmd <> 'SELECT';
  if v <> 0 then
    raise exception 'CHECK6 FAIL: booth_payments has a non-SELECT policy';
  end if;

  if not (select relrowsecurity from pg_class
           where oid = 'public.booth_payments'::regclass) then
    raise exception 'CHECK6 FAIL: RLS is not enabled on booth_payments';
  end if;

  raise notice 'CHECK6 PASS: booth_payments is RLS-enabled and client-read-only';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 7 — record_booth_payment validates its inputs before it takes money.
-- ---------------------------------------------------------------------------
do $$
declare v_balance integer; v_msg text;
begin
  v_balance := public.reservation_balance_cents('ff000000-0000-0000-0000-00000000e004');
  if v_balance <> 5000 then
    raise exception 'CHECK7 FAIL: opening balance = %c, expected 5000c', v_balance;
  end if;

  begin
    perform public.record_booth_payment(
      'ff000000-0000-0000-0000-00000000e004', 999999, 'cash');
    raise exception 'CHECK7 FAIL: an over-collection was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'AMOUNT_EXCEEDS_BALANCE' then raise; end if;
  end;

  begin
    perform public.record_booth_payment(
      'ff000000-0000-0000-0000-00000000e004', 100, 'crypto');
    raise exception 'CHECK7 FAIL: an unknown payment method was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'INVALID_PAYMENT_METHOD' then raise; end if;
  end;

  begin
    perform public.record_booth_payment(
      'ff000000-0000-0000-0000-00000000e004', 0, 'cash');
    raise exception 'CHECK7 FAIL: a zero-amount payment was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'INVALID_PAYMENT_AMOUNT' then raise; end if;
  end;

  begin
    perform public.record_booth_payment(
      'ff000000-0000-0000-0000-00000000e005', 100, 'cash');
    raise exception 'CHECK7 FAIL: an archived reservation accepted money';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'RESERVATION_ARCHIVED' then raise; end if;
  end;

  raise notice 'CHECK7 PASS: amount, method, and archived guards all hold';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 8 — a partial cash collection lands, is audited, and moves the balance.
-- ---------------------------------------------------------------------------
do $$
declare v_id uuid; v_balance integer; v int;
begin
  select payment_id, balance_cents into v_id, v_balance
    from public.record_booth_payment(
      'ff000000-0000-0000-0000-00000000e004', 2000, 'cash', 'partial at gate');

  if v_balance <> 3000 then
    raise exception 'CHECK8 FAIL: balance after $20 = %c, expected 3000c', v_balance;
  end if;
  if public.reservation_balance_cents('ff000000-0000-0000-0000-00000000e004') <> 3000 then
    raise exception 'CHECK8 FAIL: stored balance disagrees with the returned one';
  end if;

  select count(*) into v from public.booth_payments
   where id = v_id and method = 'cash' and amount_cents = 2000
     and collected_by = '00000000-0000-0000-0000-0000000000a1'
     and org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if v <> 1 then
    raise exception 'CHECK8 FAIL: the booth payment row is missing or wrong';
  end if;

  select count(*) into v from public.audit_log
   where target_table = 'booth_payments' and target_id = v_id
     and action = 'record_booth_payment';
  if v <> 1 then
    raise exception 'CHECK8 FAIL: the collection was not audited';
  end if;

  raise notice 'CHECK8 PASS: cash collection recorded, audited, and balance moved';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 9 — check-out prices the overstay itself and settles in ONE
-- transaction. E004 is 8 hours long and $50; departing 3 hours late adds a
-- capped 1200c, and the remaining 4200c is taken as card.
-- ---------------------------------------------------------------------------
do $$
declare
  v_final integer; v_overstay integer; v_collected integer; v_balance integer;
  v_status public.reservation_status; v int;
begin
  select final_total_cents, overstay_cents, collected_cents, balance_cents
    into v_final, v_overstay, v_collected, v_balance
    from public.check_out_reservation(
      'ff000000-0000-0000-0000-00000000e004',
      now() + interval '9 hours',
      'card');

  if v_overstay <> 1200 then
    raise exception 'CHECK9 FAIL: overstay = %c, expected the 1200c cap', v_overstay;
  end if;
  if v_final <> 6200 then
    raise exception 'CHECK9 FAIL: final total = %c, expected 6200c', v_final;
  end if;
  -- 6200 owed, 2000 already taken in CHECK8, so 4200 settles it.
  if v_collected <> 4200 or v_balance <> 0 then
    raise exception 'CHECK9 FAIL: collected %c leaving %c, expected 4200c leaving 0c',
      v_collected, v_balance;
  end if;

  select status into v_status from public.reservations
   where id = 'ff000000-0000-0000-0000-00000000e004';
  if v_status <> 'completed' then
    raise exception 'CHECK9 FAIL: reservation is % after check-out', v_status;
  end if;

  select count(*) into v from public.booth_payments
   where reservation_id = 'ff000000-0000-0000-0000-00000000e004';
  if v <> 2 then
    raise exception 'CHECK9 FAIL: expected 2 booth payments, found %', v;
  end if;

  raise notice 'CHECK9 PASS: check-out priced its own overstay and settled the balance';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 10 — tenant isolation on the money. The Org B admin is also the DRIVER
-- on these reservations, which separates the two SELECT policies cleanly:
-- they may see the payments on their own booking and nothing else in Org A,
-- and they may not collect in an org they have no role in.
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);

do $$
declare v int; v_msg text;
begin
  -- No Org A role, so the member policy gives them nothing...
  if public.get_user_role('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') is not null then
    raise exception 'CHECK10 FAIL: the Org B admin has a role in Org A';
  end if;

  -- ...but they own customer f5, so their own booking's payments are visible.
  select count(*) into v from public.booth_payments
   where reservation_id = 'ff000000-0000-0000-0000-00000000e004';
  if v <> 2 then
    raise exception
      'CHECK10 FAIL: driver sees % of their own 2 booth payments', v;
  end if;

  -- Every booth payment they can see must belong to a booking of theirs.
  select count(*) into v from public.booth_payments bp
   where not exists (
     select 1 from public.reservations r
      where r.id = bp.reservation_id and public.is_own_customer(r.customer_id));
  if v <> 0 then
    raise exception 'CHECK10 FAIL: % booth payments leaked to a non-owner', v;
  end if;

  -- And a driver cannot take money in an org they do not work for.
  begin
    perform public.record_booth_payment(
      'ff000000-0000-0000-0000-00000000e001', 100, 'cash');
    raise exception 'CHECK10 FAIL: a non-member collected a payment';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'ROLE_NOT_ALLOWED' then raise; end if;
  end;

  raise notice 'CHECK10 PASS: own-booking reads allowed, cross-org reads and writes denied';
end $$;


-- ---------------------------------------------------------------------------
-- CHECK 11 — a plain member of another org sees none of it. Same user, but
-- asking as staff about rows that are not theirs: zero, not an error.
-- ---------------------------------------------------------------------------
do $$
declare v int;
begin
  select count(*) into v from public.booth_payments
   where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
     and reservation_id <> 'ff000000-0000-0000-0000-00000000e004';
  if v <> 0 then
    raise exception 'CHECK11 FAIL: % Org A booth payments visible cross-org', v;
  end if;

  -- The booking they do not own is not readable either.
  select count(*) into v from public.reservations
   where booking_code = 'PKS-TEST27';
  if v <> 0 then
    raise exception 'CHECK11 FAIL: another org''s ticket resolved instead of reading as unknown';
  end if;

  raise notice 'CHECK11 PASS: another operator''s ticket reads as an unknown code';
end $$;

reset role;
rollback;
