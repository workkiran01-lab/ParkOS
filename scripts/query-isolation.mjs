import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { employeeCases, employeeFixtures } from './employee-isolation.mjs'
import {
  assertLoopbackDatabaseUrl,
  assertLoopbackHttpUrl,
} from './local-database.mjs'
import {
  loadCalendarFacility,
  loadCalendarReservations,
} from '../src/lib/reservation-queries.ts'
import {
  loadCustomers,
  loadCustomer,
  loadCustomerVehicles,
  loadCustomerBookings,
  loadCustomerPayments,
} from '../src/lib/customer-queries.ts'

const database = assertLoopbackDatabaseUrl(process.env.PARKOS_TEST_DATABASE_URL)
const api = assertLoopbackHttpUrl(
  process.env.PARKOS_TEST_SUPABASE_URL ?? process.env.API_URL,
)
const secret = process.env.PARKOS_TEST_JWT_SECRET ?? process.env.JWT_SECRET
const key = process.env.PARKOS_TEST_ANON_KEY ?? process.env.ANON_KEY
if (!secret || !key)
  throw new Error('Local JWT secret and anon key are required.')
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const facilityA = '11111111-1111-1111-1111-111111111111'
const facilityB = '33333333-3333-3333-3333-333333333333'
const customerB = 'de000000-0000-0000-0000-000000000001'
const customerA = 'ca000001-0000-0000-0000-000000000001'
const ownCustomerB = 'de000000-0000-0000-0000-000000000002'
const vehicleA = 'de000000-0000-0000-0000-000000000003'
const vehicleB = 'de000000-0000-0000-0000-000000000004'
const reservationA = 'de000000-0000-0000-0000-000000000011'
const reservationB = 'de000000-0000-0000-0000-000000000012'
const start = '2031-01-01T00:00:00Z'
const end = '2031-02-01T00:00:00Z'

