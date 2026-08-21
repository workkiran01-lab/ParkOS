import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ReservationActions } from '@/components/reservations/ReservationActions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageSpinner } from '@/components/ui/Spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useRole } from '@/hooks/useRole'
import { dollars } from '@/lib/format'
import { formatRange, parseTstzrange } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type HoldRow = {
  id: string
  space_id: string
  hold_type: string
  during: string
  reservation_id: string | null
  space_number: string
}

type ResRow = {
  id: string
  space_id: string
  during: string
  status: string
  total_cents: number
  currency: string
  space_number: string
  customer_name: string
}

type AuditRow = {
  id: string
  actor_id: string | null
  action: string
  target_table: string
  target_id: string | null
  reason: string | null
  created_at: string
  actor_name: string
}

export const Route = createFileRoute('/app/override')({
  component: Override,
})

function Override() {
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const [holds, setHolds] = useState<HoldRow[]>([])
  const [reservations, setReservations] = useState<ResRow[]>([])
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [search, setSearch] = useState('')
  const [sweeping, setSweeping] = useState(false)
  const [releasing, setReleasing] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const allowed = role === 'admin' || role === 'manager'

  const load = useCallback(async () => {
    if (!orgId || !allowed) return
    setLoading(true)
    setError(null)

    const [holdRes, resRes, auditRes] = await Promise.all([
      supabase
        .from('space_holds')
        .select('id, space_id, hold_type, during, reservation_id')
        .eq('org_id', orgId)
        .is('released_at', null)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('reservations')
        .select('id, space_id, customer_id, during, status, total_cents, currency')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('audit_log')
        .select('id, actor_id, action, target_table, target_id, reason, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(100),
    ])

    if (holdRes.error || resRes.error || auditRes.error) {
      setError(
        holdRes.error?.message ??
          resRes.error?.message ??
          auditRes.error?.message ??
          'Load failed.',
      )
      setLoading(false)
      return
    }

    const holdRows = holdRes.data ?? []
    const resRows = resRes.data ?? []
    const auditRows = auditRes.data ?? []

    const spaceIds = [
      ...new Set([
        ...holdRows.map((h) => h.space_id),
        ...resRows.map((r) => r.space_id),
      ]),
    ]
    const customerIds = [...new Set(resRows.map((r) => r.customer_id))]
    const actorIds = [
      ...new Set(auditRows.map((a) => a.actor_id).filter((v): v is string => !!v)),
    ]

    const [spaceRes, custRes, profRes] = await Promise.all([
      spaceIds.length
        ? supabase.from('spaces').select('id, space_number').in('id', spaceIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabase.from('customers').select('id, full_name').in('id', customerIds)
        : Promise.resolve({ data: [], error: null }),
      actorIds.length
        ? supabase.from('profiles').select('id, full_name').in('id', actorIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    const spaceNumber = new Map((spaceRes.data ?? []).map((s) => [s.id, s.space_number]))
    const customerName = new Map((custRes.data ?? []).map((c) => [c.id, c.full_name]))
    // Staff actors resolve to a profile name; customer actors (self-cancel)
    // have no profile, and cron has no actor at all.
    const actorName = new Map((profRes.data ?? []).map((p) => [p.id, p.full_name]))

    setHolds(
      holdRows.map((h) => ({
        id: h.id,
        space_id: h.space_id,
        hold_type: h.hold_type,
        during: h.during,
        reservation_id: h.reservation_id,
        space_number: spaceNumber.get(h.space_id) ?? '—',
      })),
    )
    setReservations(
      resRows.map((r) => ({
        id: r.id,
        space_id: r.space_id,
        during: r.during,
        status: r.status,
        total_cents: r.total_cents,
        currency: r.currency,
        space_number: spaceNumber.get(r.space_id) ?? '—',
        customer_name: customerName.get(r.customer_id) ?? 'Unknown',
      })),
    )
    setAudit(
      auditRows.map((a) => ({
        ...a,
        actor_name: a.actor_id
          ? (actorName.get(a.actor_id) ?? `${a.actor_id.slice(0, 8)} (customer)`)
          : 'system',
      })),
    )
    setLoading(false)
  }, [orgId, allowed])

  useEffect(() => {
    if (!roleLoading) void Promise.resolve().then(load)
  }, [load, roleLoading])

  async function releaseHold(id: string) {
    setReleasing(id)
    // Admin/manager space_holds_update policy (Week 5) covers any hold type —
    // this is the override that policy was built for.
    const { error: releaseError } = await supabase
      .from('space_holds')
      .update({ released_at: new Date().toISOString() })
      .eq('id', id)
    setReleasing(null)
    if (releaseError) {
      toast.error(releaseError.message)
      return
    }
    toast.success('Hold released')
    await load()
  }

  async function runSweep() {
    if (!orgId) return
    setSweeping(true)
    const { data, error: sweepError } = await supabase.rpc('mark_no_shows', {
      p_org_id: orgId,
    })
    setSweeping(false)
    if (sweepError) {
      toast.error(sweepError.message)
      return
    }
    toast.success(`No-show sweep marked ${data ?? 0} reservation(s)`)
    await load()
  }

  if (roleLoading) return <PageSpinner />

  if (!allowed) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Override console unavailable</CardTitle>
          <CardDescription>
            An administrator or manager role is required.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const filteredReservations = reservations.filter((row) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (
      row.customer_name.toLowerCase().includes(q) ||
      row.space_number.toLowerCase().includes(q) ||
      row.id.toLowerCase().startsWith(q)
    )
  })

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Override console</h1>
        <p className="mt-1 text-muted-foreground">
          Manager tools: force-release holds, cancel bookings, sweep no-shows,
          and review the audit trail.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && <PageSpinner />}

      <Card>
        <CardHeader>
          <CardTitle>Active holds</CardTitle>
          <CardDescription>
            Every unreleased hold in the org — reservation, permit, or
            maintenance. Releasing frees the space immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {holds.length === 0 ? (
            <p className="py-4 text-center text-muted-foreground">
              No active holds.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Space</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {holds.map((hold) => (
                  <TableRow key={hold.id}>
                    <TableCell className="font-medium">{hold.space_number}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{hold.hold_type}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRange(hold.during)}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={releasing === hold.id}
                        onClick={() => releaseHold(hold.id)}
                      >
                        {releasing === hold.id ? 'Releasing…' : 'Force-release'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent reservations</CardTitle>
          <CardDescription>Cancel with a reason, or extend/confirm.</CardDescription>
          <CardAction>
            <Button disabled={sweeping} onClick={runSweep}>
              {sweeping ? 'Sweeping…' : 'Run no-show sweep now'}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Search">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Customer, space, or reservation id"
              className="max-w-sm"
            />
          </Field>
          {filteredReservations.length === 0 ? (
            <p className="py-4 text-center text-muted-foreground">
              No matching reservations.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Space</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredReservations.map((row) => {
                    const { start, end } = parseTstzrange(row.during)
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">
                          {row.customer_name}
                        </TableCell>
                        <TableCell>{row.space_number}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatRange(row.during)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.status === 'cancelled' || row.status === 'no_show'
                                ? 'outline'
                                : 'default'
                            }
                          >
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {dollars(row.total_cents)} {row.currency}
                        </TableCell>
                        <TableCell>
                          {start && end && (
                            <ReservationActions
                              reservationId={row.id}
                              status={row.status}
                              spaceId={row.space_id}
                              startIso={start.toISOString()}
                              endIso={end.toISOString()}
                              isStaff
                              onDone={load}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit log</CardTitle>
          <CardDescription>
            Append-only record of lifecycle actions. Written only by the
            server; read-only here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {audit.length === 0 ? (
            <p className="py-4 text-center text-muted-foreground">
              No audit entries yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audit.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {new Date(entry.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell>{entry.actor_name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{entry.action}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {entry.target_table}
                        {entry.target_id ? `/${entry.target_id.slice(0, 8)}` : ''}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {entry.reason ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
