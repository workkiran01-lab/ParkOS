import assert from 'node:assert/strict'
import {
  changeEmployeeRole,
  createEmployeeInvite,
  loadEmployeeProfiles,
  loadInvites,
  loadMemberships,
  revokeEmployeeInvite,
} from '../src/lib/employee-queries.ts'

const userA = '00000000-0000-0000-0000-0000000000a1'
const userB = '00000000-0000-0000-0000-0000000000b1'
const managerId = '00000000-0000-0000-0000-0000000000a2'
const targetId = '00000000-0000-0000-0000-0000000000a3'
const memberB = 'de000000-0000-0000-0000-000000000021'
const inviteA = 'de000000-0000-0000-0000-000000000022'
const inviteB = 'de000000-0000-0000-0000-000000000023'
const email = 'employee-isolation@example.test'

export function employeeFixtures(sql, orgA, orgB, remove = false) {
  if (remove) {
    sql(
      `delete from public.invites where email like 'employee-isolation%@example.test'; delete from public.memberships where id='${memberB}';`,
    )
    return
  }
  sql(`insert into public.memberships(id, org_id, user_id, role) values ('${memberB}', '${orgB}', '00000000-0000-0000-0000-0000000000a6', 'attendant');
    insert into public.invites(id, org_id, email, role, invited_by) values ('${inviteA}', '${orgA}', '${email}', 'attendant', '${userA}'), ('${inviteB}', '${orgB}', '${email}', 'attendant', '${userB}');`)
}

export function employeeCases({ sql, adminA, adminB, clientFor, orgA, orgB }) {
  const manager = clientFor(managerId)
  const membership = () =>
    sql(
      `select id from public.memberships where org_id='${orgA}' and user_id='${targetId}'`,
    )
  const resetRoles = () =>
    sql(
      `update public.memberships set role='attendant' where (org_id='${orgA}' and user_id='${targetId}') or id='${memberB}'; update public.memberships set role='manager' where org_id='${orgA}' and user_id='${managerId}';`,
    )
  const resetInvites = () =>
    sql(
      `insert into public.invites(id, org_id, email, role, invited_by) values ('${inviteA}', '${orgA}', '${email}', 'attendant', '${userA}'), ('${inviteB}', '${orgB}', '${email}', 'attendant', '${userB}') on conflict (id) do nothing;`,
    )
  return {
    'employee memberships': {
      tables: ['memberships'],
      async check() {
        assert.ok(
          (await loadMemberships(adminA, orgA)).some(
            (row) => row.user_id === userA,
          ),
        )
        assert.ok(
          (await loadMemberships(adminB, orgB)).some(
            (row) => row.id === memberB,
          ),
        )
        assert.deepEqual(
          await loadMemberships(adminA, orgB),
          [],
          'foreign memberships leaked',
        )
      },
    },
    'employee profiles': {
      tables: ['profiles'],
      async check() {
        assert.equal(
          (await loadEmployeeProfiles(adminA, orgA, [userA])).length,
          1,
        )
        assert.equal(
          (await loadEmployeeProfiles(adminB, orgB, [userB])).length,
          1,
        )
        assert.deepEqual(
          await loadEmployeeProfiles(adminA, orgB, [userB]),
          [],
          'foreign employee profiles leaked',
        )
      },
    },
    'employee invitations': {
      tables: ['invites'],
      async check() {
        assert.ok(
          (await loadInvites(adminA, orgA)).some((row) => row.id === inviteA),
        )
        assert.ok(
          (await loadInvites(adminB, orgB)).some((row) => row.id === inviteB),
        )
        assert.deepEqual(
          await loadInvites(adminA, orgB),
          [],
          'foreign invitation tokens leaked',
        )
      },
    },
    'employee invitation create': {
      tables: ['invites'],
      async check() {
        try {
          const own = await createEmployeeInvite(
            adminA,
            orgA,
            userA,
            'employee-isolation-create@example.test',
            'attendant',
          )
          assert.ok(own.id, 'own invitation creation must work')
          let denied = false
          try {
            await createEmployeeInvite(
              adminA,
              orgB,
              userA,
              'employee-isolation-create@example.test',
              'attendant',
            )
          } catch {
            denied = true
          }
          assert.equal(denied, true, 'foreign invitation write leaked')
        } finally {
          sql(
            "delete from public.invites where email='employee-isolation-create@example.test'",
          )
        }
      },
    },
    'employee invitation revoke': {
      tables: ['invites'],
      async check() {
        try {
          await revokeEmployeeInvite(adminA, orgA, inviteA)
          assert.equal(
            sql(`select count(*) from public.invites where id='${inviteA}'`),
            '0',
          )
          let denied = false
          try {
            await revokeEmployeeInvite(adminA, orgB, inviteB)
          } catch {
            denied = true
          }
          assert.equal(denied, true, 'foreign invitation deletion leaked')
          assert.equal(
            sql(`select count(*) from public.invites where id='${inviteB}'`),
            '1',
          )
        } finally {
          resetInvites()
        }
      },
    },
    'employee role tenant': {
      tables: ['memberships'],
      async check() {
        try {
          const own = await changeEmployeeRole(
            adminA,
            orgA,
            userA,
            membership(),
            'manager',
          )
          assert.equal(own.role, 'manager')
          assert.equal(
            sql(`select role from public.memberships where id='${own.id}'`),
            'manager',
          )
          let denied = false
          try {
            await changeEmployeeRole(adminA, orgB, userA, memberB, 'manager')
          } catch {
            denied = true
          }
          assert.equal(denied, true, 'foreign role write leaked')
        } finally {
          resetRoles()
        }
      },
    },
    'employee non-admin role write': {
      tables: ['memberships'],
      async check() {
        try {
          let denied = false
          try {
            await changeEmployeeRole(
              manager,
              orgA,
              managerId,
              membership(),
              'owner_viewer',
            )
          } catch {
            denied = true
          }
          assert.equal(
            denied,
            true,
            'unauthorized non-admin changed another employee role',
          )
          assert.equal(
            sql(
              `select role from public.memberships where id='${membership()}'`,
            ),
            'attendant',
          )
        } finally {
          resetRoles()
        }
      },
    },
    'employee self-elevation direct API': {
      tables: ['memberships'],
      async check() {
        try {
          // Deliberately bypass all UI/query guards: only database authorization may prevent this.
          const { data, error } = await manager
            .from('memberships')
            .update({ role: 'admin' })
            .eq('org_id', orgA)
            .eq('user_id', managerId)
            .select('id')
          assert.ok(
            error || data.length === 0,
            'unauthorized self-elevation succeeded through direct API',
          )
          assert.equal(
            sql(
              `select role from public.memberships where org_id='${orgA}' and user_id='${managerId}'`,
            ),
            'manager',
          )
        } finally {
          resetRoles()
        }
      },
    },
  }
}
