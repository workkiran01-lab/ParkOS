// Concurrent-correction audit test.
//
// correct_reservation updates the SHARED customers/vehicles rows, so two staff
// correcting DIFFERENT reservations that reference the same customer both write
// that one row. Each correction records a before/after audit row. The invariant
// this asserts is that those before-images form a chain: exactly one correction
// may claim the original value, and the other must claim the first one's result.
//
// This needs two overlapping database sessions, so it cannot live in the
// single-session psql verifier harness. A third session holds a lock on the
// shared customer row so both corrections are in flight before either can write,
// which makes the interleaving deterministic instead of hoping for a race.
//
// Run through the loopback-guarded npm command:
//   npm run test:correction-race

import { spawn, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertLoopbackDatabaseUrl } from './local-database.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const databaseUrl = assertLoopbackDatabaseUrl(
  process.env.PARKOS_TEST_DATABASE_URL,
)

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const FACILITY_A = '11111111-1111-1111-1111-111111111111' // 24_hours, so the
const ADMIN_A = '00000000-0000-0000-0000-0000000000a1' // operating-hours trigger
const SENTINEL = '__RACE_CUSTOMER__' // never rejects these windows.
const PLATE = 'RACE1' // stable across the test; the customer NAME is not.

function psql(sql, { capture = true } = {}) {
  const result = spawnSync(
    'psql',
    [
      '--variable=ON_ERROR_STOP=1',
      '--no-psqlrc',
      '-tA',
      '-c',
      sql,
      databaseUrl,
    ],
    { cwd: projectRoot, encoding: 'utf8' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout}`)
  }
  return capture ? result.stdout.trim() : ''
}

function psqlAsync(sql) {
  const child = spawn(
    'psql',
    [
      '--variable=ON_ERROR_STOP=1',
      '--no-psqlrc',
      '-tA',
      '-c',
      sql,
      databaseUrl,
    ],
    { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  return new Promise((resolvePromise) => {
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

/** A correction run as staff, inside one transaction so its locks are held. */
function correctionSql(reservationId, newName) {
  return `
begin;
select set_config('request.jwt.claims',
                  '{"sub":"${ADMIN_A}","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '${ADMIN_A}', true);
set local role authenticated;
select 1 from public.correct_reservation(
  '${reservationId}'::uuid,
  (select r.space_id from public.reservations r where r.id = '${reservationId}'),
  (select lower(r.during) from public.reservations r where r.id = '${reservationId}'),
  (select upper(r.during) from public.reservations r where r.id = '${reservationId}'),
  '${newName}', 'race@example.com', '562-555-0100', 'RACE1',
  'concurrent correction test'
);
commit;`
}

// Keyed on the vehicle plate and price-rule priority, NOT the customer name:
// the whole point of this test is that it rewrites that name, so keying cleanup
// on it leaves fixtures behind that then collide with the next run.
function cleanup() {
  psql(
    `
with victims as (
  select distinct v.customer_id
    from public.vehicles v
   where v.license_plate = '${PLATE}' and v.org_id = '${ORG_A}'
)
delete from public.audit_log a
 where a.target_id in (
   select r.id from public.reservations r
    where r.customer_id in (select customer_id from victims));

delete from public.space_holds h
 where h.reservation_id in (
   select r.id from public.reservations r
    where r.customer_id in (
      select distinct v.customer_id from public.vehicles v
       where v.license_plate = '${PLATE}' and v.org_id = '${ORG_A}'));

delete from public.reservations r
 where r.customer_id in (
   select distinct v.customer_id from public.vehicles v
    where v.license_plate = '${PLATE}' and v.org_id = '${ORG_A}');

delete from public.vehicles v
 where v.license_plate = '${PLATE}' and v.org_id = '${ORG_A}';

delete from public.price_rules where priority = 990001;

delete from public.customers c
 where c.org_id = '${ORG_A}'
   and c.email in ('before@example.com', 'race@example.com');`,
    { capture: false },
  )
}

function setup() {
  const out = psql(`
do $$
declare
  v_customer uuid;
  v_vehicle uuid;
  v_space_1 uuid;
  v_space_2 uuid;
  v_start timestamptz := date_trunc('hour', now()) + interval '400 days';
begin
  insert into public.customers (org_id, full_name, email, phone)
  values ('${ORG_A}', '${SENTINEL}', 'before@example.com', '562-555-0100')
  returning id into v_customer;

  insert into public.vehicles (org_id, customer_id, license_plate)
  values ('${ORG_A}', v_customer, 'RACE1') returning id into v_vehicle;

  select s.id into v_space_1 from public.spaces s
    join public.zones z on z.id = s.zone_id
   where z.facility_id = '${FACILITY_A}' and s.archived_at is null
   order by s.id limit 1;
  select s.id into v_space_2 from public.spaces s
    join public.zones z on z.id = s.zone_id
   where z.facility_id = '${FACILITY_A}' and s.archived_at is null
     and s.id <> v_space_1
   order by s.id limit 1;

  insert into public.price_rules (
    org_id, facility_id, hourly_rate_cents, currency, priority
  ) values ('${ORG_A}', '${FACILITY_A}', 500, 'USD', 990001);

  perform set_config('request.jwt.claims',
    '{"sub":"${ADMIN_A}","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '${ADMIN_A}', true);
  set local role authenticated;

  perform public.create_reservation(
    v_space_1, v_customer, v_vehicle, v_start, v_start + interval '2 hours');
  perform public.create_reservation(
    v_space_2, v_customer, v_vehicle,
    v_start + interval '5 hours', v_start + interval '7 hours');
end $$;

select c.id, string_agg(r.id::text, ',' order by r.id)
  from public.customers c join public.reservations r on r.customer_id = c.id
 where c.full_name = '${SENTINEL}'
 group by c.id;`)

  // psql echoes the DO command tag before the SELECT result, so take the last
  // non-empty line rather than the whole output.
  const lastLine = out.split('\n').filter(Boolean).pop() ?? ''
  const [customerId, reservationIds = ''] = lastLine.split('|')
  const [reservationA, reservationB] = reservationIds.split(',')
  if (!customerId || !reservationA || !reservationB) {
    throw new Error(`Fixture setup did not produce two reservations: ${out}`)
  }
  return { customerId, reservationA, reservationB }
}

/**
 * Both corrections must be in flight before either writes. A holder session
 * locks the shared customer row, both corrections start and block on it, then
 * the holder commits and they proceed one after the other.
 */
async function runOverlappingCorrections(
  customerId,
  reservationA,
  reservationB,
) {
  const holder = psqlAsync(`
begin;
select 1 from public.customers where id = '${customerId}' for update;
select pg_sleep(6);
commit;`)

  // Do not start the corrections until the holder demonstrably owns the row
  // lock. Without this gate a holder that failed silently would let both
  // corrections run unimpeded and the test would "pass" having proven nothing.
  let holderReady = false
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((r) => setTimeout(r, 100))
    const held = Number(
      psql(`
select count(*) from pg_stat_activity
 where wait_event = 'PgSleep' and query ilike '%for update%'`),
    )
    if (held > 0) {
      holderReady = true
      break
    }
  }
  if (!holderReady) {
    const result = await holder
    throw new Error(
      `Lock holder never acquired the customer row lock (exit=${result.code}): ` +
        `${result.stderr.trim() || '<no stderr>'}`,
    )
  }

  const corrections = Promise.all([
    psqlAsync(correctionSql(reservationA, 'A-NAME')),
    psqlAsync(correctionSql(reservationB, 'B-NAME')),
  ])

  // Poll rather than sample once: the assertion below is only meaningful if both
  // corrections were genuinely in flight at the same time.
  let peakBlocked = 0
  for (let attempt = 0; attempt < 40; attempt++) {
    const blocked = Number(
      psql(`
select count(*) from pg_stat_activity
 where wait_event_type = 'Lock' and state = 'active'
   and query ilike '%correct_reservation%'`),
    )
    peakBlocked = Math.max(peakBlocked, blocked)
    if (peakBlocked >= 2) break
    await new Promise((r) => setTimeout(r, 100))
  }
  if (peakBlocked < 2) {
    const results = await corrections
    const detail = results
      .map(
        (r, i) =>
          `correction ${i + 1}: exit=${r.code} stderr=${r.stderr.trim() || '<none>'}`,
      )
      .join(' | ')
    throw new Error(
      `Only ${peakBlocked} correction(s) were ever blocked on the shared ` +
        'customer row; the two corrections did not overlap, so this run ' +
        `proves nothing. ${detail}`,
    )
  }

  const [holderResult, correctionResults] = await Promise.all([
    holder,
    corrections,
  ])
  if (holderResult.code !== 0) {
    throw new Error(`Lock holder failed: ${holderResult.stderr}`)
  }
  for (const [index, result] of correctionResults.entries()) {
    if (result.code !== 0) {
      throw new Error(`Correction ${index + 1} failed: ${result.stderr}`)
    }
  }
  console.log(
    `Both corrections overlapped (${peakBlocked} sessions simultaneously ` +
      `blocked on the shared customer row).`,
  )
}

function assertAuditChain(customerId) {
  const rows = psql(`
select a.reason::jsonb #>> '{before,customer,full_name}',
       a.reason::jsonb #>> '{after,customer,full_name}'
  from public.audit_log a
 where a.action = 'correct_reservation'
   and a.target_id in (
     select r.id from public.reservations r where r.customer_id = '${customerId}')
 order by a.id;`)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // psql on a CRLF host leaves a trailing carriage return on each field.
      const [before, after] = line.split('\r').join('').split('|')
      return { before, after }
    })

  if (rows.length !== 2) {
    throw new Error(`Expected 2 correction audit rows, found ${rows.length}.`)
  }

  const finalName = psql(
    `select full_name from public.customers where id = '${customerId}'`,
  )

  const first = rows.find((row) => row.before === SENTINEL)
  const second = rows.find((row) => row !== first)

  if (!first) {
    throw new Error(
      `AUDIT CHAIN BROKEN: no correction recorded the original value ` +
        `"${SENTINEL}" as its before-image. Rows: ${JSON.stringify(rows)}`,
    )
  }
  if (second.before === SENTINEL) {
    throw new Error(
      `AUDIT CHAIN BROKEN: both corrections recorded before="${SENTINEL}". ` +
        `The second overwrote "${first.after}" but its audit row claims the ` +
        `value it replaced was the original. Rows: ${JSON.stringify(rows)}`,
    )
  }
  if (second.before !== first.after) {
    throw new Error(
      `AUDIT CHAIN BROKEN: second correction recorded before=` +
        `"${second.before}" but the value it actually replaced was ` +
        `"${first.after}". Rows: ${JSON.stringify(rows)}`,
    )
  }
  if (finalName !== second.after) {
    throw new Error(
      `Final customer name "${finalName}" is not the last correction's ` +
        `after-image "${second.after}".`,
    )
  }

  console.log(
    `Audit chain intact: "${first.before}" -> "${first.after}" -> ` +
      `"${second.after}", final row "${finalName}".`,
  )
}

async function main() {
  console.log(
    'Loopback database target confirmed; running correction race test.',
  )
  cleanup()
  const { customerId, reservationA, reservationB } = setup()
  try {
    await runOverlappingCorrections(customerId, reservationA, reservationB)
    assertAuditChain(customerId)
  } finally {
    cleanup()
  }
  console.log('Correction audit race test passed.')
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
