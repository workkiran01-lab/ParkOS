import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertLoopbackDatabaseUrl } from './local-database.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const tiers = {
  database: [
    'supabase/dev-only/verify_no_anon_execute.sql',
    'supabase/dev-only/DEV_ONLY_verify_privileged_functions.sql',
    'supabase/dev-only/DEV_ONLY_verify_rls_isolation.sql',
    'supabase/dev-only/DEV_ONLY_verify_permit_issuance.sql',
    'supabase/dev-only/DEV_ONLY_verify_permit_cancellation.sql',
    'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    'supabase/dev-only/20260907010000_verify_reservation_corrections.sql',
    'supabase/dev-only/20260907020000_verify_facility_time.sql',
  ],
  financial: [
    'supabase/dev-only/20260825010000_verify_booth_payments.sql',
    'supabase/dev-only/20260826000000_verify_booth_revenue_reporting.sql',
    'supabase/dev-only/20260829000000_verify_permit_payments.sql',
    'supabase/dev-only/20260901000000_verify_permit_event_ordering_guard.sql',
    'supabase/dev-only/20260902000000_verify_permit_revenue_reporting.sql',
    'supabase/dev-only/20260903000000_verify_invoice_paid.sql',
    'supabase/dev-only/20260904000000_verify_dead_branch_removed.sql',
    'supabase/dev-only/20260905000000_verify_unresolved_payment.sql',
    'supabase/dev-only/20260906000000_verify_refund_ledgers.sql',
  ],
}

const seedFile = 'supabase/dev-only/DEV_ONLY_seed_dev_orgs.sql'
const allVerifierFiles = [...tiers.database, ...tiers.financial]
const allowedFiles = new Set([...allVerifierFiles, seedFile])

function usage() {
  return [
    'Usage:',
    '  node scripts/run-sql-verifiers.mjs --tier database|financial|all',
    '  node scripts/run-sql-verifiers.mjs --file <known-verifier-path>',
    '  node scripts/run-sql-verifiers.mjs --seed',
    '  node scripts/run-sql-verifiers.mjs --list',
  ].join('\n')
}

function parseFiles(args) {
  if (args.length === 1 && args[0] === '--list') return null
  if (args.length === 1 && args[0] === '--seed') return [seedFile]

  if (args.length === 2 && args[0] === '--tier') {
    if (args[1] === 'all') return allVerifierFiles
    if (Object.hasOwn(tiers, args[1])) return tiers[args[1]]
  }

  if (args.length === 2 && args[0] === '--file') {
    const normalized = args[1].replaceAll('\\', '/')
    if (allowedFiles.has(normalized)) return [normalized]
    throw new Error(`Unknown SQL verifier: ${args[1]}`)
  }

  throw new Error(usage())
}

function runFile(databaseUrl, file) {
  const absoluteFile = resolve(projectRoot, file)
  if (!existsSync(absoluteFile))
    throw new Error(`SQL verifier is missing: ${file}`)

  const supabaseCli = resolve(
    projectRoot,
    'node_modules',
    'supabase',
    'dist',
    'supabase.js',
  )
  if (!existsSync(supabaseCli)) {
    throw new Error(
      'Supabase CLI is missing. Run npm ci before database verification.',
    )
  }

  console.log(
    `Running ${relative(projectRoot, absoluteFile).replaceAll('\\', '/')}...`,
  )
  const result = spawnSync(
    process.execPath,
    [
      supabaseCli,
      'db',
      'query',
      '--db-url',
      databaseUrl,
      '--file',
      absoluteFile,
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${file} failed with exit code ${result.status ?? 'unknown'}.`,
    )
  }
}

function main() {
  const files = parseFiles(process.argv.slice(2))
  if (files === null) {
    console.log(`database (${tiers.database.length})`)
    for (const file of tiers.database) console.log(`  ${file}`)
    console.log(`financial (${tiers.financial.length})`)
    for (const file of tiers.financial) console.log(`  ${file}`)
    return
  }

  const databaseUrl = assertLoopbackDatabaseUrl(
    process.env.PARKOS_TEST_DATABASE_URL,
  )
  console.log(
    `Loopback database target confirmed; running ${files.length} SQL file(s).`,
  )
  for (const file of files) runFile(databaseUrl, file)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
