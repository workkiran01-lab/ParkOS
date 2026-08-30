import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
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
import { useFacility } from '@/hooks/useFacility'
import { useRole } from '@/hooks/useRole'
import { friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { rangeContainsNow, type SpaceStatus } from '@/lib/holds'
import {
  deriveTileStatus,
  tileStatuses,
  tileStatusClasses,
  tileStatusLabel,
  tileStatusSwatch,
  type ActiveHold,
  type TileStatus,
} from '@/lib/occupancy'
import { supabase } from '@/lib/supabase'

type Zone = { id: string; name: string; level: number | null }
type Space = {
  id: string
  zone_id: string
  space_number: string
  status: SpaceStatus
}
type Hold = {
  space_id: string
  hold_type: ActiveHold['hold_type']
  during: string
  reservation_id: string | null
}
type ListRow = {
  reservation_id: string
  space_number: string
  zone_name: string
  customer_name: string
  when: string | null
  during: string
}
type OverstayRow = ListRow & { ends_at: string }
type RevenueBreakdown = {
  total: number
  stripe: number
  cash: number
  boothCard: number
}

export const Route = createFileRoute('/app/occupancy')({
  component: Occupancy,
})

function Occupancy() {
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const { facilities, error: facilitiesError } = useFacility()
  const [facilityId, setFacilityId] = useState('')

  const [zones, setZones] = useState<Zone[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [holds, setHolds] = useState<Hold[]>([])
  const [reservationStatus, setReservationStatus] = useState<
    Map<string, string>
  >(new Map())
  const [occupantByReservation, setOccupantByReservation] = useState<
    Map<string, string>
  >(new Map())
  const [revenue, setRevenue] = useState<RevenueBreakdown>({
    total: 0,
    stripe: 0,
    cash: 0,
    boothCard: 0,
  })
  const [arrivals, setArrivals] = useState<ListRow[]>([])
  const [departures, setDepartures] = useState<ListRow[]>([])
  const [overstays, setOverstays] = useState<OverstayRow[]>([])

  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const allowed = role === 'admin' || role === 'manager' || role === 'attendant'

  useEffect(() => {
    if (roleLoading || !allowed) return
    void Promise.resolve().then(() => {
      if (facilitiesError) {
        setError(
          friendlyError(facilitiesError, 'Facilities could not be loaded.'),
        )
      }
      setFacilityId((current) => current || (facilities[0]?.id ?? ''))
    })
  }, [allowed, facilities, facilitiesError, roleLoading])

  // One snapshot load for the selected facility: the grid building blocks
  // (zones, spaces, active holds, and the reservations/customers those holds
  // reference) plus the time-sensitive aggregates that are awkward client-side
  // (revenue in facility-local time, today's arrivals/departures, overstays).
  const loadFacility = useCallback(async (id: string) => {
    if (!id) return
    setLoading(true)
    setError(null)

    const zonesResult = await supabase
      .from('zones')
      .select('id, name, level')
      .eq('facility_id', id)
      .is('archived_at', null)
      .order('level', { ascending: true, nullsFirst: true })
      .order('name')

    if (zonesResult.error) {
      setError(friendlyError(zonesResult.error, 'Zones could not be loaded.'))
      setLoading(false)
      return
    }
    const zoneRows = (zonesResult.data ?? []) as Zone[]
    const zoneIds = zoneRows.map((z) => z.id)

    const spacesResult = zoneIds.length
      ? await supabase
          .from('spaces')
          .select('id, zone_id, space_number, status')
          .in('zone_id', zoneIds)
          .is('archived_at', null)
          .order('space_number')
      : { data: [], error: null }

    if (spacesResult.error) {
      setError(friendlyError(spacesResult.error, 'Spaces could not be loaded.'))
      setLoading(false)
      return
    }
    const spaceRows = (spacesResult.data ?? []) as Space[]
    const spaceIds = spaceRows.map((s) => s.id)

    const holdsResult = spaceIds.length
      ? await supabase
          .from('space_holds')
          .select('space_id, hold_type, during, reservation_id')
          .in('space_id', spaceIds)
          .is('released_at', null)
      : { data: [], error: null }

    if (holdsResult.error) {
      setError(friendlyError(holdsResult.error, 'Holds could not be loaded.'))
      setLoading(false)
      return
    }
    const holdRows = (holdsResult.data ?? []) as Hold[]

    // Reservation status (occupied vs reserved) + occupant name come from the
    // reservations these holds reference. Only reservation-type holds matter.
    const reservationIds = [
      ...new Set(
        holdRows
          .filter((h) => h.reservation_id)
          .map((h) => h.reservation_id as string),
      ),
    ]
    const resResult = reservationIds.length
      ? await supabase
          .from('reservations')
          .select('id, status, customer_id')
          .in('id', reservationIds)
      : { data: [], error: null }

    if (resResult.error) {
      setError(
        friendlyError(resResult.error, 'Reservations could not be loaded.'),
      )
      setLoading(false)
      return
    }
    const resRows = (resResult.data ?? []) as {
      id: string
      status: string
      customer_id: string
    }[]
    const customerIds = [...new Set(resRows.map((r) => r.customer_id))]
    const custResult = customerIds.length
      ? await supabase
          .from('customers')
          .select('id, full_name')
          .in('id', customerIds)
      : { data: [], error: null }

    if (custResult.error) {
      setError(
        friendlyError(custResult.error, 'Customers could not be loaded.'),
      )
      setLoading(false)
      return
    }
    const custName = new Map(
      (custResult.data ?? []).map((c) => [c.id, c.full_name as string]),
    )
    const resStatus = new Map(resRows.map((r) => [r.id, r.status]))
    const occupant = new Map(
      resRows.map((r) => [r.id, custName.get(r.customer_id) ?? 'Unknown']),
    )

    // Aggregates + lists straight from the Week 11 RPCs (facility-local time).
    const [summary, arr, dep, over] = await Promise.all([
      supabase.rpc('facility_dashboard_summary', { p_facility_id: id }),
      supabase.rpc('facility_today_arrivals', { p_facility_id: id }),
      supabase.rpc('facility_today_departures', { p_facility_id: id }),
      supabase.rpc('facility_overstays', { p_facility_id: id }),
    ])

    const firstError =
      summary.error ?? arr.error ?? dep.error ?? over.error ?? null
    if (firstError) {
      setError(
        friendlyError(firstError, 'Dashboard metrics could not be loaded.'),
      )
      setLoading(false)
      return
    }

    setZones(zoneRows)
    setSpaces(spaceRows)
    setHolds(holdRows)
    setReservationStatus(resStatus)
    setOccupantByReservation(occupant)
    const revenueRow = summary.data?.[0]
    setRevenue({
      total: Number(revenueRow?.today_revenue_cents ?? 0),
      stripe: Number(revenueRow?.today_stripe_revenue_cents ?? 0),
      cash: Number(revenueRow?.today_booth_cash_revenue_cents ?? 0),
      boothCard: Number(revenueRow?.today_booth_card_revenue_cents ?? 0),
    })
    setArrivals(
      (arr.data ?? []).map((r: Record<string, unknown>) => ({
        reservation_id: r.reservation_id as string,
        space_number: r.space_number as string,
        zone_name: r.zone_name as string,
        customer_name: r.customer_name as string,
        when: r.checked_in_at as string,
        during: r.during as string,
      })),
    )
    setDepartures(
      (dep.data ?? []).map((r: Record<string, unknown>) => ({
        reservation_id: r.reservation_id as string,
        space_number: r.space_number as string,
        zone_name: r.zone_name as string,
        customer_name: r.customer_name as string,
        when: r.checked_out_at as string,
        during: r.during as string,
      })),
    )
    setOverstays(
      (over.data ?? []).map((r: Record<string, unknown>) => ({
        reservation_id: r.reservation_id as string,
        space_number: r.space_number as string,
        zone_name: r.zone_name as string,
        customer_name: r.customer_name as string,
        when: r.checked_in_at as string,
        during: r.during as string,
        ends_at: r.ends_at as string,
      })),
    )
    setLoading(false)
  }, [])

  useEffect(() => {
    if (facilityId) void Promise.resolve().then(() => loadFacility(facilityId))
  }, [facilityId, loadFacility])

  // Realtime: a check-in/checkout/booking elsewhere writes space_holds (and
  // occasionally spaces), so subscribe to both, scoped by org_id — the only
  // facility-independent column these tables share (neither carries
  // facility_id). Any relevant change re-pulls this facility's snapshot
  // (debounced), which is simpler and race-free versus patching local state,
  // and picks up the referenced reservation/customer rows the event omits.
  // Supabase Realtime applies the subscriber's RLS, so only this org's changes
  // are ever delivered. The effect re-subscribes when facilityId changes (fresh
  // closure) and unsubscribes cleanly on unmount / facility change.
  useEffect(() => {
    if (!orgId || !facilityId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void loadFacility(facilityId)
      }, 250)
    }
    const channel = supabase
      .channel(`occupancy-${facilityId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'space_holds',
          filter: `org_id=eq.${orgId}`,
        },
        debounced,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'spaces',
          filter: `org_id=eq.${orgId}`,
        },
        debounced,
      )
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [orgId, facilityId, loadFacility])

  // Per-space active hold covering *now* (exclusion constraint guarantees ≤ 1).
  const activeHoldBySpace = useMemo(() => {
    const map = new Map<string, ActiveHold & { occupant: string | null }>()
    for (const h of holds) {
      if (!rangeContainsNow(h.during)) continue
      map.set(h.space_id, {
        hold_type: h.hold_type,
        reservationStatus: h.reservation_id
          ? (reservationStatus.get(h.reservation_id) ?? null)
          : null,
        occupant: h.reservation_id
          ? (occupantByReservation.get(h.reservation_id) ?? null)
          : null,
      })
    }
    return map
  }, [holds, reservationStatus, occupantByReservation])

  const tileStatusBySpace = useMemo(() => {
    const map = new Map<string, TileStatus>()
    for (const s of spaces)
      map.set(s.id, deriveTileStatus(s.status, activeHoldBySpace.get(s.id)))
    return map
  }, [spaces, activeHoldBySpace])

  // Headline numbers are derived from the live grid (single source of truth, so
  // a realtime tile flip and the headline can never disagree). "Held" = any
  // active hold covering now — the same definition facility_dashboard_summary
  // uses, so this matches the SQL on load and then tracks live edits.
  const total = spaces.length
  const heldNow = useMemo(
    () => spaces.reduce((n, s) => n + (activeHoldBySpace.has(s.id) ? 1 : 0), 0),
    [spaces, activeHoldBySpace],
  )
  const occupancyPct =
    total === 0 ? 0 : Math.round((heldNow / total) * 1000) / 10

  const spacesByZone = useMemo(() => {
    const map = new Map<string, Space[]>()
    for (const s of spaces) {
      const list = map.get(s.zone_id) ?? []
      list.push(s)
      map.set(s.zone_id, list)
    }
    return map
  }, [spaces])

  const selectedSpace = selectedSpaceId
    ? spaces.find((s) => s.id === selectedSpaceId)
    : undefined
  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones])

  if (roleLoading) return <PageSpinner />

  if (!allowed) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Occupancy unavailable</CardTitle>
          <CardDescription>A staff role is required.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Occupancy</h1>
          <p className="mt-1 text-muted-foreground">
            Live map of every space — updates as vehicles check in and out.
          </p>
        </div>
        {facilities.length > 1 && (
          <Select value={facilityId} onValueChange={setFacilityId}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {facilities.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Glanceable numbers (§18). Static-per-refresh counts — no sparklines. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Occupied"
          value={`${heldNow} / ${total}`}
          hint="spaces held now"
        />
        <StatTile
          label="Occupancy"
          value={`${occupancyPct}%`}
          hint="of active spaces"
        />
        <StatTile
          label="Today's revenue"
          value={dollars(revenue.total)}
          hint={`online ${dollars(revenue.stripe)} · cash ${dollars(revenue.cash)} · booth card ${dollars(revenue.boothCard)}`}
        />
      </div>

      {loading && spaces.length === 0 ? (
        <PageSpinner />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
          {/* Spatial grid (§17): tiles by status, grouped by zone. */}
          <Card>
            <CardHeader>
              <CardTitle>Space map</CardTitle>
              <CardDescription>
                Click a space for its number and current occupant.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Legend />
              {selectedSpace && (
                <SelectedDetail
                  space={selectedSpace}
                  zoneName={zoneById.get(selectedSpace.zone_id)?.name ?? '—'}
                  status={
                    tileStatusBySpace.get(selectedSpace.id) ?? 'available'
                  }
                  occupant={
                    activeHoldBySpace.get(selectedSpace.id)?.occupant ?? null
                  }
                  onClose={() => setSelectedSpaceId(null)}
                />
              )}
              {zones.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground">
                  This facility has no zones yet.
                </p>
              ) : (
                zones.map((zone) => {
                  const zoneSpaces = spacesByZone.get(zone.id) ?? []
                  if (zoneSpaces.length === 0) return null
                  return (
                    <div key={zone.id}>
                      <h3 className="sticky top-14 z-10 -mx-1 mb-2 bg-background/95 px-1 py-1 text-sm font-semibold backdrop-blur">
                        {zone.name}
                        {zone.level != null && (
                          <span className="ml-2 font-normal text-muted-foreground">
                            Level {zone.level}
                          </span>
                        )}
                        <span className="ml-2 font-normal text-muted-foreground">
                          ({zoneSpaces.length})
                        </span>
                      </h3>
                      <div className="flex flex-wrap gap-1.5">
                        {zoneSpaces.map((space) => {
                          const status =
                            tileStatusBySpace.get(space.id) ?? 'available'
                          const occupant =
                            activeHoldBySpace.get(space.id)?.occupant ?? null
                          return (
                            <button
                              key={space.id}
                              type="button"
                              onClick={() =>
                                setSelectedSpaceId((cur) =>
                                  cur === space.id ? null : space.id,
                                )
                              }
                              title={
                                occupant
                                  ? `${space.space_number} — ${occupant}`
                                  : `${space.space_number} — ${tileStatusLabel[status]}`
                              }
                              aria-label={`Space ${space.space_number}, ${tileStatusLabel[status]}`}
                              className={`flex h-11 w-11 items-center justify-center rounded-md border text-[10px] font-medium tabular-nums transition ${
                                tileStatusClasses[status]
                              } ${
                                selectedSpaceId === space.id
                                  ? 'ring-2 ring-ring ring-offset-1'
                                  : ''
                              }`}
                            >
                              {space.space_number}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })
              )}
            </CardContent>
          </Card>

          {/* Arrivals / departures / overstays. */}
          <div className="space-y-6">
            <OverstaysCard rows={overstays} />
            <ListCard
              title="Today's arrivals"
              empty="No check-ins today."
              rows={arrivals}
              timeLabel="in"
            />
            <ListCard
              title="Today's departures"
              empty="No check-outs today."
              rows={departures}
              timeLabel="out"
            />
          </div>
        </div>
      )}
    </div>
  )
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}) {
  return (
    <Card>
      <CardContent className="py-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
          {value}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {tileStatuses.map((status) => (
        <span key={status} className="flex items-center gap-1.5">
          <span className={`size-3 rounded-sm ${tileStatusSwatch[status]}`} />
          {tileStatusLabel[status]}
        </span>
      ))}
    </div>
  )
}

function SelectedDetail({
  space,
  zoneName,
  status,
  occupant,
  onClose,
}: {
  space: Space
  zoneName: string
  status: TileStatus
  occupant: string | null
  onClose: () => void
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold tabular-nums">{space.space_number}</span>
        <span className="text-muted-foreground">{zoneName}</span>
        <span className="flex items-center gap-1.5">
          <span className={`size-2.5 rounded-sm ${tileStatusSwatch[status]}`} />
          {tileStatusLabel[status]}
        </span>
        {occupant && <span>Occupant: {occupant}</span>}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Clear selection"
      >
        ✕
      </button>
    </div>
  )
}

function OverstaysCard({ rows }: { rows: OverstayRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Overstays
          {rows.length > 0 && (
            <span className="rounded-full bg-status-occupied/20 px-2 py-0.5 text-xs font-semibold text-status-occupied">
              {rows.length}
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Active reservations past their end time, not yet checked out.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">None. All clear.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.reservation_id} className="text-sm">
                <Link
                  to="/app/reservations"
                  className="flex items-baseline justify-between gap-2 rounded-md border border-status-occupied/40 bg-status-occupied/10 px-2.5 py-1.5 hover:bg-status-occupied/20"
                >
                  <span className="font-medium text-status-occupied">
                    {row.space_number} · {row.customer_name}
                  </span>
                  <span className="whitespace-nowrap text-xs text-status-occupied/90">
                    due {shortTime(row.ends_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ListCard({
  title,
  empty,
  rows,
  timeLabel,
}: {
  title: string
  empty: string
  rows: ListRow[]
  timeLabel: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.reservation_id}
                className="flex items-baseline justify-between gap-2 text-sm"
              >
                <span>
                  <span className="font-medium tabular-nums">
                    {row.space_number}
                  </span>{' '}
                  <span className="text-muted-foreground">
                    {row.customer_name}
                  </span>
                </span>
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {timeLabel} {shortTime(row.when)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function shortTime(iso: string | null) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}
