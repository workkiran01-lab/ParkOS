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
import {
  changeEmployeeRole,
  createEmployeeInvite,
  loadEmployeeProfiles,
  loadInvites,
  loadMemberships,
  revokeEmployeeInvite,
  staffRoles,
  type Employee,
  type InviteRow,
} from '@/lib/employee-queries'
import { Field } from '@/routes/login'

const selectClass =
  'h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'
export const Route = createFileRoute('/app/staff')({ component: Staff })

function Staff() {
  const { user } = useAuth()
  const { role, org_id: orgId, loading } = useRole()
  if (loading) return <PageSpinner />
  if (role !== 'admin' || !orgId || !user)
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Administrator access required</CardTitle>
          <CardDescription>
            Only administrators can manage employees and invitations.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  return (
    <EmployeeScreen
      key={`${orgId}/${user.id}`}
      orgId={orgId}
      actorId={user.id}
    />
  )
}
function EmployeeScreen({
  orgId,
  actorId,
}: {
  orgId: string
  actorId: string
}) {
  const [members, setMembers] = useState<Employee[]>([])
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [search, setSearch] = useState('')
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<AppRole>('attendant')
  const [latestLink, setLatestLink] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, pending] = await Promise.all([
        loadMemberships(supabase, orgId),
        loadInvites(supabase, orgId),
      ])
      const profiles = await loadEmployeeProfiles(
        supabase,
        orgId,
        rows.map((row) => row.user_id),
      )
      const names = new Map(
        profiles.map((profile) => [profile.id, profile.full_name]),
      )
      setMembers(
        rows.map((row) => ({
          ...row,
          full_name: names.get(row.user_id) ?? null,
        })),
      )
      setInvites(pending)
    } catch (error) {
      setError(message(error))
    } finally {
      setLoading(false)
    }
  }, [orgId])
  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])
  function inviteLink(invite: Pick<InviteRow, 'token' | 'email'>) {
    return `${window.location.origin}/accept-invite?${new URLSearchParams({ token: invite.token, email: invite.email })}`
  }
  async function createInvite(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const invite = await createEmployeeInvite(
        supabase,
        orgId,
        actorId,
        email,
        inviteRole,
      )
      setLatestLink(inviteLink(invite))
      setEmail('')
      await load()
      toast.success('Invitation created')
    } catch (error) {
      setError(message(error))
    } finally {
      setSubmitting(false)
    }
  }
  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link)
      toast.success('Invite link copied')
    } catch {
      setError('Unable to copy. Select and copy the invitation link.')
    }
  }
  async function revoke(invite: InviteRow) {
    setError(null)
    try {
      await revokeEmployeeInvite(supabase, orgId, invite.id)
      setInvites((current) => current.filter((row) => row.id !== invite.id))
      if (latestLink === inviteLink(invite)) setLatestLink(null)
      toast.success('Invitation revoked')
    } catch (error) {
      setError(message(error))
    }
  }
  const term = search.trim().toLowerCase()
  const filtered = members.filter((member) =>
    [member.full_name, member.user_id, roleLabel(member.role)].some((value) =>
      value?.toLowerCase().includes(term),
    ),
  )
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Employees</h1>
        <p className="mt-1 text-muted-foreground">
          Manage your organization's team and invitation links.
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Invite an employee</CardTitle>
          <CardDescription>
            Create a link to share. Invitations expire after seven days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 sm:grid-cols-[1fr_12rem_auto]"
            onSubmit={createInvite}
          >
            <Field label="Email">
              <Input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Role">
              <select
                aria-label="Invitation role"
                className={selectClass}
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as AppRole)
                }
              >
                {staffRoles.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Creating...' : 'Create invite'}
              </Button>
            </div>
          </form>
          {latestLink && (
            <div className="mt-4 rounded-lg border bg-muted/50 p-3">
              <p className="mb-2 text-sm font-medium">New invitation link</p>
              <div className="flex gap-2">
                <Input
                  aria-label="New invitation link"
                  value={latestLink}
                  readOnly
                />
                <Button variant="outline" onClick={() => copyLink(latestLink)}>
                  Copy
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Current employees</CardTitle>
            <CardDescription>
              Your own role and existing administrators are read-only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="search"
              aria-label="Search employees"
              placeholder="Search name, role, or user ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {loading ? (
              <p role="status" className="text-muted-foreground">
                Loading...
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {filtered.length} of {members.length} members
                </p>
                {filtered.length === 0 && (
                  <p className="text-muted-foreground">
                    No employees match this search.
                  </p>
                )}
                {filtered.map((member) => (
                  <div
                    key={member.id}
                    className="space-y-3 rounded-lg border p-3"
                    aria-label={`Employee ${member.full_name || member.user_id}`}
                  >
                    <div>
                      <p className="font-medium">
                        {member.full_name || 'Unnamed member'}
                        {member.user_id === actorId && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            You
                          </span>
                        )}
                      </p>
                      <p className="break-all text-xs text-muted-foreground">
                        {member.user_id}
                      </p>
                    </div>
                    {member.role === 'admin' || member.user_id === actorId ? (
                      <span className="inline-block rounded-full bg-muted px-2 py-1 text-xs font-medium">
                        {roleLabel(member.role)}
                      </span>
                    ) : (
                      <RoleEditor
                        key={`${member.id}/${member.role}`}
                        member={member}
                        orgId={orgId}
                        actorId={actorId}
                        onSaved={load}
                      />
                    )}
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!loading && invites.length === 0 && (
              <p className="text-muted-foreground">No pending invitations.</p>
            )}
            {invites.map((invite) => (
              <div key={invite.id} className="space-y-3 rounded-lg border p-3">
                <div>
                  <p className="break-all font-medium">{invite.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {roleLabel(invite.role)} -{' '}
                    {new Date(invite.expires_at) <= new Date()
                      ? 'Expired'
                      : 'Expires'}{' '}
                    {new Date(invite.expires_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyLink(inviteLink(invite))}
                  >
                    Copy link
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => revoke(invite)}
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
function RoleEditor({
  member,
  orgId,
  actorId,
  onSaved,
}: {
  member: Employee
  orgId: string
  actorId: string
  onSaved: () => Promise<void>
}) {
  const [role, setRole] = useState(member.role)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setSaving(true)
    setError(null)
    try {
      await changeEmployeeRole(supabase, orgId, actorId, member.id, role)
      await onSaved()
      toast.success('Role updated')
    } catch (error) {
      setError(message(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select
          aria-label={`Role for ${member.full_name || member.user_id}`}
          className={selectClass}
          disabled={saving}
          value={role}
          onChange={(event) => setRole(event.target.value as AppRole)}
        >
          {member.role === 'customer' && (
            <option value="customer">Customer</option>
          )}
          {staffRoles.map((value) => (
            <option key={value} value={value}>
              {roleLabel(value)}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={saving || role === member.role}
          onClick={save}
        >
          {saving ? 'Saving...' : 'Save role'}
        </Button>
      </div>
      {role === 'admin' && role !== member.role && (
        <p className="text-xs text-muted-foreground">
          Administrators manage the organization's access. Their role becomes
          read-only here.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
function roleLabel(role: AppRole) {
  return role
    .replace('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Employee management could not be completed.'
}
