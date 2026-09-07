-- DEV-ONLY verification for public.facility_daily_manifest(uuid, date).
-- Runs inside a transaction that ends in ROLLBACK. It exercises the seeded
-- disposable database and temporarily archives one fixture row.
--
--   npm run verify:daily-manifest
--
-- Runs as the seeded Harbor Park admin (not postgres) for two reasons: the manifest
-- is SECURITY INVOKER, so postgres would bypass the RLS the function relies on
-- for tenant scoping; and reservation_balance_cents raises NOT_AUTHORIZED
-- without a membership, so the parity check could not run at all as postgres.
--
-- Every check returns one row: check_name / status / detail. A single UNION ALL
-- result set, because `supabase db query` surfaces one.

begin;

-- Fixed fixtures exercise all three manifest kinds. The cross-midnight row is
-- arriving on August 23 and departing on August 24; the first row is a
-- same-day turnaround. A third row is archived below for the soft-delete probe.
insert into public.reservations
  (id, org_id, facility_id, space_id, customer_id, during, status,
   booking_code, price_breakdown, total_cents)
select fixture.id,
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
       '11111111-1111-1111-1111-111111111111'::uuid,
       s.id,
       'ca000001-0000-0000-0000-000000000001'::uuid,
       fixture.during,
       'confirmed'::public.reservation_status,
       fixture.booking_code,
       jsonb_build_object('currency', 'USD', 'line_items', jsonb_build_array(),
                          'total_cents', fixture.total_cents),
       fixture.total_cents
  from (values
    ('ed000000-0000-0000-0000-0000000000d1'::uuid,
     'L1-013', tstzrange('2026-08-23 15:00:00+00', '2026-08-23 17:00:00+00', '[)'),
     'PKS-MANF01', 1000),
    ('ed000000-0000-0000-0000-0000000000d2'::uuid,
     'L1-014', tstzrange('2026-08-24 05:00:00+00', '2026-08-24 08:00:00+00', '[)'),
     'PKS-MANF02', 1200),
    ('ed000000-0000-0000-0000-0000000000d3'::uuid,
     'L1-015', tstzrange('2026-08-23 18:00:00+00', '2026-08-23 19:00:00+00', '[)'),
     'PKS-MANF03', 800)
  ) as fixture(id, space_number, during, booking_code, total_cents)
  join public.spaces s on s.space_number = fixture.space_number
  join public.zones z on z.id = s.zone_id
   and z.facility_id = '11111111-1111-1111-1111-111111111111';

insert into public.payments
  (id, org_id, reservation_id, stripe_checkout_session_id,
   amount_cents, status, created_at)
values
  ('ed000000-0000-0000-0000-0000000000a1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ed000000-0000-0000-0000-0000000000d1', 'cs_manifest_succeeded',
   400, 'succeeded', '2026-08-23 15:30:00+00'),
  ('ed000000-0000-0000-0000-0000000000a2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ed000000-0000-0000-0000-0000000000d1', 'cs_manifest_failed',
   500, 'failed', '2026-08-23 15:35:00+00');

insert into public.booth_payments
  (id, org_id, reservation_id, amount_cents, method, collected_by, created_at)
values
  ('ed000000-0000-0000-0000-0000000000b1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ed000000-0000-0000-0000-0000000000d1',
   300, 'cash', '00000000-0000-0000-0000-0000000000a1',
   '2026-08-23 15:40:00+00');

-- Archive the dedicated probe as postgres before the role switch. The
-- surrounding transaction rolls every fixture back.
create temporary table archived_probe on commit drop as
select r.id,
       r.facility_id,
       (lower(r.during) at time zone public.safe_timezone(f.timezone))::date
         as local_date
  from public.reservations r
  join public.facilities f on f.id = r.facility_id
 where r.id = 'ed000000-0000-0000-0000-0000000000d3';

update public.reservations
   set archived_at = now()
 where id in (select id from archived_probe);

-- The checks below run as `authenticated`, which has no rights on a temp table
-- created by postgres.
grant select on archived_probe to authenticated;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub',
  '00000000-0000-0000-0000-0000000000a1', true);

