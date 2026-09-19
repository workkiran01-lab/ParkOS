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
  ...['CHECK1', 'CHECK2', 'CHECK3', 'CHECK4'].map((check) => ({
    name: `Overstay ${check} rejects empty pricing`,
    function: 'calculate_overstay',
    emptyFunction: true,
    isolateCheck: check,
    verifier: 'supabase/dev-only/20260825010000_verify_booth_payments.sql',
    witness: `${check} FAIL:`,
  })),
  {
    name: 'Manifest leaks another tenant through definer privileges',
    function: 'facility_daily_manifest',
    pattern: /LANGUAGE sql/,
    replacement: 'LANGUAGE sql SECURITY DEFINER',
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '8. cross-tenant facility returns zero rows: FAIL',
  },
  {
    name: 'Manifest counts refunded booth money',
    function: 'facility_daily_manifest',
    pattern: /and bp\.status = 'succeeded'/,
    replacement: '',
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '2. paid_cents == raw booth+succeeded payments: FAIL',
  },
  {
    name: 'Manifest duplicates otherwise correct rows',
    function: 'facility_daily_manifest',
    pattern: /from target t/,
    replacement:
      "from target t cross join generate_series(1, case when t.facility_id = '11111111-1111-1111-1111-111111111111' then 2 else 1 end) duplicate_rows",
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '4. row set matches hand-written predicate: FAIL',
  },
  ...[
    ['facility_dashboard_summary', 'CHECK2'],
    ['report_revenue_by_period', 'CHECK3'],
    ['report_revenue_by_space_type', 'CHECK4'],
    ['report_revenue_split', 'CHECK4'],
    ['facility_dashboard_summary', 'CHECK5'],
  ].map(([fn, check]) => ({
    name: `Booth revenue ${check} rejects empty ${fn}`,
    function: fn,
    emptyFunction: true,
    isolateCheck: check,
    verifier:
      'supabase/dev-only/20260826000000_verify_booth_revenue_reporting.sql',
    witness: `${check} FAIL:`,
  })),
  {
    name: 'Manifest defaults to UTC today',
    function: 'facility_daily_manifest',
    pattern: /now\(\) at time zone public\.safe_timezone\(f\.timezone\)/,
    replacement: "now() at time zone 'UTC'",
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '9. default p_date uses local today across UTC midnight: FAIL',
  },
  {
    name: 'Default manifest silently returns no rows',
    function: 'facility_daily_manifest',
    pattern: /where f\.id = p_facility_id/,
    replacement: 'where f.id = p_facility_id and p_date is not null',
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '9. default p_date uses local today across UTC midnight: FAIL',
  },
  {
    name: 'Default manifest includes an extra day',
    function: 'facility_daily_manifest',
    pattern: /and \(\s*\(lower\(r\.during\)/,
    replacement: 'and (p_date is null or (lower(r.during)',
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '9. default p_date uses local today across UTC midnight: FAIL',
  },
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

const selected = cases.filter(
  (mutation) => !process.argv[2] || mutation.name.includes(process.argv[2]),
)
assert.ok(selected.length, 'No matching SQL mutations')
for (const mutation of selected) {
  const definition = psql(
    `select pg_get_functiondef(oid) from pg_proc where pronamespace = 'public'::regnamespace and proname = '${mutation.function}';`,
    true,
  )
  assert.equal(definition.status, 0, definition.output)
  const original = definition.stdout.replaceAll('\r', '')
  let changed
  if (mutation.emptyFunction) {
    assert.match(original, /LANGUAGE (sql|plpgsql)/)
    changed = original
      .replace('LANGUAGE sql', 'LANGUAGE plpgsql')
      .replace(
        /AS \$function\$[\s\S]*?\$function\$/,
        () => 'AS $function$ BEGIN RETURN; END; $function$',
      )
  } else {
    assert.match(
      original,
      mutation.pattern,
      `${mutation.name}: missing mutation anchor`,
    )
    changed = original.replace(mutation.pattern, mutation.replacement)
  }
  let verifier = readFileSync(
    new URL('../' + mutation.verifier, import.meta.url),
    'utf8',
  )
  if (mutation.isolateCheck) {
    // Keep the real fixture and selected assertion block. Independent checks
    // must each fail, rather than hiding behind an earlier check's failure.
    verifier = verifier.replace(/do \$\$[\s\S]*?end \$\$;/g, (block) =>
      block.includes(`${mutation.isolateCheck} FAIL:`) ? block : '',
    )
  }
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
