import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertLoopbackDatabaseUrl } from './local-database.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const url = assertLoopbackDatabaseUrl(process.env.PARKOS_TEST_DATABASE_URL)
const invoiceVerifier =
  'supabase/dev-only/20260903000000_verify_invoice_paid.sql'
const cases = [
  {
    name: 'Subscription processor accepts a misrouted invoice',
    function: 'process_stripe_subscription_event',
    pattern:
      /  if p_event_type is null or p_event_type not in \([\s\S]*?message = 'STRIPE_EVENT_TYPE_UNSUPPORTED';\n  end if;/,
    replacement: '',
    verifier: invoiceVerifier,
    witness: 'ROUTING FAIL: subscription processor accepted invoice.paid',
  },
  {
    name: 'Reservation processor accepts a misrouted invoice',
    function: 'process_stripe_event',
    pattern:
      /  if p_event_type is null or p_event_type not in \([\s\S]*?message = 'STRIPE_EVENT_TYPE_UNSUPPORTED';\n  end if;/,
    replacement: '',
    verifier: invoiceVerifier,
    witness: 'PAYMENT_IDENTIFIER_REQUIRED',
  },
  {
    name: 'Permit recorder loses event-ID deduplication',
    function: 'record_permit_payment',
    pattern: /\nbegin\n/,
    replacement:
      '\nbegin\n  p_event_id := p_event_id || gen_random_uuid()::text;\n',
    verifier: invoiceVerifier,
    witness: 'DEDUP FAIL: replay returned',
  },
]

function psql(sql, scalar = false) {
  const result = spawnSync(
    'psql',
    ['--no-psqlrc', '--set=ON_ERROR_STOP=1', ...(scalar ? ['-At'] : []), url],
    {
      cwd: root,
      input: sql,
      encoding: 'utf8',
    },
  )
  assert.ifError(result.error)
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    stdout: result.stdout,
  }
}

for (const mutation of cases) {
  const definition = psql(
    `select pg_get_functiondef(oid) from pg_proc where pronamespace = 'public'::regnamespace and proname = '${mutation.function}';`,
    true,
  )
  assert.equal(definition.status, 0, definition.output)
  const original = definition.stdout.replaceAll('\r', '')
  assert.match(
    original,
    mutation.pattern,
    `${mutation.name}: missing mutation anchor`,
  )
  const changed = original.replace(mutation.pattern, mutation.replacement)
  const verifier = readFileSync(
    new URL('../' + mutation.verifier, import.meta.url),
    'utf8',
  )
  assert.match(verifier, /\bbegin;/i)
  assert.match(verifier, /\brollback;/i)
  // Mutation and fixtures share one transaction. Even an assertion failure
  // rolls back the replacement function when psql disconnects.
  const broken = psql(
    verifier.replace(/\bbegin;/i, () => 'begin;\n' + changed + ';\n'),
  )
  console.log(`MUTATION: ${mutation.name}\n${broken.output}`)
  assert.notEqual(broken.status, 0, `${mutation.name}: mutant survived`)
  assert.ok(
    broken.output.includes(mutation.witness),
    `${mutation.name}: wrong failure`,
  )
  const restored = psql(verifier)
  console.log(`RESTORED: ${mutation.name}\n${restored.output}`)
  assert.equal(restored.status, 0, `${mutation.name}: restored verifier failed`)
}
