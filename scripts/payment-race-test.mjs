// Real independent transactions, with literal raw-ledger money assertions.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertLoopbackDatabaseUrl } from './local-database.mjs'

const url = assertLoopbackDatabaseUrl(process.env.PARKOS_TEST_DATABASE_URL)
const args = ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', url]
const admin = '00000000-0000-0000-0000-0000000000a1'
const org = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
function query(sql) {
  const r = spawnSync('psql', args, { input: sql, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.error?.message)
  return r.stdout.trim()
}
if (process.argv.includes('--mutations')) {
  const original = query(
    "select pg_get_functiondef('public.record_booth_payment(uuid,integer,text,text)'::regprocedure);",
  )
  // Restore the old row lock: RC still works, but RR retains stale money.
  const mutated = original.replace(
    /update public\.reservations r set payment_version = r\.payment_version \+ 1\s+where r\.id = p_reservation_id\s+returning r\.org_id, r\.currency, r\.archived_at\s+into v_org_id, v_currency, v_archived;/,
    'select r.org_id, r.currency, r.archived_at into v_org_id, v_currency, v_archived from public.reservations r where r.id = p_reservation_id for update;',
  )
  assert.notEqual(
    mutated,
    original,
    'payment serialization mutation did not match',
  )
  try {
    query(mutated)
    const broken = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--stale-snapshot'],
      { encoding: 'utf8' },
    )
    assert.notEqual(broken.status, 0, 'payment serialization mutant survived')
    assert.match(broken.stderr, /both collections committed/)
    console.log(
      'KILLED: old row lock permits two $10 collections on a $10 booking at repeatable read',
    )
  } finally {
    query(original)
  }
  console.log('RESTORED: payment serialization')
}
function session(name) {
  const child = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '',
    error = ''
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
      if (!child.stdin.writableEnded) child.stdin.end()
    },
    done,
  }
}
const mutant = process.argv.includes('--stale-snapshot')
for (const isolation of mutant
  ? ['repeatable read']
  : ['read committed', 'repeatable read']) {
  for (const [firstKind, secondKind] of mutant
    ? [['booth', 'booth']]
    : [
        ['booth', 'booth'],
        ['online', 'booth'],
        ['booth', 'online'],
        ['online', 'online'],
      ]) {
    const id = randomUUID()
    const tag = 'payment-race-' + id
    let a, b
    const action = (kind) =>
      kind === 'booth'
        ? `set local role authenticated; select public.record_booth_payment('${id}',1000,'cash');`
        : `reset role; insert into public.payments(org_id,reservation_id,stripe_checkout_session_id,amount_cents,status) values('${org}','${id}','cs_${randomUUID()}',1000,'pending');`
    try {
      query(`insert into public.reservations(id,org_id,facility_id,space_id,customer_id,during,status,price_breakdown,total_cents)
        select '${id}','${org}','11111111-1111-1111-1111-111111111111',s.id,'ca000001-0000-0000-0000-000000000001',
        '[2037-01-10 18:00Z,2037-01-10 20:00Z)','active','{}',1000 from public.spaces s join public.zones z on z.id=s.zone_id
        where z.facility_id='11111111-1111-1111-1111-111111111111' limit 1;`)
      a = session(tag + '-a')
      b = session(tag + '-b')
      const setup = `begin isolation level ${isolation};
        select set_config('request.jwt.claims','{"sub":"${admin}","role":"authenticated"}',true);
        select count(*) from public.payments where reservation_id='${id}'; select 'READY';`
      a.send(setup)
      b.send(setup)
      await Promise.all([a.saw('READY'), b.saw('READY')])
      a.send(action(firstKind) + " select 'COLLECTED';")
      await a.saw('COLLECTED')
      b.send(action(secondKind) + ' commit;')
      let blocked = false
      for (let i = 0; i < 100; i++) {
        if (
          query(
            `select count(*) from pg_stat_activity where application_name='${tag}-b' and wait_event_type='Lock';`,
          ) === '1'
        ) {
          blocked = true
          break
        }
        await delay(25)
      }
      assert.ok(blocked, 'second payment writer did not serialize')
      a.send('commit;')
      a.end()
      b.end()
      const [first, second] = await Promise.all([a.done, b.done])
      assert.equal(first.code, 0, first.error)
      assert.notEqual(second.code, 0, 'both collections committed')
      assert.match(
        second.error,
        isolation === 'repeatable read'
          ? /could not serialize access due to concurrent update/
          : /AMOUNT_EXCEEDS_BALANCE/,
      )
      // The only accepted raw row must be 1000 cents; no balance RPC as oracle.
      assert.equal(
        query(`select coalesce(sum(amount_cents),0) from (
        select amount_cents from public.booth_payments where reservation_id='${id}'
        union all select amount_cents from public.payments where reservation_id='${id}') money;`),
        '1000',
      )
      console.log(
        `PASS: ${isolation}, ${firstKind} versus ${secondKind}: one commit, one refusal, raw committed amount 1000`,
      )
    } finally {
      a?.end()
      b?.end()
      await Promise.all([a?.done, b?.done])
      query(`begin; set local session_replication_role=replica;
        delete from public.audit_log where target_id='${id}' or target_id in (select id from public.booth_payments where reservation_id='${id}');
        delete from public.booth_payments where reservation_id='${id}';
        delete from public.payments where reservation_id='${id}';
        delete from public.reservations where id='${id}'; commit;`)
    }
  }
}
