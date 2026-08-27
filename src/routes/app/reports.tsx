import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Download } from 'lucide-react'
import { BarChart, LineChart } from '@/components/reports/Charts'
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
import { useRole } from '@/hooks/useRole'
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from '@/lib/csv'
import { friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { supabase } from '@/lib/supabase'

export const Route = createFileRoute('/app/reports')({
  component: Reports,
})

const ALL = 'all'

type Grain = 'day' | 'week' | 'month'

/** PostgREST returns numeric/int8 as strings; coerce everything at the edge. */
const num = (value: unknown): number => Number(value ?? 0) || 0

type RevenueRow = {
  bucket: string
  payments_count: number
  revenue_cents: number
  refunded_count: number
  stripe_payments_count: number
  stripe_revenue_cents: number
  booth_cash_payments_count: number
  booth_cash_revenue_cents: number
  booth_card_payments_count: number
  booth_card_revenue_cents: number
}
type OccupancyRow = {
  bucket: string
  held_hours: number
  space_hours: number
  occupancy_pct: number
}
type DurationRow = {
  completed_count: number
  avg_hours: number
  min_hours: number
  max_hours: number
}
type SpaceTypeRow = {
  space_type: string
  payments_count: number
  revenue_cents: number
  stripe_payments_count: number
  stripe_revenue_cents: number
  booth_cash_payments_count: number
  booth_cash_revenue_cents: number
  booth_card_payments_count: number
  booth_card_revenue_cents: number
}
type SplitRow = {
  category: string
  revenue_cents: number | null
  stripe_revenue_cents: number | null
  booth_cash_revenue_cents: number | null
  booth_card_revenue_cents: number | null
  recorded: boolean
  note: string | null
}

/** YYYY-MM-DD for a date input, in the viewer's own local calendar. */
function toDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function daysAgo(count: number): string {
  const date = new Date()
  date.setDate(date.getDate() - count)
  return toDateInput(date)
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

/** Section wrapper with its own CSV action, so each report exports on its own. */
function ReportSection({
  title,
  description,
  onDownload,
  downloadDisabled,
  children,
}: {
  title: string
  description: string
  onDownload: () => void
  downloadDisabled: boolean
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onDownload}
          disabled={downloadDisabled}
        >
          <Download data-icon="inline-start" />
          Download CSV
        </Button>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Reports() {
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const allowed = role === 'admin' || role === 'manager'

  const [facilities, setFacilities] = useState<{ id: string; name: string }[]>(
    [],
  )
  const [facilityId, setFacilityId] = useState<string>(ALL)
  const [from, setFrom] = useState(() => daysAgo(29))
  const [to, setTo] = useState(() => toDateInput(new Date()))
  const [grain, setGrain] = useState<Grain>('day')

  const [revenue, setRevenue] = useState<RevenueRow[]>([])
  const [occupancy, setOccupancy] = useState<OccupancyRow[]>([])
  const [duration, setDuration] = useState<DurationRow | null>(null)
  const [bySpaceType, setBySpaceType] = useState<SpaceTypeRow[]>([])
  const [split, setSplit] = useState<SplitRow[]>([])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!orgId || !allowed) return
    void supabase
      .from('facilities')
      .select('id, name')
      .eq('org_id', orgId)
      .is('archived_at', null)
      .order('name')
      .then(({ data }) => setFacilities(data ?? []))
  }, [orgId, allowed])

  const load = useCallback(async () => {
    if (!orgId || !allowed) return
    setLoading(true)
    setError(null)

    const scope = facilityId === ALL ? null : facilityId
    const args = { p_from: from, p_to: to, p_facility_id: scope }

    const [rev, occ, dur, types, sp] = await Promise.all([
      supabase.rpc('report_revenue_by_period', { ...args, p_grain: grain }),
      supabase.rpc('report_occupancy_by_day', args),
      supabase.rpc('report_avg_duration', args),
      supabase.rpc('report_revenue_by_space_type', args),
      supabase.rpc('report_revenue_split', args),
    ])

    const failed = [rev, occ, dur, types, sp].find((result) => result.error)
    if (failed?.error) {
      setError(friendlyError(failed.error, 'Reports could not be loaded.'))
      setLoading(false)
      return
    }

    setRevenue(
      (rev.data ?? []).map((r: RevenueRow) => ({
        bucket: r.bucket,
        payments_count: num(r.payments_count),
        revenue_cents: num(r.revenue_cents),
        refunded_count: num(r.refunded_count),
        stripe_payments_count: num(r.stripe_payments_count),
        stripe_revenue_cents: num(r.stripe_revenue_cents),
        booth_cash_payments_count: num(r.booth_cash_payments_count),
        booth_cash_revenue_cents: num(r.booth_cash_revenue_cents),
        booth_card_payments_count: num(r.booth_card_payments_count),
        booth_card_revenue_cents: num(r.booth_card_revenue_cents),
      })),
    )
    setOccupancy(
      (occ.data ?? []).map((r: OccupancyRow) => ({
        bucket: r.bucket,
        held_hours: num(r.held_hours),
        space_hours: num(r.space_hours),
        occupancy_pct: num(r.occupancy_pct),
      })),
    )
    const durationRow = (dur.data ?? [])[0] as DurationRow | undefined
    setDuration(
      durationRow
        ? {
            completed_count: num(durationRow.completed_count),
            avg_hours: num(durationRow.avg_hours),
            min_hours: num(durationRow.min_hours),
            max_hours: num(durationRow.max_hours),
          }
        : null,
    )
    setBySpaceType(
      (types.data ?? []).map((r: SpaceTypeRow) => ({
        space_type: r.space_type,
        payments_count: num(r.payments_count),
        revenue_cents: num(r.revenue_cents),
        stripe_payments_count: num(r.stripe_payments_count),
        stripe_revenue_cents: num(r.stripe_revenue_cents),
        booth_cash_payments_count: num(r.booth_cash_payments_count),
        booth_cash_revenue_cents: num(r.booth_cash_revenue_cents),
        booth_card_payments_count: num(r.booth_card_payments_count),
        booth_card_revenue_cents: num(r.booth_card_revenue_cents),
      })),
    )
    setSplit(
      (sp.data ?? []).map((r: SplitRow) => ({
        category: r.category,
        revenue_cents: r.revenue_cents === null ? null : num(r.revenue_cents),
        stripe_revenue_cents:
          r.stripe_revenue_cents === null ? null : num(r.stripe_revenue_cents),
        booth_cash_revenue_cents:
          r.booth_cash_revenue_cents === null
            ? null
            : num(r.booth_cash_revenue_cents),
        booth_card_revenue_cents:
          r.booth_card_revenue_cents === null
            ? null
            : num(r.booth_card_revenue_cents),
        recorded: Boolean(r.recorded),
        note: r.note,
      })),
    )
    setLoading(false)
  }, [orgId, allowed, facilityId, from, to, grain])

  useEffect(() => {
    // Deferred to a microtask, matching the other /app pages: calling load()
    // synchronously here would setState during the effect and cascade renders.
    if (!roleLoading) void Promise.resolve().then(load)
  }, [load, roleLoading])

  const revenueTotals = useMemo(
    () =>
      revenue.reduce(
        (sum, row) => ({
          total: sum.total + row.revenue_cents,
          stripe: sum.stripe + row.stripe_revenue_cents,
          cash: sum.cash + row.booth_cash_revenue_cents,
          boothCard: sum.boothCard + row.booth_card_revenue_cents,
        }),
        { total: 0, stripe: 0, cash: 0, boothCard: 0 },
      ),
    [revenue],
  )

  // Weighted across the whole range rather than averaging daily percentages,
  // which would over-weight days with fewer active spaces.
  const rangeOccupancy = useMemo(() => {
    const held = occupancy.reduce((sum, row) => sum + row.held_hours, 0)
    const capacity = occupancy.reduce((sum, row) => sum + row.space_hours, 0)
    return capacity > 0 ? (held / capacity) * 100 : 0
  }, [occupancy])

  const hourly = split.find((row) => row.category === 'hourly')
  const permit = split.find((row) => row.category === 'permit')
  const maxTypeCents = Math.max(...bySpaceType.map((r) => r.revenue_cents), 1)

  const download = <T,>(
    report: string,
    rows: T[],
    columns: CsvColumn<T>[],
  ): void => downloadCsv(csvFilename(report, from, to), toCsv(rows, columns))

  if (roleLoading) return <PageSpinner />

  if (!allowed) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Reports unavailable</CardTitle>
          <CardDescription>
            An admin or manager role is required.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Revenue and occupancy, grouped by each facility&rsquo;s own local
          calendar day.
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-5">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Facility
            <Select value={facilityId} onValueChange={setFacilityId}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All facilities</SelectItem>
                {facilities.map((facility) => (
                  <SelectItem key={facility.id} value={facility.id}>
                    {facility.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm tabular-nums"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            To
            <input
              type="date"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm tabular-nums"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Group by
            <Select
              value={grain}
              onValueChange={(value) => setGrain(value as Grain)}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Day</SelectItem>
                <SelectItem value="week">Week</SelectItem>
                <SelectItem value="month">Month</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <div className="flex gap-2">
            {(
              [
                ['7 days', 6],
                ['30 days', 29],
                ['90 days', 89],
              ] as const
            ).map(([label, back]) => (
              <Button
                key={label}
                size="sm"
                variant="outline"
                onClick={() => {
                  setFrom(daysAgo(back))
                  setTo(toDateInput(new Date()))
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Top-line numbers */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label="Total revenue"
          value={dollars(revenueTotals.total)}
          hint={
            loading ? 'Loading…' : 'Settled reservation payments, hourly only'
          }
        />
        <StatTile
          label="Online card"
          value={dollars(revenueTotals.stripe)}
          hint="Stripe-confirmed collection"
        />
        <StatTile
          label="Booth cash"
          value={dollars(revenueTotals.cash)}
          hint="Cash recorded by staff"
        />
        <StatTile
          label="Booth card"
          value={dollars(revenueTotals.boothCard)}
          hint="Card-terminal collection recorded by staff"
        />
        <StatTile
          label="Avg reservation"
          value={`${(duration?.avg_hours ?? 0).toFixed(2)} h`}
          hint={`${duration?.completed_count ?? 0} completed in range`}
        />
        <StatTile
          label="Occupancy"
          value={`${rangeOccupancy.toFixed(2)}%`}
          hint="Space-hours held vs. available"
        />
      </div>

      <ReportSection
        title="Revenue over time"
        description={`Settled payments per ${grain}, bucketed in facility-local time.`}
        downloadDisabled={revenue.length === 0}
        onDownload={() =>
          download('revenue', revenue, [
            { header: 'Bucket', value: (r) => r.bucket },
            { header: 'Payments', value: (r) => r.payments_count },
            { header: 'Revenue (cents)', value: (r) => r.revenue_cents },
            { header: 'Revenue', value: (r) => dollars(r.revenue_cents) },
            {
              header: 'Online payments',
              value: (r) => r.stripe_payments_count,
            },
            {
              header: 'Online revenue (cents)',
              value: (r) => r.stripe_revenue_cents,
            },
            {
              header: 'Booth cash payments',
              value: (r) => r.booth_cash_payments_count,
            },
            {
              header: 'Booth cash revenue (cents)',
              value: (r) => r.booth_cash_revenue_cents,
            },
            {
              header: 'Booth card payments',
              value: (r) => r.booth_card_payments_count,
            },
            {
              header: 'Booth card revenue (cents)',
              value: (r) => r.booth_card_revenue_cents,
            },
            { header: 'Refunded payments', value: (r) => r.refunded_count },
          ])
        }
      >
        <BarChart
          data={revenue.map((r) => ({
            label: r.bucket.slice(5),
            value: r.revenue_cents,
          }))}
          format={(value) => dollars(value)}
          ariaLabel={`Revenue per ${grain}`}
        />
      </ReportSection>

      <ReportSection
        title="Occupancy over time"
        description="Average percent of space-hours held each day. Counts space held, not cars present."
        downloadDisabled={occupancy.length === 0}
        onDownload={() =>
          download('occupancy', occupancy, [
            { header: 'Date', value: (r) => r.bucket },
            { header: 'Held hours', value: (r) => r.held_hours },
            { header: 'Space hours', value: (r) => r.space_hours },
            { header: 'Occupancy %', value: (r) => r.occupancy_pct },
          ])
        }
      >
        <LineChart
          data={occupancy.map((r) => ({
            label: r.bucket.slice(5),
            value: r.occupancy_pct,
          }))}
          format={(value) => `${value.toFixed(1)}%`}
          ariaLabel="Daily occupancy percent"
          yMax={100}
        />
      </ReportSection>

      <ReportSection
        title="Revenue by space type"
        description="Settled reservation payments, split by the type of space booked."
        downloadDisabled={bySpaceType.length === 0}
        onDownload={() =>
          download('revenue-by-space-type', bySpaceType, [
            { header: 'Space type', value: (r) => r.space_type },
            { header: 'Payments', value: (r) => r.payments_count },
            { header: 'Revenue (cents)', value: (r) => r.revenue_cents },
            { header: 'Revenue', value: (r) => dollars(r.revenue_cents) },
            {
              header: 'Online payments',
              value: (r) => r.stripe_payments_count,
            },
            {
              header: 'Online revenue (cents)',
              value: (r) => r.stripe_revenue_cents,
            },
            {
              header: 'Booth cash payments',
              value: (r) => r.booth_cash_payments_count,
            },
            {
              header: 'Booth cash revenue (cents)',
              value: (r) => r.booth_cash_revenue_cents,
            },
            {
              header: 'Booth card payments',
              value: (r) => r.booth_card_payments_count,
            },
            {
              header: 'Booth card revenue (cents)',
              value: (r) => r.booth_card_revenue_cents,
            },
          ])
        }
      >
        {bySpaceType.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No settled payments in this range.
          </p>
        ) : (
          <ul className="space-y-3">
            {bySpaceType.map((row) => (
              <li key={row.space_type} className="space-y-1">
                <div className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="font-medium capitalize">
                    {row.space_type}
                  </span>
                  <span className="tabular-nums">
                    {dollars(row.revenue_cents)}
                    <span className="ml-2 text-muted-foreground">
                      {row.payments_count} payment
                      {row.payments_count === 1 ? '' : 's'}
                    </span>
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Online {dollars(row.stripe_revenue_cents)} · cash{' '}
                  {dollars(row.booth_cash_revenue_cents)} · booth card{' '}
                  {dollars(row.booth_card_revenue_cents)}
                </p>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${(row.revenue_cents / maxTypeCents) * 100}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </ReportSection>

      <ReportSection
        title="Permits vs. hourly"
        description="How settled revenue splits between hourly bookings and monthly permits."
        downloadDisabled={split.length === 0}
        onDownload={() =>
          download('permits-vs-hourly', split, [
            { header: 'Category', value: (r) => r.category },
            {
              header: 'Revenue (cents)',
              value: (r) => (r.recorded ? r.revenue_cents : ''),
            },
            {
              header: 'Revenue',
              value: (r) => (r.recorded ? dollars(r.revenue_cents ?? 0) : ''),
            },
            {
              header: 'Online revenue (cents)',
              value: (r) => (r.recorded ? r.stripe_revenue_cents : ''),
            },
            {
              header: 'Booth cash revenue (cents)',
              value: (r) => (r.recorded ? r.booth_cash_revenue_cents : ''),
            },
            {
              header: 'Booth card revenue (cents)',
              value: (r) => (r.recorded ? r.booth_card_revenue_cents : ''),
            },
            { header: 'Recorded', value: (r) => String(r.recorded) },
            { header: 'Note', value: (r) => r.note ?? '' },
          ])
        }
      >
        <dl className="space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-sm font-medium">
              Hourly &amp; walk-in
              <p className="mt-1 text-xs font-normal text-muted-foreground">
                Online {dollars(hourly?.stripe_revenue_cents ?? 0)} · cash{' '}
                {dollars(hourly?.booth_cash_revenue_cents ?? 0)} · booth card{' '}
                {dollars(hourly?.booth_card_revenue_cents ?? 0)}
              </p>
            </dt>
            <dd className="text-lg font-semibold tabular-nums">
              {dollars(hourly?.revenue_cents ?? 0)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t pt-4">
            <dt className="text-sm font-medium">
              Monthly permits
              <p className="mt-1 max-w-md text-xs font-normal text-muted-foreground">
                {permit?.note ??
                  'Not recorded - see known gap in ARCHITECTURE.md'}
                . Successful subscription charges are never written to the
                database, so this is excluded from the total revenue card rather
                than shown as zero.
              </p>
            </dt>
            <dd className="text-lg font-semibold text-muted-foreground">
              &mdash;
            </dd>
          </div>
        </dl>
      </ReportSection>
    </div>
  )
}
