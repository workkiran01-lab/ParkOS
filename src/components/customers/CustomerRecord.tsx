import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { PageHeader, SectionCard } from '@/components/layout/PagePrimitives'
import { useFacility } from '@/hooks/useFacility'
import { useRole } from '@/hooks/useRole'
import {
  bookingPayment,
  loadCustomer,
  loadCustomerBookings,
  loadCustomerPayments,
  loadCustomerVehicles,
  type Customer,
  type CustomerPayment,
  type CustomerVehicle,
} from '@/lib/customer-queries'
import { formatInstantForFacility } from '@/lib/facility-time'
import { dollars } from '@/lib/format'
import { parseTstzrange } from '@/lib/holds'
import type { ReservationRecord } from '@/lib/reservation-queries'
import { supabase } from '@/lib/supabase'

type Result = {
  key: string
  customer: Customer | null
  vehicles: CustomerVehicle[]
  bookings: ReservationRecord[]
  payments: CustomerPayment[]
  error?: string
}

export function CustomerRecord({
  customerId,
  books = false,
}: {
  customerId: string
  books?: boolean
}) {
  const { org_id: orgId, role, loading } = useRole()
  const { allFacilities } = useFacility()
  const allowed = role === 'admin' || role === 'manager' || role === 'attendant'
  const key = `${orgId}/${customerId}/${books}`
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => {
    if (!orgId || !allowed) return
    let cancelled = false
    void (async () => {
      const customer = await loadCustomer(supabase, orgId, customerId)
      const next: Result = {
        key,
        customer,
        vehicles: [],
        bookings: [],
        payments: [],
      }
      if (customer) {
        if (books) {
          next.bookings = await loadCustomerBookings(
            supabase,
            orgId,
            customerId,
          )
          const ids = next.bookings.map((booking) => booking.id)
          next.payments = (
            await Promise.all([
              loadCustomerPayments(supabase, orgId, ids, 'payments'),
              loadCustomerPayments(supabase, orgId, ids, 'booth_payments'),
            ])
          ).flat()
        } else
          next.vehicles = await loadCustomerVehicles(
            supabase,
            orgId,
            customerId,
          )
      }
      if (!cancelled) setResult(next)
    })().catch((error: unknown) => {
      if (!cancelled)
        setResult({
          key,
          customer: null,
          vehicles: [],
          bookings: [],
          payments: [],
          error:
            error instanceof Error
              ? error.message
              : 'Customer details could not be loaded.',
        })
    })
    return () => {
      cancelled = true
    }
  }, [orgId, customerId, books, key, allowed])
  const current = result?.key === key ? result : null
  if (loading) return <p role="status">Loading customer…</p>
  if (!allowed) return <p>A staff role is required to view customers.</p>
  if (!current) return <p role="status">Loading customer…</p>
  if (current.error)
    return (
      <p role="alert" className="text-destructive">
        {current.error}
      </p>
    )
  if (!current.customer)
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Customer not found</h1>
        <p>This customer is not available in your organization.</p>
        <Link to="/app/customers" className="underline">
          Back to Customer
        </Link>
      </div>
    )
  const customer = current.customer
  return (
    <div className="space-y-5">
      <nav
        aria-label="Customer navigation"
        className="flex flex-wrap gap-4 text-sm"
      >
        <Link to="/app/customers" className="underline underline-offset-4">
          Customer
        </Link>
        <Link
          to="/app/customers/$customerId"
          params={{ customerId }}
          className="underline underline-offset-4"
          aria-current={!books ? 'page' : undefined}
        >
          Customer ID
        </Link>
        <Link
          to="/app/customers/$customerId/books"
          params={{ customerId }}
          className="underline underline-offset-4"
          aria-current={books ? 'page' : undefined}
        >
          Books
        </Link>
      </nav>
      <PageHeader
        eyebrow={
          books
            ? 'Customer / Directory / Books'
            : 'Customer / Directory / Customer ID'
        }
        title={books ? `Books · ${customer.full_name}` : customer.full_name}
        description={`Customer ID: ${customer.id}`}
      />
      {!books ? (
        <>
          <SectionCard title="Contact">
            <dl className="grid gap-5 p-5 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Email</dt>
                <dd className="mt-1 break-all">
                  {customer.email || 'Not provided'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Phone</dt>
                <dd className="mt-1">{customer.phone || 'Not provided'}</dd>
              </div>
            </dl>
          </SectionCard>
          <SectionCard title="Vehicles">
            <div className="divide-y px-5">
              {current.vehicles.length ? (
                current.vehicles.map((vehicle) => (
                  <div
                    key={vehicle.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-4"
                  >
                    <p className="font-mono font-semibold">
                      {vehicle.license_plate || 'No plate recorded'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {[
                        vehicle.year,
                        vehicle.make,
                        vehicle.model,
                        vehicle.color,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'No vehicle details'}
                    </p>
                  </div>
                ))
              ) : (
                <p className="py-6 text-muted-foreground">
                  No vehicles recorded.
                </p>
              )}
            </div>
          </SectionCard>
        </>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                {[
                  'Booking Code',
                  'Start Date',
                  'End Date',
                  'Payment',
                  'Status',
                  'Check in/out',
                ].map((label) => (
                  <th key={label} className="px-4 py-3 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {current.bookings.map((booking) => {
                const facility = allFacilities.find(
                  (item) => item.id === booking.facility_id,
                )
                const { start, end } = parseTstzrange(booking.during)
                const format = (value: Date | string | null) =>
                  value
                    ? facility
                      ? formatInstantForFacility(value, facility.timezone)
                      : 'Facility timezone unavailable'
                    : '—'
                const payment = bookingPayment(
                  booking.total_cents,
                  current.payments.filter(
                    (row) => row.reservation_id === booking.id,
                  ),
                )
                return (
                  <tr
                    key={booking.id}
                    className="border-b last:border-0 align-top"
                  >
                    <td className="px-4 py-4">
                      <Link
                        to="/checkin/$bookingCode"
                        params={{ bookingCode: booking.booking_code }}
                        className="font-mono font-semibold underline-offset-4 hover:underline"
                      >
                        {booking.booking_code}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {facility?.name}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      {format(start)}
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {facility?.timezone}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      {end ? format(end) : 'Open-ended'}
                    </td>
                    <td className="px-4 py-4">
                      <p
                        className={
                          payment.due
                            ? 'font-medium text-destructive'
                            : 'font-medium'
                        }
                      >
                        {payment.due ? `${dollars(payment.due)} due` : 'Paid'}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dollars(payment.paid)} of{' '}
                        {dollars(booking.total_cents)} {booking.currency}
                      </p>
                      {payment.refunded && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Includes refunded payment
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-4 capitalize">
                      {booking.status.replaceAll('_', ' ')}
                    </td>
                    <td className="px-4 py-4">
                      <p>
                        {booking.checked_in_at
                          ? `In ${format(booking.checked_in_at)}`
                          : 'Not checked in'}
                      </p>
                      {booking.checked_out_at && (
                        <p>Out {format(booking.checked_out_at)}</p>
                      )}
                      <Link
                        to="/checkin/$bookingCode"
                        params={{ bookingCode: booking.booking_code }}
                        className="mt-1 inline-block text-xs underline underline-offset-4"
                      >
                        {booking.checked_out_at
                          ? 'Open'
                          : booking.checked_in_at
                            ? 'Check out'
                            : 'Check in'}
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {current.bookings.length === 0 && (
            <p className="p-8 text-center text-muted-foreground">
              No bookings for this customer.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
