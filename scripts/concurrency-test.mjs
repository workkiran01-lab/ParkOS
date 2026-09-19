import crypto from 'node:crypto'

import { createClient } from '@supabase/supabase-js'

import { assertLoopbackHttpUrl } from './local-database.mjs'

const SUPABASE_URL = assertLoopbackHttpUrl(
  process.env.PARKOS_TEST_SUPABASE_URL ?? process.env.API_URL,
  'PARKOS_TEST_SUPABASE_URL or API_URL',
)

// This is the only test in CI that goes through PostgREST, so it is the only
// one subject to Data API grants; everything else connects via psql as the
// table owner. It used to run as service_role, which worked against hosted
// Supabase because a hosted project ships ALTER DEFAULT PRIVILEGES granting
// service_role every table. The local stack has no such default -- config.toml
// leaves auto_expose_new_tables unset -- so grants are exactly what the
// migrations issue, and service_role is deliberately narrow: it holds only the
// payment tables. spaces, price_rules and reservations go to `authenticated`
// alone (20260819040000:193, 20260819060000:343). Hence "permission denied for
// table spaces".
//
// Granting service_role the core tables would reverse that design, and would
// not even be enough: create_reservation is SECURITY INVOKER, so it would need
// reservations, space_holds and price_rules too. Authenticate as the seeded
// Harbor Park admin instead -- which is what a staff member booking through the
// app actually is. auth.uid() has to resolve, because every table this touches
// is gated by has_any_role/get_user_role in its RLS policies.
const JWT_SECRET = process.env.PARKOS_TEST_JWT_SECRET ?? process.env.JWT_SECRET
const ANON_KEY = process.env.PARKOS_TEST_ANON_KEY ?? process.env.ANON_KEY

const TEST_ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const TEST_FACILITY_ID = '11111111-1111-1111-1111-111111111111'
const TEST_ZONE_ID = 'a1a1a1a1-0000-0000-0000-000000000001'
const TEST_CUSTOMER_ID = 'ca000001-0000-0000-0000-000000000001'
// Harbor Park admin from DEV_ONLY_seed_dev_orgs.sql: admin in TEST_ORG_ID, so
// it satisfies price_rules_insert's has_any_role(org_id, {admin,manager}).
const TEST_ADMIN_ID = '00000000-0000-0000-0000-0000000000a1'
const TEST_SPACE_NUMBER = 'L1-013'
const TEST_START = '2030-01-15T18:00:00.000Z'
const TEST_END = '2030-01-15T20:00:00.000Z'

if (!JWT_SECRET || !ANON_KEY) {
  throw new Error(
    'PARKOS_TEST_JWT_SECRET/JWT_SECRET and PARKOS_TEST_ANON_KEY/ANON_KEY are required for the local concurrency test.',
  )
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

// Minimal HS256, rather than a dependency for one short-lived token. The local
// stack still accepts symmetric JWTs: presenting the legacy service_role key
// reached PostgREST and produced a grant error rather than an auth error, which
// is what proved the token was honoured and the role simply lacked the table.
function mintAccessToken(userId) {
  const issuedAt = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      iss: 'supabase',
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  )
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${signature}`
}

const supabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: {
    headers: { Authorization: `Bearer ${mintAccessToken(TEST_ADMIN_ID)}` },
  },
})

async function requireData(promise, label) {
  const { data, error } = await promise
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

async function main() {
  const space = await requireData(
    supabase
      .from('spaces')
      .select('id')
      .eq('zone_id', TEST_ZONE_ID)
      .eq('space_number', TEST_SPACE_NUMBER)
      .single(),
    'Resolve locally seeded test space',
  )

  await requireData(
    supabase.from('price_rules').insert({
      id: crypto.randomUUID(),
      org_id: TEST_ORG_ID,
      facility_id: TEST_FACILITY_ID,
      zone_id: TEST_ZONE_ID,
      space_type: null,
      hourly_rate_cents: 500,
      daily_cap_cents: 3000,
      currency: 'USD',
      priority: 1000,
      archived_at: null,
    }),
    'Create local-only test price rule',
  )

  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      supabase.rpc('create_reservation', {
        p_space_id: space.id,
        p_customer_id: TEST_CUSTOMER_ID,
        p_vehicle_id: null,
        p_start: TEST_START,
        p_end: TEST_END,
      }),
    ),
  )

  let successes = 0
  let unavailable = 0
  const other = []

  for (const result of results) {
    if (!result.error) {
      successes += 1
    } else if (result.error.message.includes('SPACE_UNAVAILABLE')) {
      unavailable += 1
    } else {
      other.push(result.error)
    }
  }

  console.log(`successes: ${successes}`)
  console.log(`SPACE_UNAVAILABLE: ${unavailable}`)
  console.log(`other: ${other.length}`)

  if (other.length > 0) {
    console.error('Unexpected errors:')
    for (const error of other) {
      console.error(`- ${error.code ?? 'NO_CODE'}: ${error.message}`)
    }
  }

  if (successes !== 1 || unavailable !== 49 || other.length !== 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
