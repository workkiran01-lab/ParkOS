import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { createFileRoute } from '@tanstack/react-router'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { edgeFunctionError, friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type FacilityOption = { id: string; name: string }
type AvailableSpace = { id: string; space_number: string; space_type: string }
type CustomerOption = { id: string; full_name: string; email: string | null }

type PermitRow = {
  id: string
  facility_id: string
  facility_name: string
  space_number: string
  customer_name: string
  monthly_rate_cents: number
  currency: string
  status: string
  stripe_subscription_id: string | null
  current_period_start: string | null
  current_period_end: string | null
}

const ANY = 'all'

export const Route = createFileRoute('/app/permits')({
  component: Permits,
})

function Permits() {
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const [facilities, setFacilities] = useState<FacilityOption[]>([])
  const [rows, setRows] = useState<PermitRow[]>([])
  const [facilityFilter, setFacilityFilter] = useState(ANY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<PermitRow | null>(null)

  const allowed = role === 'admin' || role === 'manager'

  const load = useCallback(async () => {
    if (!orgId || !allowed) return
    setLoading(true)
    setError(null)

    const [permitResult, facilityResult] = await Promise.all([
      supabase
        .from('permits')
        .select(
          'id, facility_id, space_id, customer_id, monthly_rate_cents, currency, status, stripe_subscription_id, current_period_start, current_period_end, created_at',
        )
        .eq('org_id', orgId)
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase
        .from('facilities')
        .select('id, name')
        .eq('org_id', orgId)
        .order('name'),
    ])

    if (permitResult.error || facilityResult.error) {
      setError(
        friendlyError(
          permitResult.error ?? facilityResult.error,
          'Permits could not be loaded. Please try again.',
        ),
      )
      setLoading(false)
      return
    }

    const permits = permitResult.data ?? []
    const facilityRows = (facilityResult.data ?? []) as FacilityOption[]
    setFacilities(facilityRows)
    const facilityName = new Map(facilityRows.map((f) => [f.id, f.name]))

    const spaceIds = [...new Set(permits.map((p) => p.space_id))]
    const customerIds = [...new Set(permits.map((p) => p.customer_id))]

    const [spaceRes, custRes] = await Promise.all([
      spaceIds.length
        ? supabase.from('spaces').select('id, space_number').in('id', spaceIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabase.from('customers').select('id, full_name').in('id', customerIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (spaceRes.error || custRes.error) {
      setError(
        friendlyError(
          spaceRes.error ?? custRes.error,
          'Permit details could not be loaded. Please try again.',
        ),
      )
      setLoading(false)
      return
    }

    const spaceNumber = new Map((spaceRes.data ?? []).map((s) => [s.id, s.space_number]))
    const customerName = new Map((custRes.data ?? []).map((c) => [c.id, c.full_name]))

    setRows(
      permits.map((p) => ({
        id: p.id,
        facility_id: p.facility_id,
        facility_name: facilityName.get(p.facility_id) ?? 'Facility',
        space_number: spaceNumber.get(p.space_id) ?? '—',
        customer_name: customerName.get(p.customer_id) ?? 'Unknown',
        monthly_rate_cents: p.monthly_rate_cents,
        currency: p.currency,
        status: p.status,
        stripe_subscription_id: p.stripe_subscription_id,
        current_period_start: p.current_period_start,
        current_period_end: p.current_period_end,
      })),
    )
    setLoading(false)
  }, [orgId, allowed])

  useEffect(() => {
    if (!roleLoading) void Promise.resolve().then(load)
  }, [load, roleLoading])

  const visible = useMemo(
    () =>
      rows.filter(
        (row) => facilityFilter === ANY || row.facility_id === facilityFilter,
      ),
    [rows, facilityFilter],
  )

  if (roleLoading) return <PageSpinner />

  if (!allowed) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Permits unavailable</CardTitle>
          <CardDescription>
            An administrator or manager role is required.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Permits</h1>
          <p className="mt-1 text-muted-foreground">
            Monthly assigned-space permits, billed through Stripe subscriptions.
          </p>
        </div>
        <Button onClick={() => setIssuing((v) => !v)}>
          {issuing ? 'Close' : 'Issue permit'}
        </Button>
      </div>

      {issuing && orgId && (
        <IssuePermitForm
          orgId={orgId}
          facilities={facilities}
          onIssued={() => {
            setIssuing(false)
            void load()
          }}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Issued permits</CardTitle>
          <CardDescription>Every permit for this organization.</CardDescription>
          <CardAction>
            <Select value={facilityFilter} onValueChange={setFacilityFilter}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All facilities</SelectItem>
                {facilities.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardAction>
        </CardHeader>
        <CardContent>
          {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
          {loading ? (
            <p className="py-6 text-center text-muted-foreground">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              No permits{facilityFilter === ANY ? ' yet' : ' at this facility'}.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Facility</TableHead>
                    <TableHead>Space</TableHead>
                    <TableHead className="text-right">Monthly</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Billing period</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.customer_name}</TableCell>
                      <TableCell>{row.facility_name}</TableCell>
                      <TableCell className="tabular-nums">{row.space_number}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {dollars(row.monthly_rate_cents)} {row.currency}
                      </TableCell>
                      <TableCell>
                        <PermitStatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {billingPeriod(row.current_period_start, row.current_period_end)}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.status !== 'cancelled' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setCancelTarget(row)}
                          >
                            Cancel
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <CancelPermitDialog
        key={cancelTarget?.id ?? 'none'}
        permit={cancelTarget}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        onCancelled={() => {
          setCancelTarget(null)
          void load()
        }}
      />
    </div>
  )
}

function IssuePermitForm({
  orgId,
  facilities,
  onIssued,
}: {
  orgId: string
  facilities: FacilityOption[]
  onIssued: () => void
}) {
  const [facilityId, setFacilityId] = useState(facilities[0]?.id ?? '')
  const [startDate, setStartDate] = useState(() => todayInputValue())
  const [spaces, setSpaces] = useState<AvailableSpace[] | null>(null)
  const [spaceId, setSpaceId] = useState('')
  const [searching, setSearching] = useState(false)

  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [customerId, setCustomerId] = useState('')
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [addingCustomer, setAddingCustomer] = useState(false)

  const [rateDollars, setRateDollars] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [setupUrl, setSetupUrl] = useState<string | null>(null)

  const loadCustomers = useCallback(async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, full_name, email')
      .eq('org_id', orgId)
      .is('archived_at', null)
      .order('full_name')
    setCustomers((data ?? []) as CustomerOption[])
  }, [orgId])

  useEffect(() => {
    void Promise.resolve().then(loadCustomers)
  }, [loadCustomers])

  // A permit hold is open-ended, so a space is only issuable if nothing holds it
  // from the start date onward. Reuse Week 6's availability search with a far
  // horizon to approximate the open-ended window issue_permit will insert.
  async function findSpaces() {
    if (!facilityId) return
    setSearching(true)
    setError(null)
    setSpaces(null)
    setSpaceId('')
    const start = startAtIso(startDate)
    const horizon = new Date(start)
    horizon.setFullYear(horizon.getFullYear() + 50)
    const { data, error: searchError } = await supabase.rpc('find_available_spaces', {
      p_facility_id: facilityId,
      p_start: start,
      p_end: horizon.toISOString(),
    })
    setSearching(false)
    if (searchError) {
      setError(friendlyError(searchError, 'Could not load available spaces.'))
      return
    }
    setSpaces((data ?? []) as AvailableSpace[])
  }

  async function addCustomer() {
    if (!newName.trim()) return
    setAddingCustomer(true)
    setError(null)
    const { data, error: insertError } = await supabase
      .from('customers')
      .insert({
        org_id: orgId,
        full_name: newName.trim(),
        email: newEmail.trim() || null,
      })
      .select('id, full_name, email')
      .single()
    setAddingCustomer(false)
    if (insertError || !data) {
      setError(friendlyError(insertError, 'Could not create the customer.'))
      return
    }
    setCustomers((current) => [...current, data as CustomerOption])
    setCustomerId(data.id)
    setNewName('')
    setNewEmail('')
    toast.success('Customer added')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const cents = Math.round(Number(rateDollars) * 100)
    if (!facilityId || !spaceId || !customerId) {
      setError('Pick a facility, space, and customer first.')
      return
    }
    if (!Number.isFinite(cents) || cents <= 0) {
      setError('Enter a monthly rate greater than zero.')
      return
    }

    setSubmitting(true)
    setError(null)

    // 1. Create the permit + its open-ended hold atomically (7-arg signature:
    //    org, facility, space, customer, start, monthly_rate_cents, currency).
    const { data: permit, error: issueError } = await supabase.rpc('issue_permit', {
      p_org_id: orgId,
      p_facility_id: facilityId,
      p_space_id: spaceId,
      p_customer_id: customerId,
      p_start: startAtIso(startDate),
      p_monthly_rate_cents: cents,
      p_currency: 'USD',
    })
    if (issueError || !permit) {
      setSubmitting(false)
      setError(friendlyError(issueError, 'The permit could not be issued.'))
      return
    }

    const permitId = (permit as { id: string }).id

    // 2. Start the Stripe subscription. The permit already exists and holds the
    //    space; a subscription-setup failure is surfaced but does not undo it.
    const { data: sub, error: subError } = await supabase.functions.invoke<{
      payment_url: string | null
      subscription_id: string
    }>('create-permit-subscription', {
      body: { permit_id: permitId, action: 'create' },
    })
    setSubmitting(false)

    if (subError) {
      toast.warning('Permit issued, but Stripe setup did not start.')
      setError(
        await edgeFunctionError(
          subError,
          'The permit was issued, but its subscription could not be started. Open the permit to retry billing.',
        ),
      )
      onIssued()
      return
    }

    toast.success('Permit issued and subscription created')
    if (sub?.payment_url) {
      setSetupUrl(sub.payment_url)
    } else {
      onIssued()
    }
  }

  if (setupUrl) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Permit issued</CardTitle>
          <CardDescription>
            The Stripe subscription was created. Send the customer this secure
            Stripe page to complete their first payment and save a card.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <a
            href={setupUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block break-all text-sm font-medium text-primary underline"
          >
            {setupUrl}
          </a>
          <div>
            <Button variant="outline" onClick={onIssued}>
              Done
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Issue a permit</CardTitle>
        <CardDescription>
          Assign a space to a customer with recurring monthly billing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={submit}>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Facility">
              <Select
                value={facilityId}
                onValueChange={(value) => {
                  setFacilityId(value)
                  setSpaces(null)
                  setSpaceId('')
                }}
              >
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Choose facility" />
                </SelectTrigger>
                <SelectContent>
                  {facilities.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Starts">
              <Input
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </Field>
            <Button
              type="button"
              variant="outline"
              disabled={searching || !facilityId}
              onClick={findSpaces}
            >
              {searching ? 'Searching…' : 'Find available spaces'}
            </Button>
          </div>

          {spaces && spaces.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No spaces are free from that date onward.
            </p>
          )}
          {spaces && spaces.length > 0 && (
            <div>
              <p className="mb-1.5 text-sm font-medium">Space</p>
              <div className="flex flex-wrap gap-2">
                {spaces.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSpaceId(s.id)}
                    className={`rounded-md border px-3 py-2 text-sm font-medium tabular-nums ${
                      spaceId === s.id
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'bg-background hover:bg-muted'
                    }`}
                  >
                    {s.space_number}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2">
            <Field label="Customer">
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.full_name}
                      {c.email ? ` · ${c.email}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Monthly rate (USD)">
              <Input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="150.00"
                value={rateDollars}
                onChange={(event) => setRateDollars(event.target.value)}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 p-3">
            <Field label="New customer name">
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Jane Doe"
              />
            </Field>
            <Field label="Email (optional)">
              <Input
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                placeholder="jane@example.com"
              />
            </Field>
            <Button
              type="button"
              variant="outline"
              disabled={addingCustomer || !newName.trim()}
              onClick={addCustomer}
            >
              {addingCustomer ? 'Adding…' : 'Add customer'}
            </Button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={submitting || !spaceId || !customerId || !rateDollars}
            >
              {submitting ? 'Issuing…' : 'Issue permit & start billing'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function CancelPermitDialog({
  permit,
  onOpenChange,
  onCancelled,
}: {
  permit: PermitRow | null
  onOpenChange: (open: boolean) => void
  onCancelled: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function confirmCancel() {
    if (!permit) return
    setBusy(true)
    // cancel_permit is the source of truth: it marks the permit cancelled and
    // releases the space hold immediately (so the occupancy grid frees the
    // space at once). If a Stripe subscription exists, also request its
    // cancellation so billing actually stops — cancel_permit is idempotent, so
    // the resulting webhook re-cancel is a no-op.
    const { error: cancelError } = await supabase.rpc('cancel_permit', {
      p_permit_id: permit.id,
      p_reason: reason.trim() || null,
    })
    if (cancelError) {
      setBusy(false)
      toast.error(friendlyError(cancelError, 'The permit could not be cancelled.'))
      return
    }

    if (permit.stripe_subscription_id) {
      const { error: subError } = await supabase.functions.invoke(
        'create-permit-subscription',
        { body: { permit_id: permit.id, action: 'cancel', reason: reason.trim() } },
      )
      if (subError) {
        toast.warning(
          'Permit cancelled, but stopping Stripe billing failed — verify in Stripe.',
        )
      }
    }

    setBusy(false)
    toast.success('Permit cancelled')
    onCancelled()
  }

  return (
    <Dialog open={!!permit} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel permit</DialogTitle>
          <DialogDescription>
            {permit
              ? `Cancel ${permit.customer_name}'s permit for space ${permit.space_number}? This releases the space and stops billing.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <Field label="Reason (optional)">
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. customer moved out"
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep permit
          </Button>
          <Button variant="destructive" onClick={confirmCancel} disabled={busy}>
            {busy ? 'Cancelling…' : 'Cancel permit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PermitStatusBadge({ status }: { status: string }) {
  const variant =
    status === 'active'
      ? 'default'
      : status === 'suspended'
        ? 'secondary'
        : 'outline'
  return <Badge variant={variant}>{label(status)}</Badge>
}

function billingPeriod(start: string | null, end: string | null) {
  if (!start && !end) return 'Awaiting first invoice'
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—'
  return `${fmt(start)} → ${fmt(end)}`
}

/** A date input value (YYYY-MM-DD) for today, in local time. */
function todayInputValue() {
  const now = new Date()
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset())
  return now.toISOString().slice(0, 10)
}

/** Interpret a date input as the start instant. An empty value falls back to
 * now so a permit always has a valid start. */
function startAtIso(dateValue: string) {
  if (!dateValue) return new Date().toISOString()
  const parsed = new Date(`${dateValue}T00:00:00`)
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString()
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