create temporary table verifier_daily_manifest_results on commit drop as
with
sol_facilities as (
  select f.id, public.safe_timezone(f.timezone) as tz
    from public.facilities f
   where f.org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
),
-- Every facility-local date that any non-archived reservation touches. This is
-- the full domain of the manifest, so the checks below are exhaustive over real
-- data rather than sampled.
dates as (
  select distinct f.id as facility_id, d.local_date
    from sol_facilities f
    join public.reservations r
      on r.facility_id = f.id and r.archived_at is null
    cross join lateral (
      select unnest(array[
        (lower(r.during) at time zone f.tz)::date,
        (upper(r.during) at time zone f.tz)::date
      ]) as local_date
    ) d
   where d.local_date is not null
),
manifest as (
  select dt.facility_id, dt.local_date, m.*
    from dates dt
    cross join lateral
      public.facility_daily_manifest(dt.facility_id, dt.local_date) m
),
-- Ground truth for money, derived from RAW payment rows with a deliberately
-- different formulation than the function's UNION ALL: two independent
-- correlated sums added together.
raw_paid as (
  select r.id as reservation_id,
         r.total_cents,
         coalesce((select sum(bp.amount_cents)
                     from public.booth_payments bp
                    where bp.reservation_id = r.id
                      and bp.org_id = r.org_id), 0)
       + coalesce((select sum(p.amount_cents)
                     from public.payments p
                    where p.reservation_id = r.id
                      and p.org_id = r.org_id
                      and p.status = 'succeeded'), 0) as paid
    from public.reservations r
),
-- Ground truth for membership and kind, hand-written from the raw predicate
-- rather than reusing the function.
expected as (
  select dt.facility_id,
         dt.local_date,
         r.id as reservation_id,
         case
           when (lower(r.during) at time zone f.tz)::date = dt.local_date
            and (upper(r.during) at time zone f.tz)::date = dt.local_date
             then 'turnaround'
           when (lower(r.during) at time zone f.tz)::date = dt.local_date
             then 'arriving'
           else 'departing'
         end as kind
    from dates dt
    join sol_facilities f on f.id = dt.facility_id
    join public.reservations r
      on r.facility_id = dt.facility_id
     and r.archived_at is null
   where (lower(r.during) at time zone f.tz)::date = dt.local_date
      or (upper(r.during) at time zone f.tz)::date = dt.local_date
)

-- CHECK 1 - balance parity against the canonical function, EVERY row.
select '1. balance == reservation_balance_cents (every row)' as check_name,
       case when count(*) = 0 then 'INCONCLUSIVE (no rows)'
            when count(*) filter (
                   where m.balance_cents
                         is distinct from public.reservation_balance_cents(m.reservation_id)
                 ) = 0 then 'PASS'
            else 'FAIL' end as status,
       count(*)::text || ' manifest rows compared, '
       || count(*) filter (
            where m.balance_cents
                  is distinct from public.reservation_balance_cents(m.reservation_id)
          )::text || ' mismatched' as detail
  from manifest m

union all

-- CHECK 2 - paid_cents against hand-computed raw payment rows.
select '2. paid_cents == raw booth+succeeded payments',
       case when count(*) = 0 then 'INCONCLUSIVE (no rows)'
            when count(*) filter (where m.paid_cents is distinct from rp.paid) = 0
              then 'PASS' else 'FAIL' end,
       count(*)::text || ' rows compared, '
       || count(*) filter (where m.paid_cents is distinct from rp.paid)::text
       || ' mismatched'
  from manifest m
  join raw_paid rp on rp.reservation_id = m.reservation_id

union all

-- CHECK 3 - balance_cents == greatest(total - paid, 0), hand-computed.
select '3. balance == greatest(total - paid, 0)',
       case when count(*) = 0 then 'INCONCLUSIVE (no rows)'
            when count(*) filter (
                   where m.balance_cents
                         is distinct from greatest(rp.total_cents - rp.paid, 0)
                 ) = 0 then 'PASS' else 'FAIL' end,
       count(*)::text || ' rows compared, '
       || count(*) filter (
            where m.balance_cents
                  is distinct from greatest(rp.total_cents - rp.paid, 0)
          )::text || ' mismatched'
  from manifest m
  join raw_paid rp on rp.reservation_id = m.reservation_id

union all

-- CHECK 4 - membership: manifest set == hand-written predicate set, both ways.
select '4. row set matches hand-written predicate',
       case when (select count(*) from expected) = 0 then 'INCONCLUSIVE (no rows)'
            when (select count(*) from (
                   select facility_id, local_date, reservation_id from manifest
                   except
                   select facility_id, local_date, reservation_id from expected) x) = 0
             and (select count(*) from (
                   select facility_id, local_date, reservation_id from expected
                   except
                   select facility_id, local_date, reservation_id from manifest) y) = 0
              then 'PASS' else 'FAIL' end,
       (select count(*) from expected)::text || ' expected, '
       || (select count(*) from manifest)::text || ' returned, '
       || (select count(*) from (
             select facility_id, local_date, reservation_id from manifest
             except
             select facility_id, local_date, reservation_id from expected) x)::text
       || ' extra, '
       || (select count(*) from (
             select facility_id, local_date, reservation_id from expected
             except
             select facility_id, local_date, reservation_id from manifest) y)::text
       || ' missing'

