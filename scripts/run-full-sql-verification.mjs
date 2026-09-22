import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertLoopbackDatabaseUrl } from './local-database.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const url = assertLoopbackDatabaseUrl(process.env.PARKOS_TEST_DATABASE_URL)

function counts() {
  const result = spawnSync(
    'psql',
    ['--no-psqlrc', '-At', '--set=ON_ERROR_STOP=1', url],
    {
      cwd: root,
      encoding: 'utf8',
      input: `select format('select %L || ''|'' || count(*)::text from %I.%I',
                         n.nspname || '.' || c.relname, n.nspname, c.relname)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and
       (n.nspname = 'public' or (n.nspname, c.relname) in (('auth','users'), ('storage','objects')))
     order by n.nspname, c.relname
\\gexec
`,
    },
  )
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const rows = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [table, count] = line.split('|')
      assert.match(count, /^\d+$/, line)
      return [table, Number(count)]
    })
  assert.ok(rows.length >= 23, 'Expected application, auth and storage tables')
  return Object.fromEntries(rows)
}

const before = counts()
console.log('SYNTHETIC ROW COUNTS BEFORE FIRST VERIFIER')
console.table(before)
const run = spawnSync(
  process.execPath,
  ['scripts/run-sql-verifiers.mjs', '--tier', 'all'],
  {
    cwd: root,
    stdio: 'inherit',
  },
)
const after = counts()
console.log('SYNTHETIC ROW COUNTS AFTER LAST VERIFIER')
console.table(after)
assert.deepEqual(after, before, 'Verifier suite left synthetic rows behind')
console.log(
  'CLEANUP PASS: every application/auth/storage row count is unchanged',
)
assert.ifError(run.error)
assert.equal(
  run.status,
  0,
  'The sequential 17-verifier run failed; cleanup is reported independently',
)
