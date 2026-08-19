import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageSpinner } from '@/components/ui/Spinner'
import { useAuth } from '@/hooks/useAuth'
import { type AppRole, useRole } from '@/hooks/useRole'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type MemberRow = {
  id: string
  user_id: string
  role: AppRole
  full_name: string | null
}

type InviteRow = {
  id: string
  email: string
  role: AppRole
  token: string
  expires_at: string
}

const staffRoles: AppRole[] = ['admin', 'manager', 'attendant', 'owner_viewer']
const selectClass =
  'h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

export const Route = createFileRoute('/app/staff')({
  component: Staff,
})

function Staff() {
  const { user } = useAuth()
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const [members, setMembers] = useState<MemberRow[]>([])
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<AppRole>('attendant')
  const [latestLink, setLatestLink] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!orgId || role !== 'admin') return
    setLoading(true)
    setError(null)

    const [membershipsResult, invitesResult] = await Promise.all([
      supabase
        .from('memberships')
        .select('id, user_id, role')
        .eq('org_id', orgId)
        .order('created_at'),
      supabase
        .from('invites')
        .select('id, email, role, token, expires_at')
        .eq('org_id', orgId)
        .is('accepted_at', null)
        .order('created_at', { ascending: false }),
    ])

    if (membershipsResult.error || invitesResult.error) {
      setError(membershipsResult.error?.message ?? invitesResult.error?.message ?? 'Unable to load staff.')
      setLoading(false)
      return
    }

    const membershipRows = membershipsResult.data ?? []
    const userIds = membershipRows.map((membership) => membership.user_id)
    const profileNames = new Map<string, string | null>()

    if (userIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds)

      if (profilesError) {
        setError(profilesError.message)
        setLoading(false)
        return
      }
      for (const profile of profiles ?? []) profileNames.set(profile.id, profile.full_name)
    }

    setMembers(
      membershipRows.map((membership) => ({
        id: membership.id,
        user_id: membership.user_id,
        role: membership.role as AppRole,
        full_name: profileNames.get(membership.user_id) ?? null,
      })),
    )
    setInvites((invitesResult.data ?? []) as InviteRow[])
    setLoading(false)
  }, [orgId, role])

  useEffect(() => {
    if (!roleLoading) void Promise.resolve().then(load)
  }, [load, roleLoading])

  function inviteLink(invite: Pick<InviteRow, 'token' | 'email'>) {
    const params = new URLSearchParams({ token: invite.token, email: invite.email })
    return `${window.location.origin}/accept-invite?${params.toString()}`
  }

  async function createInvite(event: FormEvent) {
    event.preventDefault()
    if (!orgId || !user) return
    setSubmitting(true)
    setError(null)

    const normalizedEmail = email.trim().toLowerCase()
    const { data, error: inviteError } = await supabase
      .from('invites')
      .insert({
        org_id: orgId,
        email: normalizedEmail,
        role: inviteRole,
        invited_by: user.id,
      })
      .select('id, email, role, token, expires_at')
      .single()

    setSubmitting(false)
    if (inviteError) {
      setError(inviteError.message)
      return
    }

    const nextInvite = data as InviteRow
    setLatestLink(inviteLink(nextInvite))
    setEmail('')
    await load()
    toast.success('Invitation created')
  }

  async function copyLink(invite: Pick<InviteRow, 'token' | 'email'>) {
    await navigator.clipboard.writeText(inviteLink(invite))
    toast.success('Invite link copied')
  }

  async function revoke(inviteId: string) {
    const { error: revokeError } = await supabase.from('invites').delete().eq('id', inviteId)
    if (revokeError) {
      setError(revokeError.message)
      return
    }
    setInvites((current) => current.filter((invite) => invite.id !== inviteId))
    toast.success('Invitation revoked')
  }

  if (roleLoading) return <PageSpinner />

  if (role !== 'admin') {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Administrator access required</CardTitle>
          <CardDescription>Only administrators can manage staff and invites.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Staff</h1>
        <p className="mt-1 text-muted-foreground">Manage team access and invitation links.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite a staff member</CardTitle>
          <CardDescription>Pending invitations expire after seven days.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-[1fr_12rem_auto]" onSubmit={createInvite}>
            <Field label="Email">
              <Input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            <Field label="Role">
              <select className={selectClass} value={inviteRole} onChange={(event) => setInviteRole(event.target.value as AppRole)}>
                {staffRoles.map((staffRole) => (
                  <option key={staffRole} value={staffRole}>{roleLabel(staffRole)}</option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={submitting}>{submitting ? 'Creating…' : 'Create invite'}</Button>
            </div>
          </form>
          {latestLink && (
            <div className="mt-4 rounded-lg border bg-muted/50 p-3">
              <p className="mb-2 text-sm font-medium">New invitation link</p>
              <div className="flex gap-2">
                <Input value={latestLink} readOnly />
                <Button variant="outline" onClick={() => navigator.clipboard.writeText(latestLink)}>Copy</Button>
              </div>
            </div>
          )}
          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Current members</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {loading ? <p className="text-muted-foreground">Loading…</p> : members.map((member) => (
              <div key={member.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{member.full_name ?? 'Unnamed member'}</p>
                  <p className="truncate text-xs text-muted-foreground">{member.user_id}</p>
                </div>
                <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">{roleLabel(member.role)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Pending invitations</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {!loading && invites.length === 0 && <p className="text-muted-foreground">No pending invitations.</p>}
            {invites.map((invite) => (
              <div key={invite.id} className="space-y-3 rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{invite.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {roleLabel(invite.role)} · expires {new Date(invite.expires_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => copyLink(invite)}>Copy link</Button>
                  <Button size="sm" variant="destructive" onClick={() => revoke(invite.id)}>Revoke</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function roleLabel(role: AppRole) {
  return role.replace('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}
