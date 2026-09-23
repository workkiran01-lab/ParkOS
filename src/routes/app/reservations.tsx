import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  PaymentStatusBadge,
  RefundPaymentButton,
} from '@/components/payments/PaymentControls'
import { DownloadReceiptButton } from '@/components/reservations/DownloadReceiptButton'
import { ReservationActions } from '@/components/reservations/ReservationActions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import {
  bookingPayment,
  loadCustomerPayments,
  type CustomerPayment,
} from '@/lib/customer-queries'
import { dollars } from '@/lib/format'
import { formatRange, parseTstzrange } from '@/lib/holds'
import { paymentsByReservation, type PaymentSummary } from '@/lib/payments'
import { supabase } from '@/lib/supabase'
import { reservationQuery } from '@/lib/reservation-queries'
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
  facility_timezone: string
  customer_email: string | null
  customer_phone: string | null
  license_plate: string | null
  payment: PaymentSummary | null
  balance_cents: number
  paid_cents: number
  can_collect: boolean
}

const ANY = 'all'
const statuses = [
  'pending',
  'confirmed',
  'active',
  'cancelled',
  'no_show',
  'completed',
]

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

    const resResult = await reservationQuery(supabase, orgId)
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
    const facilityTimezone = new Map(facilities.map((f) => [f.id, f.timezone]))

    const spaceIds = [...new Set(reservations.map((r) => r.space_id))]
    const customerIds = [...new Set(reservations.map((r) => r.customer_id))]
    const vehicleIds = [
      ...new Set(
        reservations
          .map((reservation) => reservation.vehicle_id)
          .filter((id): id is string => id !== null),
      ),
    ]
    const reservationIds = reservations.map((reservation) => reservation.id)

    const [spaceRes, custRes, vehicleRes, paymentRes] = await Promise.all([
      spaceIds.length
        ? supabase.from('spaces').select('id, space_number').in('id', spaceIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabase
            .from('customers')
            .select('id, full_name, email, phone')
            .in('id', customerIds)
        : Promise.resolve({ data: [], error: null }),
      vehicleIds.length
        ? supabase
            .from('vehicles')
            .select('id, license_plate')
            .in('id', vehicleIds)
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

    if (
      spaceRes.error ||
      custRes.error ||
      vehicleRes.error ||
      paymentRes.error
    ) {
      setError(
        friendlyError(
          spaceRes.error ??
            custRes.error ??
            vehicleRes.error ??
            paymentRes.error,
          'Reservation details could not be loaded. Please try again.',
        ),
      )
      setLoading(false)
      return
    }

    // The Stripe badge alone misses cash/card payments collected at the booth.
    // Read both complete ledgers, using the same balance rule as Customer Books.
    let ledgerRows: CustomerPayment[]
    try {
      const ledgers = await Promise.all([
        loadCustomerPayments(supabase, orgId, reservationIds, 'payments'),
        loadCustomerPayments(supabase, orgId, reservationIds, 'booth_payments'),
      ])
      ledgerRows = ledgers.flat()
    } catch (error) {
      setError(
        friendlyError(
          error,
          'Payment balances could not be loaded. Please try again.',
        ),
      )
      setLoading(false)
      return
    }

    const spaceNumber = new Map(
      (spaceRes.data ?? []).map((space) => [space.id, space.space_number]),
    )
    const customerDetails = new Map(
      (custRes.data ?? []).map((customer) => [customer.id, customer]),
    )
    const vehiclePlate = new Map(
      (vehicleRes.data ?? []).map((vehicle) => [
        vehicle.id,
        vehicle.license_plate,
      ]),
    )
    const paymentByReservation = paymentsByReservation(
      (paymentRes.data ?? []) as PaymentSummary[],
    )

    setRows(
      reservations.map((r) => {
        const payments = ledgerRows.filter(
          (payment) => payment.reservation_id === r.id,
        )
        const balance = bookingPayment(r.total_cents, payments)
        return {
          id: r.id,
          booking_code: r.booking_code,
          facility_id: r.facility_id,
          space_id: r.space_id,
          during: r.during,
          status: r.status,
          total_cents: r.total_cents,
          currency: r.currency,
          space_number: spaceNumber.get(r.space_id) ?? '—',
          customer_name:
            customerDetails.get(r.customer_id)?.full_name ?? 'Unknown',
          customer_email: customerDetails.get(r.customer_id)?.email ?? null,
          customer_phone: customerDetails.get(r.customer_id)?.phone ?? null,
          license_plate: r.vehicle_id
            ? (vehiclePlate.get(r.vehicle_id) ?? null)
            : null,
          facility_name: facilityName.get(r.facility_id) ?? 'Facility',
          facility_timezone: facilityTimezone.get(r.facility_id) ?? '',
          payment: paymentByReservation.get(r.id) ?? null,
          balance_cents: balance.due,
          paid_cents: balance.paid,
          can_collect:
            r.archived_at === null &&
            ['pending', 'confirmed', 'active', 'completed'].includes(
              r.status,
            ) &&
            balance.due > 0 &&
            !payments.some((payment) => payment.status === 'pending'),
        }
      }),
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
                          {formatRange(row.during, row.facility_timezone)}
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
                          {row.paid_cents > 0 && row.balance_cents > 0 ? (
                            <Badge variant="secondary">Partially paid</Badge>
                          ) : (
                            <PaymentStatusBadge
                              status={
                                row.paid_cents > 0 && row.balance_cents === 0
                                  ? 'succeeded'
                                  : (row.payment?.status ?? null)
                              }
                            />
                          )}
                          {row.can_collect && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {dollars(row.balance_cents)} due
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {dollars(row.total_cents)} {row.currency}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {row.can_collect && (
                              <Button size="sm" asChild>
                                <Link
                                  to="/checkin/$bookingCode"
                                  params={{ bookingCode: row.booking_code }}
                                >
                                  Take payment
                                </Link>
                              </Button>
                            )}
                            {start && end && (
                              <ReservationActions
                                reservationId={row.id}
                                status={row.status}
                                spaceId={row.space_id}
                                startIso={start.toISOString()}
                                endIso={end.toISOString()}
                                facilityTimezone={row.facility_timezone}
                                isStaff
                                allowExtend={
                                  !row.payment ||
                                  row.payment.status === 'failed'
                                }
                                correction={{
                                  facilityId: row.facility_id,
                                  facilityTimezone: row.facility_timezone,
                                  customerName: row.customer_name,
                                  customerEmail: row.customer_email,
                                  customerPhone: row.customer_phone,
                                  licensePlate: row.license_plate,
                                }}
                                onDone={load}
                              />
                            )}
                            {(row.payment?.status === 'succeeded' ||
                              row.payment?.status === 'partially_refunded' ||
                              row.payment?.status === 'refunded') && (
                              <DownloadReceiptButton reservationId={row.id} />
                            )}
                            {(role === 'admin' || role === 'manager') &&
                              row.payment && (
                                <RefundPaymentButton
                                  payment={row.payment}
                                  onDone={load}
                                />
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
