/**
 * Daily Manifest — the Booking section's operational sheet for one facility on
 * one day: everything scheduled to arrive or depart, with what is still owed.
 *
 * WHY THIS EXISTS SEPARATELY FROM /app/reservations. That page is the org-wide
 * reservation ledger: every facility, every status, 500 rows deep, built for
 * looking a booking up and acting on it administratively. This is a shift
 * document — one facility, one day, ordered by arrival time, with a direct path
 * to the check-in screen for each row. The two tables overlap in columns and
 * neither is redundant; deleting this one would mean an attendant filtering an
 * org-wide ledger down by hand at the start of every shift.
 */
import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { formatInZone } from '@/lib/checkin'
import { friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type ManifestRow = {
  reservation_id: string
  booking_code: string
  customer_name: string
  space_number: string
  zone_name: string
  starts_at: string
  ends_at: string | null
  status: string
  kind: 'arriving' | 'departing' | 'turnaround'
  total_cents: number
  paid_cents: number
  balance_cents: number
  currency: string
  checked_in_at: string | null
  checked_out_at: string | null
}

export const Route = createFileRoute('/app/booking/manifest')({
  component: DailyManifest,
})

/** Today on the FACILITY's clock as a yyyy-mm-dd input value, not the browser's. */
function todayInZone(timezone: string) {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone })
}

function DailyManifest() {
  const { role, loading: roleLoading } = useRole()
  const { facilities, facilityId, loading: facilitiesLoading } = useFacility()
  const [date, setDate] = useState('')
  const [rows, setRows] = useState<ManifestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const allowed = role === 'admin' || role === 'manager' || role === 'attendant'
  const facility = facilities.find((option) => option.id === facilityId)
  const timezone = facility?.timezone || 'UTC'

  // The date defaults to the selected facility's local today, and follows it
  // when the facility changes — two lots in different zones can disagree on
  // what "today" is, and the sheet should open on the right one.
  useEffect(() => {
    if (facility)
      void Promise.resolve().then(() => setDate(todayInZone(facility.timezone)))
  }, [facility])

  const load = useCallback(async () => {
    if (!facilityId || !allowed || !date) return
    setLoading(true)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc(
      'facility_daily_manifest',
      { p_facility_id: facilityId, p_date: date },
    )
    if (rpcError) {
      setError(
        friendlyError(rpcError, 'The manifest could not be loaded.'),
      )
      setRows([])
    } else {
      setRows((data ?? []) as ManifestRow[])
    }
    setLoading(false)
  }, [allowed, date, facilityId])

  useEffect(() => {
    if (!roleLoading) void Promise.resolve().then(load)
  }, [load, roleLoading])

  if (roleLoading || facilitiesLoading) return <PageSpinner />
  if (!allowed)
    return (
      <p className="text-sm text-muted-foreground">
        You do not have access to the daily manifest.
      </p>
    )

  const arriving = rows.filter((row) => row.kind !== 'departing').length
  const departing = rows.filter((row) => row.kind !== 'arriving').length
  const owed = rows.reduce((sum, row) => sum + row.balance_cents, 0)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Daily manifest</CardTitle>
          <CardDescription>
            Bookings scheduled to arrive or depart at{' '}
            {facility?.name ?? 'this facility'} on the selected day, on the
            facility&rsquo;s local clock.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Date">
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              />
            </Field>
            {facility && (
              <button
                type="button"
                onClick={() => setDate(todayInZone(facility.timezone))}
                className="h-9 rounded-md border border-border px-3 text-sm hover:bg-muted"
              >
                Today
              </button>
            )}
          </div>

          {!facilityId ? (
            <p className="py-6 text-center text-muted-foreground">
              Select a facility to see its manifest.
            </p>
          ) : (
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>
                <strong className="text-foreground">{arriving}</strong> arriving
              </span>
              <span>
                <strong className="text-foreground">{departing}</strong>{' '}
                departing
              </span>
              <span>
                <strong className="text-foreground">{dollars(owed)}</strong>{' '}
                outstanding
              </span>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {loading ? (
            <p className="py-6 text-center text-muted-foreground">Loading…</p>
          ) : !facilityId ? null : rows.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              Nothing scheduled to arrive or depart on this day.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Booking</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>End</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Check in/out</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.reservation_id}>
                      <TableCell>
                        <p className="font-mono text-xs font-medium">
                          {row.booking_code}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {row.customer_name} &middot; {row.zone_name}{' '}
                          {row.space_number}
                        </p>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatInZone(row.starts_at, timezone)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatInZone(row.ends_at, timezone)}
                      </TableCell>
                      <TableCell>
                        {row.balance_cents === 0 ? (
                          <Badge variant="secondary">Paid</Badge>
                        ) : (
                          <Badge variant="destructive">
                            {dollars(row.balance_cents)} due
                          </Badge>
                        )}
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {dollars(row.paid_cents)} of{' '}
                          {dollars(row.total_cents)} {row.currency}
                        </p>
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
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {label(row.kind)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <CheckStatus row={row} timezone={timezone} />
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

/**
 * Check-in and check-out both already live on /checkin/$bookingCode, which also
 * collects the balance. This column reports state and hands off there rather
 * than duplicating those actions.
 */
function CheckStatus({
  row,
  timezone,
}: {
  row: ManifestRow
  timezone: string
}) {
  const state = row.checked_out_at
    ? `Out ${formatInZone(row.checked_out_at, timezone)}`
    : row.checked_in_at
      ? `In ${formatInZone(row.checked_in_at, timezone)}`
      : 'Not checked in'
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{state}</p>
      <Link
        to="/checkin/$bookingCode"
        params={{ bookingCode: row.booking_code }}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {row.checked_out_at ? 'Open' : row.checked_in_at ? 'Check out' : 'Check in'}
        <ArrowRight className="size-3" aria-hidden="true" />
      </Link>
    </div>
  )
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
