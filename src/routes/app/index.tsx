import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowRight,
  CalendarClock,
  CarFront,
  CircleAlert,
  CircleDollarSign,
  Clock3,
  Gauge,
  LogIn,
  ParkingCircle,
  Plus,
  Radio,
  ReceiptText,
  Sparkles,
} from 'lucide-react'
import {
  EmptyState,
  MetricCard,
  PageHeader,
  SectionCard,
  StatusIndicator,
} from '@/components/layout/PagePrimitives'
import { Button } from '@/components/ui/button'
import { useFacility } from '@/hooks/useFacility'
import {
  type ConnectionStatus,
  useDashboardConnection,
} from '@/hooks/useDashboardConnection'
import { useRole } from '@/hooks/useRole'
import { friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/app/')({ component: Dashboard })

type Summary = {
  total_spaces: number
  held_now: number
  occupancy_pct: number
  today_revenue_cents: number
}
type Zone = { id: string; name: string; level: number | null }
type Space = {
  id: string
  zone_id: string
  space_number: string
  status: string
}
type Hold = { space_id: string; hold_type: string }
type Arrival = {
  reservation_id: string
  customer_name: string
  space_number: string
  zone_name: string
  checked_in_at: string
}
type Overstay = {
  reservation_id: string
  customer_name: string
  space_number: string
  ends_at: string
}
type Reservation = {
  id: string
  booking_code: string
  customer_id: string
  space_id: string
  during: string
  status: string
  created_at: string
  customer?: string
  space?: string
}

function Dashboard() {
  // Remounting on facility change clears dashboard state without a reset effect.
  const { facilityId } = useFacility()
  return <DashboardView key={facilityId} />
}

function DashboardView() {
  const { full_name: fullName, org_id: orgId, error: roleError } = useRole()
  const { facilities, facilityId, loading: facilitiesLoading } = useFacility()
  const facility = facilities.find((item) => item.id === facilityId)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [zones, setZones] = useState<Zone[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [holds, setHolds] = useState<Hold[]>([])
  const [arrivals, setArrivals] = useState<Arrival[]>([])
  const [overstays, setOverstays] = useState<Overstay[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [realtimeStatus, setRealtimeStatus] =
    useState<ConnectionStatus>('connecting')
  const { setConnection } = useDashboardConnection()

  const loadDashboard = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    const [
      summaryResult,
      zonesResult,
      arrivalsResult,
      overstaysResult,
      reservationsResult,
    ] = await Promise.all([
      supabase.rpc('facility_dashboard_summary', { p_facility_id: id }),
      supabase
        .from('zones')
        .select('id, name, level')
        .eq('facility_id', id)
        .is('archived_at', null)
        .order('level', { ascending: true, nullsFirst: true })
        .order('name'),
      supabase.rpc('facility_today_arrivals', { p_facility_id: id }),
      supabase.rpc('facility_overstays', { p_facility_id: id }),
      supabase
        .from('reservations')
        .select(
          'id, booking_code, customer_id, space_id, during, status, created_at',
        )
        .eq('facility_id', id)
        .order('created_at', { ascending: false })
        .limit(5),
    ])
    const firstError =
      summaryResult.error ??
      zonesResult.error ??
      arrivalsResult.error ??
      overstaysResult.error ??
      reservationsResult.error
    if (firstError) {
      setError(friendlyError(firstError, 'Dashboard data could not be loaded.'))
      setLoading(false)
      return
    }
    const zoneRows = (zonesResult.data ?? []) as Zone[]
    const zoneIds = zoneRows.map((zone) => zone.id)
    const spacesResult = zoneIds.length
      ? await supabase
          .from('spaces')
          .select('id, zone_id, space_number, status')
          .in('zone_id', zoneIds)
          .is('archived_at', null)
          .order('space_number')
      : { data: [], error: null }
    if (spacesResult.error) {
      setError(
        friendlyError(spacesResult.error, 'Space map could not be loaded.'),
      )
      setLoading(false)
      return
    }
    const spaceRows = (spacesResult.data ?? []) as Space[]
    const spaceIds = spaceRows.map((space) => space.id)
    const holdsResult = spaceIds.length
      ? await supabase
          .from('space_holds')
          .select('space_id, hold_type')
          .in('space_id', spaceIds)
          .is('released_at', null)
          .contains('during', new Date().toISOString())
      : { data: [], error: null }
    const reservationRows = (reservationsResult.data ?? []) as Reservation[]
    const customerIds = [
      ...new Set(reservationRows.map((row) => row.customer_id)),
    ]
    const reservationSpaceIds = [
      ...new Set(reservationRows.map((row) => row.space_id)),
    ]
    const [customersResult, reservationSpacesResult] = await Promise.all([
      customerIds.length
        ? supabase
            .from('customers')
            .select('id, full_name')
            .in('id', customerIds)
        : Promise.resolve({ data: [], error: null }),
      reservationSpaceIds.length
        ? supabase
            .from('spaces')
            .select('id, space_number')
            .in('id', reservationSpaceIds)
        : Promise.resolve({ data: [], error: null }),
    ])
    const customerMap = new Map(
      (customersResult.data ?? []).map((row) => [
        row.id as string,
        row.full_name as string,
      ]),
    )
    const spaceMap = new Map(
      (reservationSpacesResult.data ?? []).map((row) => [
        row.id as string,
        row.space_number as string,
      ]),
    )
    setSummary(
      (summaryResult.data?.[0] as Summary | undefined) ?? {
        total_spaces: 0,
        held_now: 0,
        occupancy_pct: 0,
        today_revenue_cents: 0,
      },
    )
    setZones(zoneRows)
    setSpaces(spaceRows)
    setHolds((holdsResult.data ?? []) as Hold[])
    setArrivals((arrivalsResult.data ?? []) as Arrival[])
    setOverstays((overstaysResult.data ?? []) as Overstay[])
    setReservations(
      reservationRows.map((row) => ({
        ...row,
        customer: customerMap.get(row.customer_id),
        space: spaceMap.get(row.space_id),
      })),
    )
    if (holdsResult.error) {
      setError(
        friendlyError(
          holdsResult.error,
          'Live space status is temporarily unavailable.',
        ),
      )
    } else {
      setUpdatedAt(Date.now())
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (facilityId) void Promise.resolve().then(() => loadDashboard(facilityId))
  }, [facilityId, loadDashboard])
  useEffect(() => {
    if (!orgId || !facilityId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void loadDashboard(facilityId), 250)
    }
    const channel = supabase
      .channel(`dashboard-${facilityId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'space_holds',
          filter: `org_id=eq.${orgId}`,
        },
        refresh,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'spaces',
          filter: `org_id=eq.${orgId}`,
        },
        refresh,
      )
      .subscribe((subscriptionStatus) => {
        if (subscriptionStatus === 'SUBSCRIBED') {
          setRealtimeStatus('live')
        } else if (subscriptionStatus === 'TIMED_OUT') {
          setRealtimeStatus('stale')
        } else if (
          subscriptionStatus === 'CHANNEL_ERROR' ||
          subscriptionStatus === 'CLOSED'
        ) {
          setRealtimeStatus('unavailable')
        }
      })
    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [orgId, facilityId, loadDashboard])

  const connectionStatus: ConnectionStatus =
    error || roleError
      ? updatedAt
        ? 'stale'
        : 'unavailable'
      : loading && !updatedAt
        ? 'connecting'
        : updatedAt && realtimeStatus === 'live'
          ? 'live'
          : updatedAt
            ? 'stale'
            : realtimeStatus

  useEffect(() => {
    setConnection(connectionStatus, updatedAt)
    return () => setConnection('unavailable', null)
  }, [connectionStatus, setConnection, updatedAt])

  const heldIds = useMemo(
    () => new Set(holds.map((hold) => hold.space_id)),
    [holds],
  )
  const spacesByZone = useMemo(() => {
    const map = new Map<string, Space[]>()
    spaces.forEach((space) =>
      map.set(space.zone_id, [...(map.get(space.zone_id) ?? []), space]),
    )
    return map
  }, [spaces])
  const greeting = greetingForNow()
  const available = summary
    ? Math.max(summary.total_spaces - summary.held_now, 0)
    : null

  if (!facilitiesLoading && facilities.length === 0)
    return (
      <div className="mx-auto max-w-3xl pt-8">
        <SectionCard title="Your workspace is ready for a facility">
          <EmptyState
            icon={Sparkles}
            title="Complete the initial setup"
            description="Create your first facility, zones, and spaces to begin live operations."
          />
          <div className="flex justify-center border-t p-4">
            <Button asChild>
              <Link to="/app/onboarding">
                Start onboarding <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </SectionCard>
      </div>
    )

  return (
    <div className="dashboard-root mx-auto w-full min-w-0 max-w-[1480px] space-y-5">
      <PageHeader
        eyebrow="Live operations"
        title={`${greeting}${fullName ? `, ${firstName(fullName)}` : ''}`}
        description={
          facility
            ? `${facility.name} operations at a glance.`
            : 'Select a facility to view live operations.'
        }
        actions={
          <>
            <Button variant="outline" className="h-9 px-3" asChild>
              <Link to="/app/reservations">
                <Plus className="size-4" />
                New reservation
              </Link>
            </Button>
            <Button className="h-9 px-3" asChild>
              <Link to="/attendant">
                <LogIn className="size-4" />
                Check in
              </Link>
            </Button>
          </>
        }
      />
      {(error || roleError) && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-card px-4 py-3 text-sm text-destructive"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{error ?? roleError}</span>
            <StatusIndicator status={connectionStatus} updatedAt={updatedAt} />
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Occupied spaces"
          value={
            <NumberFeedback value={summary?.held_now ?? null}>
              {loading && !summary ? '—' : (summary?.held_now ?? '—')}
            </NumberFeedback>
          }
          hint={
            summary
              ? `${summary.occupancy_pct}% of active capacity`
              : 'Awaiting facility data'
          }
          icon={CarFront}
          tone="occupied"
        />
        <MetricCard
          label="Available spaces"
          value={
            <NumberFeedback value={available}>
              {loading && !summary ? '—' : (available ?? '—')}
            </NumberFeedback>
          }
          hint={
            summary
              ? `${summary.total_spaces} spaces in service`
              : 'Awaiting facility data'
          }
          icon={ParkingCircle}
          tone="available"
        />
        <MetricCard
          label="Today’s arrivals"
          value={
            <NumberFeedback value={arrivals.length}>
              {loading && !summary ? '—' : arrivals.length}
            </NumberFeedback>
          }
          hint="Checked in today, local time"
          icon={CalendarClock}
        />
        <MetricCard
          label="Today’s revenue"
          value={
            <NumberFeedback value={summary?.today_revenue_cents ?? null}>
              {loading && !summary
                ? '—'
                : dollars(summary?.today_revenue_cents ?? 0)}
            </NumberFeedback>
          }
          hint="Succeeded payments today"
          icon={CircleDollarSign}
          tone="revenue"
        />
      </div>

      <div className="grid grid-cols-12 gap-4">
        <SectionCard
          title="Live occupancy"
          description="A compact view of every active parking space"
          action={
            <div className="flex items-center gap-3">
              <StatusIndicator
                status={connectionStatus}
                updatedAt={updatedAt}
              />
              <Link
                to="/app/occupancy"
                className="text-xs font-semibold text-primary underline-offset-4 hover:underline"
              >
                Open map
              </Link>
            </div>
          }
          className="col-span-12 xl:col-span-8"
        >
          <div className="p-4 sm:p-5">
            <div className="mb-3.5 flex flex-wrap gap-3 text-[11px] text-muted-foreground/75">
              <Legend tone="available" label="Available" />
              <Legend tone="occupied" label="Occupied" />
              <Legend tone="reserved" label="Reserved" />
              <Legend tone="maintenance" label="Unavailable" />
            </div>
            {zones.length === 0 && !loading ? (
              <EmptyState
                icon={ParkingCircle}
                title="No spaces configured"
                description="Add zones and spaces to see a live occupancy map."
              />
            ) : (
              <div className="space-y-4">
                {zones.map((zone) => {
                  const zoneSpaces = spacesByZone.get(zone.id) ?? []
                  if (!zoneSpaces.length) return null
                  return (
                    <div key={zone.id}>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-bold">
                          {zone.name}
                          {zone.level != null && (
                            <span className="ml-2 font-normal text-muted-foreground/75">
                              Level {zone.level}
                            </span>
                          )}
                        </p>
                        <span className="font-data text-[10px] text-muted-foreground/75">
                          {zoneSpaces.length} spaces
                        </span>
                      </div>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(46px,1fr))] gap-1.5">
                        {zoneSpaces.map((space) => {
                          const tone = spaceTone(space, heldIds.has(space.id))
                          return (
                            <div
                              key={`${space.id}-${tone}`}
                              className={cn(
                                'dashboard-space',
                                'dashboard-space-change',
                                `dashboard-space-${tone}`,
                              )}
                              title={`Space ${space.space_number}, ${tone}`}
                            >
                              <span>{space.space_number}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </SectionCard>

        <div className="col-span-12 space-y-4 xl:col-span-4">
          <SectionCard
            title="Needs attention"
            description="Overstays and operational alerts"
            action={
              overstays.length > 0 ? (
                <span className="rounded-sm border border-destructive/30 px-2 py-0.5 font-data text-[10px] font-semibold text-destructive">
                  {overstays.length}
                </span>
              ) : undefined
            }
          >
            {overstays.length === 0 ? (
              <EmptyState
                icon={CircleAlert}
                title="All clear"
                description="No active overstays at this facility."
              />
            ) : (
              <div className="divide-y">
                {overstays.slice(0, 4).map((row) => (
                  <div
                    key={row.reservation_id}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <span className="grid size-8 place-items-center rounded-md border border-destructive/25 text-destructive">
                      <Clock3 className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {row.customer_name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground/75">
                        Space {row.space_number} · ended{' '}
                        {formatTime(row.ends_at)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
          <SectionCard
            title="Quick actions"
            description="Common operator workflows"
          >
            <div className="grid grid-cols-2 gap-2 p-3">
              <QuickAction to="/attendant" icon={LogIn} label="Check in" />
              <QuickAction
                to="/app/reservations"
                icon={ReceiptText}
                label="Reserve"
              />
              <QuickAction to="/app/occupancy" icon={Gauge} label="Occupancy" />
              <QuickAction to="/app/reports" icon={Radio} label="Reports" />
            </div>
          </SectionCard>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <SectionCard
          title="Recent reservations"
          description="The latest bookings created for this facility"
          action={
            <Link
              to="/app/reservations"
              className="text-xs font-semibold text-primary underline-offset-4 hover:underline"
            >
              View all
            </Link>
          }
          className="col-span-12 lg:col-span-7"
        >
          {reservations.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No reservations yet"
              description="New reservations will appear here as they are created."
            />
          ) : (
            <div className="divide-y">
              {reservations.map((row) => (
                <div
                  key={row.id}
                  className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 sm:grid-cols-[1fr_120px_90px]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {row.customer ?? 'Customer'}{' '}
                      <span className="font-normal text-muted-foreground/75">
                        · Space {row.space ?? '—'}
                      </span>
                    </p>
                    <p className="mt-1 font-data text-[10px] text-muted-foreground/75">
                      {row.booking_code}
                    </p>
                  </div>
                  <p className="hidden text-xs text-muted-foreground/75 sm:block">
                    {formatRangeStart(row.during)}
                  </p>
                  <span className="justify-self-end rounded-sm border px-2 py-0.5 text-[10px] font-semibold capitalize">
                    {row.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
        <SectionCard
          title="Today’s activity"
          description="Completed arrivals at this facility"
          className="col-span-12 lg:col-span-5"
        >
          {arrivals.length === 0 ? (
            <EmptyState
              icon={CarFront}
              title="No arrivals yet"
              description="Today’s check-ins will appear here in real time."
            />
          ) : (
            <div className="divide-y">
              {arrivals.slice(0, 5).map((row) => (
                <div
                  key={row.reservation_id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <span className="relative grid size-8 place-items-center rounded-md border border-status-available/50 text-status-available">
                    <CarFront className="size-3.5" />
                    <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-2 border-card bg-status-available" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {row.customer_name}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground/75">
                      Space {row.space_number} · {row.zone_name}
                    </p>
                  </div>
                  <time className="font-data text-[10px] text-muted-foreground/75">
                    {formatTime(row.checked_in_at)}
                  </time>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  )
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0]
}
function NumberFeedback({
  value,
  children,
}: {
  value: number | null
  children: ReactNode
}) {
  return (
    <span key={value ?? 'empty'} className="inline-block">
      {children}
    </span>
  )
}
function greetingForNow() {
  const hour = new Date().getHours()
  return hour < 12
    ? 'Good morning'
    : hour < 18
      ? 'Good afternoon'
      : 'Good evening'
}
function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
function formatRangeStart(range: string) {
  const start = range.slice(1).split(',')[0].replace(/^"/, '')
  return start
    ? new Date(start).toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
      })
    : 'Scheduled'
}
function spaceTone(space: Space, held: boolean) {
  if (space.status === 'maintenance' || space.status === 'blocked')
    return 'maintenance'
  if (space.status === 'permit_assigned') return 'reserved'
  return held ? 'occupied' : 'available'
}
function Legend({ tone, label }: { tone: string; label: string }) {
  const code = tone === 'maintenance' ? 'X' : tone[0].toUpperCase()
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn('legend-marker', `legend-${tone}`)}
        aria-hidden="true"
      >
        {code}
      </span>
      {label}
    </span>
  )
}
function QuickAction({
  to,
  icon: Icon,
  label,
}: {
  to: '/attendant' | '/app/reservations' | '/app/occupancy' | '/app/reports'
  icon: typeof LogIn
  label: string
}) {
  return (
    <Link
      to={to}
      className="quick-action group flex min-h-16 flex-col justify-between rounded-md border bg-muted/20 p-3 text-xs font-semibold hover:border-foreground hover:bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Icon className="size-4 text-muted-foreground group-hover:text-primary" />
      <span className="flex items-center justify-between">
        {label}
        <ArrowRight className="size-3 text-muted-foreground" />
      </span>
    </Link>
  )
}
