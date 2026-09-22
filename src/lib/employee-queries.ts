import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppRole } from '../hooks/useRole'
import { readPages } from './customer-queries.ts'

export type MemberRow = { id: string; user_id: string; role: AppRole }
export type Employee = MemberRow & { full_name: string | null }
export type InviteRow = {
  id: string
  email: string
  role: AppRole
  token: string
  expires_at: string
}
export const staffRoles: AppRole[] = [
  'admin',
  'manager',
  'attendant',
  'owner_viewer',
]
const inviteColumns = 'id, email, role, token, expires_at'

function requireOrg(orgId: string) {
  if (!orgId) throw new Error('An organization is required.')
}

export function loadMemberships(client: SupabaseClient, orgId: string) {
  requireOrg(orgId)
  return readPages<MemberRow>((start, end) =>
    client
      .from('memberships')
      .select('id, user_id, role')
      .eq('org_id', orgId)
      .order('created_at')
      .order('id')
      .range(start, end),
  )
}

export async function loadEmployeeProfiles(
  client: SupabaseClient,
  orgId: string,
  userIds: string[],
) {
  requireOrg(orgId)
  const profiles: { id: string; full_name: string | null }[] = []
  for (let i = 0; i < userIds.length; i += 100) {
    profiles.push(
      ...(await readPages<{ id: string; full_name: string | null }>(
        (start, end) =>
          client
            .from('profiles')
            .select('id, full_name')
            .eq('org_id', orgId)
            .in('id', userIds.slice(i, i + 100))
            .order('id')
            .range(start, end),
      )),
    )
  }
  return profiles
}

export function loadInvites(client: SupabaseClient, orgId: string) {
  requireOrg(orgId)
  return readPages<InviteRow>((start, end) =>
    client
      .from('invites')
      .select(inviteColumns)
      .eq('org_id', orgId)
      .is('accepted_at', null)
      .order('created_at', { ascending: false })
      .order('id')
      .range(start, end),
  )
}

export async function createEmployeeInvite(
  client: SupabaseClient,
  orgId: string,
  userId: string,
  email: string,
  role: AppRole,
) {
  requireOrg(orgId)
  if (!staffRoles.includes(role)) throw new Error('Choose a staff role.')
  const { data, error } = await client
    .from('invites')
    .insert({
      org_id: orgId,
      email: email.trim().toLowerCase(),
      role,
      invited_by: userId,
    })
    .select(inviteColumns)
    .single()
  if (error) throw new Error(error.message)
  return data as InviteRow
}

export async function revokeEmployeeInvite(
  client: SupabaseClient,
  orgId: string,
  inviteId: string,
) {
  requireOrg(orgId)
  const { data, error } = await client
    .from('invites')
    .delete()
    .eq('org_id', orgId)
    .eq('id', inviteId)
    .is('accepted_at', null)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data)
    throw new Error('Invitation was not revoked. Refresh and try again.')
}

/** Existing RLS requires an administrator. Current admins and self are deliberately excluded. */
export async function changeEmployeeRole(
  client: SupabaseClient,
  orgId: string,
  actorId: string,
  membershipId: string,
  role: AppRole,
) {
  requireOrg(orgId)
  if (!staffRoles.includes(role)) throw new Error('Choose a staff role.')
  const { data, error } = await client
    .from('memberships')
    .update({ role })
    .eq('org_id', orgId)
    .eq('id', membershipId)
    .neq('user_id', actorId)
    .neq('role', 'admin')
    .select('id, user_id, role')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data)
    throw new Error(
      'Role was not changed. Your own role and existing administrators are protected; refresh the roster if access has changed.',
    )
  return data as MemberRow
}
