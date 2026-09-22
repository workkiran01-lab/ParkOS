import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const handler = 'supabase/functions/stripe-webhook/handler.ts'
const tests = [
  'supabase/functions/stripe-webhook/route.test.ts',
  'supabase/functions/stripe-webhook/handler.test.ts',
]
const mutations = [
  [
    'Basil paid property regression',
    'supabase/functions/_shared/stripe-payload.ts',
    "return invoice.paid === true || invoice.status === 'paid'",
    'return invoice.paid === true',
    'Basil paid invoice events',
  ],
  [
    'Invoice routed to state processor',
    'supabase/functions/stripe-webhook/route.ts',
    "case 'invoice.paid':",
    "case 'invoice.paid': return 'subscription'",
    'explicit destination',
  ],
  [
    'Invalid RPC result acknowledged',
    handler,
    "throw new Error('Stripe processing did not return a valid result.')",
    "return { processed: true, outcome: 'applied' }",
    'empty, malformed and ignored RPC results',
  ],
  [
    'Configuration failure reported as bad signature',
    handler,
    'if (error instanceof ConfigurationError) throw error',
    'void error',
    'configuration and database failures',
  ],
  [
    'Missing subscription items dereferenced',
    handler,
    'const items = object(payload.items)?.data',
    'const items = (payload.items as Row).data',
    'malformed supported payloads',
  ],
  [
    'Out-of-range timestamp throws',
    handler,
    'return Number.isNaN(date.getTime()) ? null : date.toISOString()',
    'return date.toISOString()',
    'malformed supported payloads',
  ],
]

function run() {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...tests],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  assert.ifError(result.error)
  return { status: result.status, output: result.stdout + result.stderr }
}

for (const [name, file, before, after, witness] of mutations) {
  const path = resolve(root, file)
  const original = readFileSync(path, 'utf8')
  assert.equal(
    original.split(before).length,
    2,
    `${name}: mutation anchor must be unique`,
  )
  let broken
  try {
    writeFileSync(path, original.replace(before, after))
    broken = run()
    console.log(`MUTATION: ${name}\n${broken.output}`)
    assert.notEqual(broken.status, 0, `${name}: mutant survived`)
    assert.match(
      broken.output,
      new RegExp(`not ok .*${witness}`),
      `${name}: expected assertion did not fail`,
    )
    assert.match(
      broken.output,
      /ERR_ASSERTION/,
      `${name}: infrastructure failure is not evidence`,
    )
  } finally {
    writeFileSync(path, original)
  }
  const restored = run()
  console.log(`RESTORED: ${name}\n${restored.output}`)
  assert.equal(restored.status, 0, `${name}: restored tests failed`)
}
