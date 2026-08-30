import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  PaymentStatusBadge,
  RefundPaymentButton,
} from '@/components/payments/PaymentControls'
import { DownloadReceiptButton } from '@/components/reservations/DownloadReceiptButton'
import { ReservationActions } from '@/components/reservations/ReservationActions'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { useFacility } from '@/hooks/useFacility'
import { useRole } from '@/hooks/useRole'
import { friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { formatRange, parseTstzrange } from '@/lib/holds'
import {
  paymentsByReservation,
  type PaymentSummary,
} from '@/lib/payments'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type Row = {
  id: string
  booking_code: string
  facility_id: string
  space_id: string
  during: string
  status: string
  total_cents: number
  currency: string
  space_number: string
  customer_name: string
  facility_name: string
  payment: PaymentSummary | null
}

const ANY = 'all'
const statuses = ['pending', 'confirmed', 'cancelled', 'no_show', 'completed']

export const Route = createFileRoute('/app/reservations')({
  component: StaffReservations,
})

function StaffReservations() {
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const {
    allFacilities: facilities,
    loading: facilitiesLoading,
    error: facilitiesError,
  } = useFacility()
  const [rows, setRows] = useState<Row[]>([])
  const [statusFilter, setStatusFilter] = useState('pending')
  const [facilityFilter, setFacilityFilter] = useState(ANY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const allowed = role === 'admin' || role === 'manager' || role === 'attendant'

  const load = useCallback(async () => {
    if (!orgId || !allowed || facilitiesLoading) return
    setLoading(true)
    setError(null)

    const resResult = await supabase
      .from('reservations')
      .select(
        'id, booking_code, facility_id, space_id, customer_id, during, status, total_cents, currency',
      )
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(500)

    if (resResult.error || facilitiesError) {
      setError(
        friendlyError(
          resResult.error ?? facilitiesError,
          'Reservations could not be loaded. Please try again.',
        ),
      )
      setLoading(false)
      return
    }

    const reservations = resResult.data ?? []
    const facilityName = new Map(facilities.map((f) => [f.id, f.name]))

    const spaceIds = [...new Set(reservations.map((r) => r.space_id))]
    const customerIds = [...new Set(reservations.map((r) => r.customer_id))]
    const reservationIds = reservations.map((reservation) => reservation.id)

    const [spaceRes, custRes, paymentRes] = await Promise.all([
      spaceIds.length
        ? supabase.from('spaces').select('id, space_number').in('id', spaceIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabase.from('customers').select('id, full_name').in('id', customerIds)
        : Promise.resolve({ data: [], error: null }),
      reservationIds.length
        ? supabase
            .from('payments')
            .select(
              'id, reservation_id, stripe_checkout_session_id, amount_cents, currency, status, created_at',
            )
            .eq('org_id', orgId)
            .in('reservation_id', reservationIds)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ])

    if (spaceRes.error || custRes.error || paymentRes.error) {
      setError(
        friendlyError(
          spaceRes.error ?? custRes.error ?? paymentRes.error,
          'Reservation details could not be loaded. Please try again.',
        ),
      )
      setLoading(false)
      return
    }

    const spaceNumber = new Map((spaceRes.data ?? []).map((s) => [s.id, s.space_number]))
    const customerName = new Map((custRes.data ?? []).map((c) => [c.id, c.full_name]))
    const paymentByReservation = paymentsByReservation(
      (paymentRes.data ?? []) as PaymentSummary[],
    )

    setRows(
      reservations.map((r) => ({
        id: r.id,
        booking_code: r.booking_code,
        facility_id: r.facility_id,
        space_id: r.space_id,
        during: r.during,
        status: r.status,
        total_cents: r.total_cents,
        currency: r.currency,
        space_number: spaceNumber.get(r.space_id) ?? '—',
        customer_name: customerName.get(r.customer_id) ?? 'Unknown',
        facility_name: facilityName.get(r.facility_id) ?? 'Facility',
        payment: paymentByReservation.get(r.id) ?? null,
      })),
    )
    setLoading(false)
  }, [orgId, allowed, facilities, facilitiesError, facilitiesLoading])

  useEffect(() => {
    if (!roleLoading) void Promise.resolve().then(load)
  }, [load, roleLoading])

  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          (statusFilter === ANY || row.status === statusFilter) &&
          (facilityFilter === ANY || row.facility_id === facilityFilter),
      ),
    [rows, statusFilter, facilityFilter],
  )

  if (roleLoading) return <PageSpinner />

  if (!allowed) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Reservations unavailable</CardTitle>
          <CardDescription>A staff role is required.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Reservations</h1>
        <p className="mt-1 text-muted-foreground">
          Review payments, extend bookings, or cancel when plans change.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Status">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All statuses</SelectItem>
                  {statuses.map((s) => (
                    <SelectItem key={s} value={s}>
                      {label(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Facility">
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
            </Field>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {loading ? (
            <p className="py-6 text-center text-muted-foreground">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              No reservations match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Facility</TableHead>
                    <TableHead>Space</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Reservation</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => {
                    const { start, end } = parseTstzrange(row.during)
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">
                          {row.customer_name}
                          <p className="font-mono text-xs text-muted-foreground">
                            {row.booking_code}
                          </p>
                        </TableCell>
                        <TableCell>{row.facility_name}</TableCell>
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
                            {label(row.status)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <PaymentStatusBadge status={row.payment?.status ?? null} />
                        </TableCell>
                        <TableCell className="text-right">
                          {dollars(row.total_cents)} {row.currency}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {start && end && (
                              <ReservationActions
                                reservationId={row.id}
                                status={row.status}
                                spaceId={row.space_id}
                                startIso={start.toISOString()}
                                endIso={end.toISOString()}
                                isStaff
                                allowExtend={
                                  !row.payment || row.payment.status === 'failed'
                                }
                                onDone={load}
                              />
                            )}
                            {(row.payment?.status === 'succeeded' ||
                              row.payment?.status === 'partially_refunded' ||
                              row.payment?.status === 'refunded') && (
                              <DownloadReceiptButton reservationId={row.id} />
                            )}
                            {(role === 'admin' || role === 'manager') && row.payment && (
                              <RefundPaymentButton payment={row.payment} onDone={load} />
                            )}
                          </div>
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
    </div>
  )
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
