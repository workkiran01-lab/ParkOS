import crypto from 'node:crypto'

import { createClient } from '@supabase/supabase-js'

import { assertLoopbackHttpUrl } from './local-database.mjs'

const SUPABASE_URL = assertLoopbackHttpUrl(
  process.env.PARKOS_TEST_SUPABASE_URL ?? process.env.API_URL,
  'PARKOS_TEST_SUPABASE_URL or API_URL',
)
const SERVICE_ROLE_KEY =
  process.env.PARKOS_TEST_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY

const TEST_ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const TEST_FACILITY_ID = '11111111-1111-1111-1111-111111111111'
const TEST_ZONE_ID = 'a1a1a1a1-0000-0000-0000-000000000001'
const TEST_CUSTOMER_ID = 'ca000001-0000-0000-0000-000000000001'
const TEST_SPACE_NUMBER = 'L1-013'
const TEST_START = '2030-01-15T18:00:00.000Z'
const TEST_END = '2030-01-15T20:00:00.000Z'

if (!SERVICE_ROLE_KEY) {
  throw new Error(
    'PARKOS_TEST_SERVICE_ROLE_KEY or SERVICE_ROLE_KEY is required for the local concurrency test.',
  )
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
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
