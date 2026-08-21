import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
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
import { useRole } from '@/hooks/useRole'
import { dollars } from '@/lib/format'
import { formatRange, parseTstzrange } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type Row = {
  id: string
  facility_id: string
  space_id: string
  during: string
  status: string
  total_cents: number
  currency: string
  space_number: string
  customer_name: string
  facility_name: string
}

const ANY = 'all'
const statuses = ['pending', 'confirmed', 'cancelled', 'no_show', 'completed']

export const Route = createFileRoute('/app/reservations')({
  component: StaffReservations,
})

function StaffReservations() {
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const [rows, setRows] = useState<Row[]>([])
  const [facilities, setFacilities] = useState<{ id: string; name: string }[]>([])
  const [statusFilter, setStatusFilter] = useState('pending')
  const [facilityFilter, setFacilityFilter] = useState(ANY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const allowed = role === 'admin' || role === 'manager' || role === 'attendant'

  const load = useCallback(async () => {
    if (!orgId || !allowed) return
    setLoading(true)
    setError(null)

    const [resResult, facResult] = await Promise.all([
      supabase
        .from('reservations')
        .select(
          'id, facility_id, space_id, customer_id, during, status, total_cents, currency',
        )
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase
        .from('facilities')
        .select('id, name')
        .eq('org_id', orgId)
        .order('name'),
    ])

    if (resResult.error || facResult.error) {
      setError(resResult.error?.message ?? facResult.error?.message ?? 'Load failed.')
      setLoading(false)
      return
    }

    const reservations = resResult.data ?? []
    const facilityRows = facResult.data ?? []
    setFacilities(facilityRows)
    const facilityName = new Map(facilityRows.map((f) => [f.id, f.name]))

    const spaceIds = [...new Set(reservations.map((r) => r.space_id))]
    const customerIds = [...new Set(reservations.map((r) => r.customer_id))]

    const [spaceRes, custRes] = await Promise.all([
      spaceIds.length
        ? supabase.from('spaces').select('id, space_number').in('id', spaceIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabase.from('customers').select('id, full_name').in('id', customerIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (spaceRes.error || custRes.error) {
      setError(spaceRes.error?.message ?? custRes.error?.message ?? 'Load failed.')
      setLoading(false)
      return
    }

    const spaceNumber = new Map((spaceRes.data ?? []).map((s) => [s.id, s.space_number]))
    const customerName = new Map((custRes.data ?? []).map((c) => [c.id, c.full_name]))

    setRows(
      reservations.map((r) => ({
        id: r.id,
        facility_id: r.facility_id,
        space_id: r.space_id,
        during: r.during,
        status: r.status,
        total_cents: r.total_cents,
        currency: r.currency,
        space_number: spaceNumber.get(r.space_id) ?? '—',
        customer_name: customerName.get(r.customer_id) ?? 'Unknown',
        facility_name: facilityName.get(r.facility_id) ?? 'Facility',
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
          Confirm, extend, or cancel bookings across your facilities.
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
                    <TableHead>Status</TableHead>
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
    </div>
  )
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
