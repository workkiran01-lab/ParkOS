// Two real sessions share a snapshot before either removes an administrator.
// The second session must wait and then reject, at both isolation levels.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertLoopbackDatabaseUrl } from './local-database.mjs'

const url = assertLoopbackDatabaseUrl(process.env.PARKOS_TEST_DATABASE_URL)
const args = ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', url]
const admin = '00000000-0000-0000-0000-0000000000a1'
const other = '00000000-0000-0000-0000-0000000000a2'
function query(sql) {
  const r = spawnSync('psql', args, { input: sql, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.error?.message)
  return r.stdout.trim()
}
if (process.argv.includes('--mutations')) {
  const original = query(
    "select pg_catalog.pg_get_functiondef('public.preserve_last_active_admin()'::regprocedure);",
  )
  const mutated = original.replace(
    'update public.organizations set name = name where id = v_org;',
    'perform 1;',
  )
  assert.notEqual(mutated, original, 'serialization mutation did not match')
  try {
    query(mutated)
    const broken = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url)],
      { encoding: 'utf8' },
    )
    console.log(broken.stdout + broken.stderr)
    assert.notEqual(broken.status, 0, 'serialization mutant survived')
    assert.match(broken.stderr, /second last-admin writer did not serialize/)
  } finally {
    query(original)
  }
  console.log('RESTORED: last-admin serialization')
  const restored = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url)],
    { stdio: 'inherit' },
  )
  assert.equal(restored.status, 0, 'restored last-admin races failed')
  process.exit(0)
}
function session(name) {
  const child = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let error = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (error += chunk))
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output, error }))
  })
  child.stdin.write(
    `set application_name = '${name}'; set statement_timeout = '15s';\n`,
  )
  return {
    send(sql) {
      child.stdin.write(sql + '\n')
    },
    async saw(marker) {
      for (let i = 0; i < 200; i++) {
        if (output.includes(marker)) return
        assert.equal(error, '', error)
        await delay(25)
      }
      assert.fail(`Session did not reach ${marker}: ${output} ${error}`)
    },
    end() {
      child.stdin.end()
    },
    done,
  }
}

for (const isolation of ['read committed', 'repeatable read']) {
  // Mixed membership/deactivation removals exercise both trigger entry points.
  for (const secondAction of ['demote', 'deactivate']) {
    const org = randomUUID()
    const tag = `last-admin-${org}`
    let a, b
    try {
      query(`insert into public.organizations(id,name) values ('${org}','__LAST_ADMIN_RACE__');
        insert into public.memberships(org_id,user_id,role) values
        ('${org}','${admin}','admin'), ('${org}','${other}','admin');`)
      a = session(tag + '-a')
      b = session(tag + '-b')
      const setup = `begin isolation level ${isolation};
        select count(*) from public.memberships where org_id = '${org}'; select 'READY';`
      a.send(setup)
      b.send(setup)
      await Promise.all([a.saw('READY'), b.saw('READY')])
      a.send(
        `delete from public.memberships where org_id = '${org}' and user_id = '${admin}'; select 'REMOVED';`,
      )
      await a.saw('REMOVED')
      b.send(
        secondAction === 'demote'
          ? `update public.memberships set role = 'manager' where org_id = '${org}' and user_id = '${other}'; commit;`
          : `insert into public.account_status(user_id,status) values ('${other}','deactivated'); commit;`,
      )
      // Observe an actual blocked writer, not a timing guess. Without the
      // parent-row serialization, both removals succeed and this fails.
      let blocked = false
      for (let i = 0; i < 100; i++) {
        if (
          query(
            `select count(*) from pg_catalog.pg_stat_activity where application_name = '${tag}-b' and wait_event_type = 'Lock';`,
          ) === '1'
        ) {
          blocked = true
          break
        }
        await delay(25)
      }
      assert.ok(blocked, 'second last-admin writer did not serialize')
      a.send('commit;')
      a.end()
      b.end()
      const [first, second] = await Promise.all([a.done, b.done])
      assert.equal(first.code, 0, first.error)
      assert.notEqual(second.code, 0, 'both removals committed')
      assert.match(
        second.error,
        isolation === 'repeatable read'
          ? /could not serialize access due to concurrent update/
          : /LAST_ACTIVE_ADMIN_REQUIRED/,
      )
      assert.equal(
        query(`select count(*) from public.memberships m where m.org_id = '${org}' and m.role = 'admin'
        and not exists (select 1 from public.account_status s where s.user_id = m.user_id and s.status = 'deactivated');`),
        '1',
      )
      console.log(
        `PASS: ${isolation}, delete versus ${secondAction}: one commit, one refusal, one active admin`,
      )
    } finally {
      a?.end()
      b?.end()
      await Promise.all([a?.done, b?.done])
      // Local-only fixture teardown; bypass triggers only in this transaction.
      query(`begin; set local session_replication_role = replica;
        delete from public.memberships where org_id = '${org}';
        delete from public.organizations where id = '${org}'; commit;`)
    }
  }
}