union all

-- CHECK 5 - kind matches hand-computed classification for every row.
select '5. kind matches hand-computed classification',
       case when count(*) = 0 then 'INCONCLUSIVE (no rows)'
            when count(*) filter (where m.kind is distinct from e.kind) = 0
              then 'PASS' else 'FAIL' end,
       count(*)::text || ' rows compared, '
       || count(*) filter (where m.kind is distinct from e.kind)::text || ' mismatched'
  from manifest m
  join expected e
    on e.facility_id = m.facility_id
   and e.local_date = m.local_date
   and e.reservation_id = m.reservation_id

union all

-- CHECK 6 - coverage: which kinds did the fixed fixtures actually exercise? A kind
-- with zero rows is UNTESTED, and this says so rather than implying otherwise.
select '6. kind coverage in fixed fixtures',
       case when count(distinct k.kind) = 3 then 'PASS (all three seen)'
            else 'PARTIAL - some kinds untested' end,
       coalesce(string_agg(k.kind || '=' || k.n::text, ', ' order by k.kind),
                'none')
  from (select kind, count(*) as n from manifest group by kind) k

union all

-- CHECK 7 - soft deletes excluded. The probe row archived at the top of this
-- transaction is provably eligible on its own start date except for
-- archived_at, so PASS means the filter (not some other predicate) removed it.
select '7. archived reservation excluded from its own date',
       case when (select count(*) from archived_probe) = 0
              then 'INCONCLUSIVE (no probe row could be chosen)'
            -- would have qualified: same predicate, archived_at ignored
            when (select count(*) from archived_probe ap
                    join public.reservations r on r.id = ap.id
                    join public.facilities f on f.id = r.facility_id
                   where (lower(r.during)
                          at time zone public.safe_timezone(f.timezone))::date
                         = ap.local_date) = 1
             and not exists (
                   select 1
                     from archived_probe ap
                     cross join lateral public.facility_daily_manifest(
                       ap.facility_id, ap.local_date) m
                    where m.reservation_id = ap.id)
              then 'PASS' else 'FAIL' end,
       'probe ' || coalesce((select id::text from archived_probe), 'none')
       || ' archived; appears on its own date '
       || (select count(*)
             from archived_probe ap
             cross join lateral public.facility_daily_manifest(
               ap.facility_id, ap.local_date) m
            where m.reservation_id = ap.id)::text || ' times (want 0)'

union all

-- CHECK 8 - tenant isolation. As the Harbor Park admin, a facility belonging to
-- another org must return zero rows via RLS, not an error and not data.
select '8. cross-tenant facility returns zero rows',
       case when (select count(*)
                    from public.facility_daily_manifest(
                           '33333333-3333-3333-3333-333333333333'::uuid,
                           '2026-08-23'::date)) = 0
              then 'PASS' else 'FAIL' end,
       'Pier Point Lot (org B) queried as Harbor Park admin; got '
       || (select count(*)
             from public.facility_daily_manifest(
                    '33333333-3333-3333-3333-333333333333'::uuid,
                    '2026-08-23'::date))::text || ' rows'

union all

-- CHECK 9 - default p_date resolves to the facility's local today.
select '9. default p_date == explicit facility-local today',
       case when (select count(*) from (
                   select * from public.facility_daily_manifest(
                     '11111111-1111-1111-1111-111111111111'::uuid)
                   except all
                   select * from public.facility_daily_manifest(
                     '11111111-1111-1111-1111-111111111111'::uuid,
                     (now() at time zone (select tz from sol_facilities
                                           where id = '11111111-1111-1111-1111-111111111111'))::date)
                 ) z) = 0 then 'PASS' else 'FAIL' end,
       'Lot A, default vs explicit local today'

order by 1;

reset role;

do $$
declare
  v_count integer;
  v_failures text;
begin
  select count(*),
         string_agg(check_name || ': ' || status, '; ' order by check_name)
           filter (where status not like 'PASS%')
    into v_count, v_failures
    from verifier_daily_manifest_results;

  if v_count <> 9 then
    raise exception 'Daily manifest verifier emitted % checks; expected 9', v_count;
  end if;
  if v_failures is not null then
    raise exception 'Daily manifest verifier failed: %', v_failures;
  end if;
end $$;

select * from verifier_daily_manifest_results order by check_name;

rollback;
