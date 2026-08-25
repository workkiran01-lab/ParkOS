import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Clock3, RefreshCw, XCircle } from 'lucide-react'
import {
  PaymentStatusBadge,
  PayNowButton,
} from '@/components/payments/PaymentControls'
import { DownloadReceiptButton } from '@/components/reservations/DownloadReceiptButton'
import { ReservationActions } from '@/components/reservations/ReservationActions'
import { TicketStub } from '@/components/reservations/TicketStub'
import { Badge } from '@/components/ui/badge'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAuth } from '@/hooks/useAuth'
import { DEACTIVATED_MESSAGE, signOutIfDeactivated } from '@/lib/account'
import { friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { formatRange, parseTstzrange } from '@/lib/holds'
import { paymentsByReservation, type PaymentSummary } from '@/lib/payments'
import { supabase } from '@/lib/supabase'
import { AuthPage, Field } from '@/routes/login'

type ReservationRow = {
  reservation_id: string
  booking_code: string
  facility_id: string
  facility_name: string
  space_id: string
  space_number: string
  zone_name: string
  during: string
  status: string
  total_cents: number
  currency: string
  created_at: string
}

type DisplayRow = ReservationRow & {
  payment: PaymentSummary | null
}

type PermitRow = {
  permit_id: string
  facility_name: string
  space_number: string
  starts_at: string
  monthly_rate_cents: number
  currency: string
  status: string
  current_period_start: string | null
  current_period_end: string | null
  cancelled_at: string | null
}

type ReservationSearch = {
  checkout?: 'success' | 'cancelled'
  reservation_id?: string
  session_id?: string
}

export const Route = createFileRoute('/my/reservations')({
  validateSearch: (search: Record<string, unknown>): ReservationSearch => ({
    checkout:
      search.checkout === 'success' || search.checkout === 'cancelled'
        ? search.checkout
        : undefined,
    reservation_id:
      typeof search.reservation_id === 'string'
        ? search.reservation_id
        : undefined,
    session_id:
      typeof search.session_id === 'string' ? search.session_id : undefined,
  }),
  component: MyReservations,
})

function MyReservations() {
  const { checkout, reservation_id: returnedReservationId } = Route.useSearch()
  const { user, loading: authLoading } = useAuth()
  const [rows, setRows] = useState<DisplayRow[]>([])
  const [permits, setPermits] = useState<PermitRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pollTimedOut, setPollTimedOut] = useState(false)

  // Inline login keeps customers out of the staff-only application shell.
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  const load = useCallback(async (): Promise<DisplayRow[] | null> => {
    setError(null)
    const { data, error: loadError } = await supabase.rpc('get_my_reservations')
    if (loadError) {
      setError(
        friendlyError(
          loadError,
          'Your reservations could not be loaded. Please try again.',
        ),
      )
      setLoaded(true)
      return null
    }

    const reservations = (data ?? []) as ReservationRow[]
    const reservationIds = reservations.map((row) => row.reservation_id)
    let paymentRows: PaymentSummary[] = []

    if (reservationIds.length > 0) {
      const { data: payments, error: paymentError } = await supabase
        .from('payments')
        .select(
          'id, reservation_id, stripe_checkout_session_id, amount_cents, currency, status, created_at',
        )
        .in('reservation_id', reservationIds)
        .order('created_at', { ascending: false })

      if (paymentError) {
        setError(
          friendlyError(
            paymentError,
            'Payment details could not be loaded. Please try again.',
          ),
        )
        setLoaded(true)
        return null
      }
      paymentRows = (payments ?? []) as PaymentSummary[]
    }

    const paymentByReservation = paymentsByReservation(paymentRows)
    const displayRows = reservations.map((row) => ({
      ...row,
      payment: paymentByReservation.get(row.reservation_id) ?? null,
    }))
    setRows(displayRows)
    setLoaded(true)
    return displayRows
  }, [])

  const loadPermits = useCallback(async () => {
    const { data, error: permitError } = await supabase.rpc('get_my_permits')
    if (!permitError) setPermits((data ?? []) as PermitRow[])
  }, [])

  useEffect(() => {
    if (!authLoading && user) {
      void Promise.resolve().then(load)
      void Promise.resolve().then(loadPermits)
    }
  }, [authLoading, user, load, loadPermits])

  useEffect(() => {
    if (checkout !== 'success' || !returnedReservationId || !user) return

    let cancelled = false
    let timer: number | undefined
    let attempts = 0
    // Deferred so no setState runs synchronously in the effect body; the guard
    // keeps a torn-down cycle from clearing a later cycle's timed-out flag.
    void Promise.resolve().then(() => {
      if (!cancelled) setPollTimedOut(false)
    })

    async function poll() {
      const latest = await load()
      if (cancelled || !latest) return

      const reservation = latest.find(
        (row) => row.reservation_id === returnedReservationId,
      )
      if (
        reservation?.status === 'confirmed' &&
        reservation.payment?.status === 'succeeded'
      ) {
        return
      }

      attempts += 1
      if (attempts >= 8) {
        setPollTimedOut(true)
        return
      }
      timer = window.setTimeout(poll, 2_000)
    }

    timer = window.setTimeout(poll, 1_200)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [checkout, returnedReservationId, user, load])

  const returnedReservation = useMemo(
    () =>
      rows.find((row) => row.reservation_id === returnedReservationId) ?? null,
    [rows, returnedReservationId],
  )

  async function refresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  async function login(event: FormEvent) {
    event.preventDefault()
    setAuthBusy(true)
    setAuthError(null)
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (loginError) {
      setAuthBusy(false)
      setAuthError(
        friendlyError(loginError, 'That email and password did not match.'),
      )
      return
    }
    if (await signOutIfDeactivated()) setAuthError(DEACTIVATED_MESSAGE)
    setAuthBusy(false)
  }

  if (authLoading) return <PageSpinner />

  if (!user) {
    return (
      <AuthPage>
        <Card>
          <CardHeader>
            <CardTitle>My reservations</CardTitle>
            <CardDescription>Log in to see your bookings.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={login}>
              <Field label="Email">
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {authError && (
                <p className="text-sm text-destructive">{authError}</p>
              )}
              <Button className="w-full" type="submit" disabled={authBusy}>
                {authBusy ? 'Logging in…' : 'Log in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </AuthPage>
    )
  }

  return (
    <div className="min-h-screen bg-muted/30 px-4 py-10">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              My reservations
            </h1>
            <p className="mt-1 text-muted-foreground">
              Every booking on this account, across all parking operators.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link to="/my/settings">Settings</Link>
            </Button>
            <Button variant="ghost" onClick={() => supabase.auth.signOut()}>
              Sign out
            </Button>
          </div>
        </div>

        {checkout && (
          <CheckoutNotice
            checkout={checkout}
            reservation={returnedReservation}
            timedOut={pollTimedOut}
            refreshing={refreshing}
            onRefresh={refresh}
          />
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {permits.length > 0 && <PermitsSection permits={permits} />}

        <Card>
          <CardContent>
            {!loaded ? (
              <p className="py-6 text-center text-muted-foreground">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">
                No reservations yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Facility</TableHead>
                    <TableHead>Space</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Reservation</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Actions</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const { start, end } = parseTstzrange(row.during)
                    const paymentSettled =
                      row.payment?.status === 'succeeded' ||
                      row.payment?.status === 'partially_refunded' ||
                      row.payment?.status === 'refunded'
                    return (
                      <TableRow key={row.reservation_id}>
                        <TableCell className="font-medium">
                          {row.facility_name}
                          {/* The booking code replaces the truncated UUID here:
                              it is the reference a customer actually quotes. */}
                          <p className="font-mono text-xs text-muted-foreground">
                            {row.booking_code}
                          </p>
                        </TableCell>
                        <TableCell>
                          {row.space_number}
                          <p className="text-xs text-muted-foreground">
                            {row.zone_name}
                          </p>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatRange(row.during)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.status === 'cancelled' ||
                              row.status === 'no_show'
                                ? 'outline'
                                : 'default'
                            }
                          >
                            {label(row.status)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <PaymentStatusBadge
                            status={row.payment?.status ?? null}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          {dollars(row.total_cents)} {row.currency}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {row.status === 'pending' && !paymentSettled && (
                              <PayNowButton
                                reservationId={row.reservation_id}
                              />
                            )}
                            {paymentSettled && (
                              <DownloadReceiptButton
                                reservationId={row.reservation_id}
                              />
                            )}
                            {start && end && (
                              <ReservationActions
                                reservationId={row.reservation_id}
                                status={row.status}
                                spaceId={row.space_id}
                                startIso={start.toISOString()}
                                endIso={end.toISOString()}
                                isStaff={false}
                                allowExtend={
                                  !row.payment ||
                                  row.payment.status === 'failed'
                                }
                                onDone={() => {
                                  void load()
                                }}
                              />
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" asChild>
                            <Link
                              to="/book/$facilityId"
                              params={{ facilityId: row.facility_id }}
                            >
                              Book again
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function PermitsSection({ permits }: { permits: PermitRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly permits</CardTitle>
        <CardDescription>
          Your assigned parking spaces. To change or cancel a permit, contact
          the operator — permits are staff-managed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Facility</TableHead>
              <TableHead>Space</TableHead>
              <TableHead className="text-right">Monthly</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Next billing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {permits.map((permit) => (
              <TableRow key={permit.permit_id}>
                <TableCell className="font-medium">
                  {permit.facility_name}
                </TableCell>
                <TableCell className="tabular-nums">
                  {permit.space_number}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {dollars(permit.monthly_rate_cents)} {permit.currency}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      permit.status === 'active'
                        ? 'default'
                        : permit.status === 'suspended'
                          ? 'secondary'
                          : 'outline'
                    }
                  >
                    {label(permit.status)}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {permit.status === 'cancelled'
                    ? '—'
                    : permit.current_period_end
                      ? new Date(permit.current_period_end).toLocaleDateString(
                          undefined,
                          { dateStyle: 'medium' },
                        )
                      : 'Awaiting first invoice'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function CheckoutNotice({
  checkout,
  reservation,
  timedOut,
  refreshing,
  onRefresh,
}: {
  checkout: 'success' | 'cancelled'
  reservation: DisplayRow | null
  timedOut: boolean
  refreshing: boolean
  onRefresh: () => void | Promise<void>
}) {
  if (checkout === 'cancelled') {
    return (
      <div className="flex items-start gap-3 rounded-lg border bg-card p-4 text-sm">
        <XCircle className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium">Checkout closed</p>
          <p className="text-muted-foreground">
            Your reservation is still pending. Pay whenever you’re ready.
          </p>
        </div>
      </div>
    )
  }

  const confirmed =
    reservation?.status === 'confirmed' &&
    reservation.payment?.status === 'succeeded'
  const failed = reservation?.payment?.status === 'failed'

  // Settled and paid is the moment the booking becomes final, so it gets the
  // stub. The pending and failed states are still in flight: they stay a plain
  // notice, which is what keeps the stub meaningful.
  if (confirmed && reservation) {
    return (
      <TicketStub
        status="Paid"
        code={reservation.booking_code}
        lines={[
          `${reservation.facility_name} · Space ${reservation.space_number}`,
          formatRange(reservation.during),
        ]}
        amount={dollars(reservation.total_cents)}
      />
    )
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-start gap-3">
        {failed ? (
          <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
        ) : (
          <Clock3 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        )}
        <div>
          <p className="font-medium">
            {failed
              ? 'Payment needs another try'
              : timedOut
                ? 'Confirmation is still processing'
                : 'Payment received, confirming…'}
          </p>
          <p className="text-muted-foreground">
            {failed
              ? 'Stripe could not complete that payment. Your reservation remains pending.'
              : 'Stripe and ParkOS can take a moment to finish syncing.'}
          </p>
        </div>
      </div>
      <Button variant="outline" disabled={refreshing} onClick={onRefresh}>
        <RefreshCw data-icon="inline-start" />
        {refreshing ? 'Refreshing…' : 'Refresh status'}
      </Button>
    </div>
  )
}

function label(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}