function clientFor(userId) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      iat: Math.floor(Date.now() / 1000) - 5,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url')
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return createClient(api, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${header}.${payload}.${signature}` },
    },
  })
}
const adminA = clientFor('00000000-0000-0000-0000-0000000000a1')
const adminB = clientFor('00000000-0000-0000-0000-0000000000b1')

function sql(statement) {
  const result = spawnSync(
    'psql',
    ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', statement, database],
    { encoding: 'utf8' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

const cases = {
  ...employeeCases({ sql, adminA, adminB, clientFor, orgA, orgB }),
  'customer list': {
    tables: ['customers'],
    async check() {
      assert.ok(
        (await loadCustomers(adminA, orgA)).some((row) => row.id === customerA),
        'own customer must exist',
      )
      assert.ok(
        (await loadCustomers(adminB, orgB)).some((row) => row.id === customerB),
        'foreign fixture must exist',
      )
      assert.ok(
        !(await loadCustomers(adminA, orgB)).some(
          (row) => row.id === customerB,
        ),
        'foreign customer list leaked',
      )
    },
  },
  'customer detail': {
    tables: ['customers'],
    async check() {
      assert.equal((await loadCustomer(adminA, orgA, customerA))?.id, customerA)
      assert.equal((await loadCustomer(adminB, orgB, customerB))?.id, customerB)
      assert.equal(
        await loadCustomer(adminA, orgB, customerB),
        null,
        'foreign customer detail leaked',
      )
      assert.equal(await loadCustomer(adminA, orgA, customerB), null)
    },
  },
  'customer organization filter': {
    source: new URL('../src/lib/customer-queries.ts', import.meta.url),
    async check() {
      const { data, error } = await adminA
        .from('customers')
        .select('id')
        .eq('id', ownCustomerB)
        .single()
      assert.equal(error, null)
      assert.equal(
        data.id,
        ownCustomerB,
        'self policy positive control must expose own customer in another org',
      )
      assert.ok(
        !(await loadCustomers(adminA, orgA)).some(
          (row) => row.id === ownCustomerB,
        ),
        'own customer in foreign organization leaked into directory',
      )
    },
  },
  ...Object.fromEntries(
    [false, true].map((detail) => [
      detail ? 'customer vehicles detail' : 'customer vehicles list',
      {
        tables: ['vehicles'],
        async check() {
          assert.ok(
            (
              await loadCustomerVehicles(
                adminA,
                orgA,
                detail ? customerA : undefined,
              )
            ).some((row) => row.id === vehicleA),
          )
          assert.ok(
            (
              await loadCustomerVehicles(
                adminB,
                orgB,
                detail ? customerB : undefined,
              )
            ).some((row) => row.id === vehicleB),
          )
          assert.ok(
            !(
              await loadCustomerVehicles(
                adminA,
                orgB,
                detail ? customerB : undefined,
              )
            ).some((row) => row.id === vehicleB),
            'foreign customer vehicles leaked',
          )
        },
      },
    ]),
  ),
  'customer books': {
    tables: ['reservations'],
    async check() {
      assert.ok(
        (await loadCustomerBookings(adminA, orgA, customerA)).some(
          (row) => row.id === reservationA,
        ),
      )
      assert.ok(
        (await loadCustomerBookings(adminB, orgB, customerB)).some(
          (row) => row.id === reservationB,
        ),
      )
      assert.deepEqual(
        await loadCustomerBookings(adminA, orgB, customerB),
        [],
        'foreign customer books leaked',
      )
      assert.deepEqual(await loadCustomerBookings(adminA, orgA, customerB), [])
    },
  },
  ...Object.fromEntries(
    ['payments', 'booth_payments'].map((table) => [
      `customer ${table}`,
      {
        tables: [table],
        async check() {
          assert.equal(
            (await loadCustomerPayments(adminA, orgA, [reservationA], table))
              .length,
            1,
          )
          assert.equal(
            (await loadCustomerPayments(adminB, orgB, [reservationB], table))
              .length,
            1,
          )
          assert.deepEqual(
            await loadCustomerPayments(adminA, orgB, [reservationB], table),
            [],
            `foreign customer ${table} leaked`,
          )
        },
      },
    ]),
  ),
  'calendar facility': {
    tables: ['facilities'],
    async check() {
      assert.equal(
        (await loadCalendarFacility(adminA, orgA, facilityA))?.id,
        facilityA,
        'positive control must find own facility',
      )
      assert.equal(
        (await loadCalendarFacility(adminB, orgB, facilityB))?.id,
        facilityB,
        'foreign fixture must exist',
      )
      assert.equal(
        await loadCalendarFacility(adminA, orgB, facilityB),
        null,
        'foreign facility leaked through actual calendar query',
      )
    },
  },
  'calendar reservations': {
    tables: ['reservations'],
    async check() {
      assert.ok(
        (
          await loadCalendarReservations(adminA, orgA, facilityA, start, end)
        ).some((row) => row.id === reservationA),
        'positive control must include own booking',
      )
      assert.ok(
        (
          await loadCalendarReservations(adminB, orgB, facilityB, start, end)
        ).some((row) => row.id === reservationB),
        'foreign booking fixture must exist',
      )
      assert.deepEqual(
        await loadCalendarReservations(adminA, orgB, facilityB, start, end),
        [],
        'foreign bookings leaked through actual calendar query',
      )
      assert.deepEqual(
        await loadCalendarReservations(adminA, orgA, facilityB, start, end),
        [],
        'tampered facility must not cross the organization scope',
      )
    },
  },
}

function child(name) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--case', name],
    { encoding: 'utf8', env: process.env },
  )
}

if (process.argv[2] === '--case') {
  try {
    await cases[process.argv[3]].check()
    console.log(`PASS: ${process.argv[3]}`)
  } catch (error) {
    console.error(`FAIL: ${process.argv[3]}: ${error.message}`)
    process.exitCode = 1
  }
} else {
  try {
    employeeFixtures(sql, orgA, orgB)
    sql(`
      insert into public.customers(id, org_id, full_name, email, phone) values ('${customerB}', '${orgB}', 'Foreign isolation sentinel', 'foreign-sentinel@example.test', '555-777-0001');
      insert into public.customers(id, org_id, full_name, user_id) values ('${ownCustomerB}', '${orgB}', 'Own foreign sentinel', '00000000-0000-0000-0000-0000000000a1');
      insert into public.vehicles(id,org_id,customer_id,license_plate) values ('${vehicleA}','${orgA}','${customerA}','QUERY-A'), ('${vehicleB}','${orgB}','${customerB}','QUERY-B');
      insert into public.reservations(id, org_id, facility_id, space_id, customer_id, during, status, price_breakdown, total_cents)
      select '${reservationA}', '${orgA}', '${facilityA}', s.id, 'ca000001-0000-0000-0000-000000000001', '[2031-01-10 18:00:00+00,2031-01-10 20:00:00+00)', 'confirmed', '{}', 1000 from public.spaces s join public.zones z on z.id=s.zone_id where z.facility_id='${facilityA}' limit 1;
      insert into public.reservations(id, org_id, facility_id, space_id, customer_id, during, status, price_breakdown, total_cents)
      select '${reservationB}', '${orgB}', '${facilityB}', s.id, '${customerB}', '[2031-01-10 18:00:00+00,2031-01-10 20:00:00+00)', 'confirmed', '{}', 1000 from public.spaces s join public.zones z on z.id=s.zone_id where z.facility_id='${facilityB}' limit 1;
      insert into public.payments(org_id,reservation_id,stripe_checkout_session_id,amount_cents,status) values ('${orgA}','${reservationA}','query-isolation-a',300,'succeeded'), ('${orgB}','${reservationB}','query-isolation-b',300,'succeeded');
      insert into public.booth_payments(org_id,reservation_id,amount_cents,method,collected_by) values ('${orgA}','${reservationA}',200,'cash','00000000-0000-0000-0000-0000000000a1'), ('${orgB}','${reservationB}',200,'cash','00000000-0000-0000-0000-0000000000b1');
    `)
    for (const [name, entry] of Object.entries(cases)) {
      let result = child(name)
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      assert.equal(result.status, 0, `${name}: baseline must pass`)
      if (process.argv.includes('--prove')) {
        const source = entry.source ? readFileSync(entry.source, 'utf8') : null
        try {
          if (entry.source) {
            const mutant = source.replaceAll(".eq('org_id', orgId)", '')
            assert.notEqual(
              mutant,
              source,
              'source mutation must change the query',
            )
            writeFileSync(entry.source, mutant)
          } else
            sql(
              entry.tables
                .map(
                  (table) =>
                    `alter table public.${table} disable row level security;`,
                )
                .join('\n'),
            )
          result = child(name)
          process.stdout.write(result.stdout)
          process.stderr.write(result.stderr)
          assert.equal(
            result.status,
            1,
            `${name}: mutation must make the real assertion fail`,
          )
          assert.match(
            result.stderr,
            /leaked|unauthorized/,
            `${name}: must fail for the intended tenant leak`,
          )
          console.log(`MUTATION DETECTED: ${name}; child exit 1`)
        } finally {
          if (entry.source) writeFileSync(entry.source, source)
          else
            sql(
              entry.tables
                .map(
                  (table) =>
                    `alter table public.${table} enable row level security;`,
                )
                .join('\n'),
            )
        }
        result = child(name)
        process.stdout.write(result.stdout)
        process.stderr.write(result.stderr)
        assert.equal(result.status, 0, `${name}: restored RLS must pass`)
        console.log(`RESTORED GREEN: ${name}; child exit 0`)
      }
    }
  } finally {
    employeeFixtures(sql, orgA, orgB, true)
    sql(
      `delete from public.payments where reservation_id in ('${reservationA}', '${reservationB}'); delete from public.booth_payments where reservation_id in ('${reservationA}', '${reservationB}'); delete from public.reservations where id in ('${reservationA}', '${reservationB}'); delete from public.vehicles where id in ('${vehicleA}', '${vehicleB}'); delete from public.customers where id in ('${customerB}', '${ownCustomerB}');`,
    )
  }
}
