import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { PageHeader } from '@/components/layout/PagePrimitives'
import { Button } from '@/components/ui/button'
import { useFacility } from '@/hooks/useFacility'
import { useRole } from '@/hooks/useRole'
import {
  calendarDays,
  clockLabel,
  dayLabel,
  facilityToday,
  openingIntervals,
  segmentForDay,
  shiftDate,
  shiftMonth,
  type CalendarDay,
  type CalendarView,
  type OperatingHours,
} from '@/lib/calendar'
import {
  loadCalendarFacility,
  loadCalendarReservations,
  type ReservationRecord,
} from '@/lib/reservation-queries'
import { supabase } from '@/lib/supabase'

export const Route = createFileRoute('/app/calendar')({ component: Calendar })

function Calendar() {
  const { org_id: orgId, role, loading: roleLoading } = useRole()
  const { facilityId, facilities, loading: facilitiesLoading } = useFacility()
  const facility = facilities.find((item) => item.id === facilityId)
  const [anchor, setAnchor] = useState<{
    facilityId: string
    date: string
  } | null>(null)
  const [view, setView] = useState<CalendarView>('month')
  const [snapshot, setSnapshot] = useState<{
    key: string
    rows: ReservationRecord[]
    hours: OperatingHours
  } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    message: string
  } | null>(null)
  const allowed = role === 'admin' || role === 'manager' || role === 'attendant'
  const timezone = facility?.timezone ?? ''
  const range = useMemo(() => {
    if (!facility) return { days: [], date: '', error: '' }
    try {
      const date =
        anchor?.facilityId === facilityId
          ? anchor.date
          : facilityToday(timezone)
      return { days: calendarDays(date, view, timezone), date, error: '' }
    } catch (error) {
      return {
        days: [],
        date: '',
        error:
          error instanceof Error ? error.message : 'Invalid facility timezone.',
      }
    }
  }, [facility, facilityId, timezone, anchor, view])
  const start = range.days[0]?.start
  const end = range.days.at(-1)?.end
  const key = `${orgId}/${facilityId}/${start}/${end}`
  useEffect(() => {
    if (
      !allowed ||
      !orgId ||
      !facilityId ||
      start === undefined ||
      end === undefined
    )
      return
    let cancelled = false
    void Promise.all([
      loadCalendarFacility(supabase, orgId, facilityId),
      loadCalendarReservations(
        supabase,
        orgId,
        facilityId,
        new Date(start).toISOString(),
        new Date(end).toISOString(),
      ),
    ])
      .then(([record, rows]) => {
        if (cancelled) return
        if (!record) throw new Error('This facility is no longer available.')
        setSnapshot({
          key,
          rows,
          hours: record.operating_hours as OperatingHours,
        })
        setFailure(null)
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setFailure({
            key,
            message:
              error instanceof Error
                ? error.message
                : 'The calendar could not be loaded.',
          })
      })
    return () => {
      cancelled = true
    }
  }, [allowed, orgId, facilityId, start, end, key])

  if (roleLoading || facilitiesLoading)
    return <p role="status">Loading calendar…</p>
  if (!allowed) return <p>A staff role is required to view the calendar.</p>
  const current = snapshot?.key === key ? snapshot : null
  const error = range.error || (failure?.key === key ? failure.message : '')
  const chooseDate = (date: string) => setAnchor({ facilityId, date })
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Reservations"
        title="Calendar"
        description={
          facility
            ? `${facility.name} · ${timezone}. All dates and times use the facility clock.`
            : 'Choose a facility to see its reservations.'
        }
      />
      {!facility ? (
        <p>No active facilities are available.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                aria-label="Previous period"
                disabled={!range.date}
                onClick={() =>
                  chooseDate(
                    view === 'month'
                      ? shiftMonth(range.date, -1)
                      : shiftDate(range.date, -7),
                  )
                }
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                onClick={() => chooseDate(facilityToday(timezone))}
                disabled={!!range.error}
              >
                Today
              </Button>
              <Button
                variant="outline"
                aria-label="Next period"
                disabled={!range.date}
                onClick={() =>
                  chooseDate(
                    view === 'month'
                      ? shiftMonth(range.date, 1)
                      : shiftDate(range.date, 7),
                  )
                }
              >
                <ChevronRight className="size-4" />
              </Button>
              <h2 className="px-2 text-lg font-semibold">
                {range.date &&
                  (view === 'month'
                    ? dayLabel(range.date, { month: 'long', year: 'numeric' })
                    : `${dayLabel(range.days[0].date)} – ${dayLabel(range.days[6].date)}`)}
              </h2>
              <label className="sr-only" htmlFor="calendar-date">
                Calendar date
              </label>
              <input
                id="calendar-date"
                type="date"
                className="rounded-md border bg-card px-2 py-1.5 text-sm"
                value={range.date}
                onChange={(event) => {
                  if (event.target.value) chooseDate(event.target.value)
                }}
              />
            </div>
            <div className="flex gap-1" aria-label="Calendar view">
              {(['month', 'week'] as const).map((mode) => (
                <Button
                  key={mode}
                  variant={view === mode ? 'default' : 'outline'}
                  aria-pressed={view === mode}
                  onClick={() => setView(mode)}
                >
                  {mode === 'month' ? 'Month' : 'Week'}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Shaded periods are closed. Existing bookings remain visible outside
            operating hours. Repeated hours include their timezone abbreviation.
          </p>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : !current ? (
            <p role="status">Loading reservations…</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <div
                className={
                  view === 'week'
                    ? 'grid min-w-[1120px] grid-cols-7'
                    : 'grid min-w-[770px] grid-cols-7'
                }
              >
                {range.days.map((day) => (
                  <Day
                    key={day.date}
                    day={day}
                    view={view}
                    rows={current.rows}
                    hours={current.hours}
                    timezone={timezone}
                    currentMonth={range.date.slice(0, 7)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Day({
  day,
  view,
  rows,
  hours,
  timezone,
  currentMonth,
}: {
  day: CalendarDay
  view: CalendarView
  rows: ReservationRecord[]
  hours: OperatingHours
  timezone: string
  currentMonth: string
}) {
  const open = openingIntervals(day, hours, timezone)
  const events = rows
    .flatMap((row) => {
      const segment = segmentForDay(row.during, day)
      return segment ? [{ row, ...segment, lane: 0 }] : []
    })
    .sort(
      (a, b) =>
        a.start - b.start || a.end - b.end || a.row.id.localeCompare(b.row.id),
    )
  const lanes: number[] = []
  for (const event of events) {
    let lane = lanes.findIndex((until) => until <= event.start)
    if (lane === -1) lane = lanes.length
    lanes[lane] = event.end
    event.lane = lane
  }
  const continuous =
    open.length === 1 && open[0].start === day.start && open[0].end === day.end
  const hoursLabel = !open.length
    ? 'Closed'
    : continuous
      ? 'Open 24 hours'
      : open
          .map(
            (interval) =>
              `${clockLabel(interval.start, timezone)} – ${interval.end === day.end ? 'midnight' : clockLabel(interval.end, timezone)}`,
          )
          .join(', ')
  const slotHeight = 52
  return (
    <section
      aria-label={day.date}
      className={`min-w-0 border-b border-r ${!open.length ? 'bg-muted/70' : ''} ${view === 'month' && day.date.slice(0, 7) !== currentMonth ? 'text-muted-foreground' : ''}`}
    >
      <header
        className={`${view === 'week' ? 'min-h-24' : 'min-h-16'} border-b p-2.5`}
      >
        <h3 className="text-xs font-semibold">{dayLabel(day.date)}</h3>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          {hoursLabel}
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          {events.length} booking{events.length === 1 ? '' : 's'}
        </p>
      </header>
      {view === 'month' ? (
        <div className="min-h-16 space-y-1 p-1.5">
          {events.map((event) => (
            <Booking
              key={event.row.id}
              event={event}
              timezone={timezone}
              outside={
                !open.some(
                  (interval) =>
                    interval.start <= event.start && interval.end >= event.end,
                )
              }
            />
          ))}
        </div>
      ) : (
        <div
          className="relative bg-muted/80"
          style={{ height: ((day.end - day.start) / 3_600_000) * slotHeight }}
        >
          {open.map((interval) => (
            <div
              key={interval.start}
              className="absolute inset-x-0 bg-card"
              aria-hidden="true"
              style={{
                top: ((interval.start - day.start) / 3_600_000) * slotHeight,
                height:
                  ((interval.end - interval.start) / 3_600_000) * slotHeight,
              }}
            />
          ))}
          {Array.from(
            { length: Math.ceil((day.end - day.start) / 3_600_000) },
            (_, index) => (
              <div
                key={index}
                className="absolute inset-x-0 border-t border-border/70 px-1 text-[9px] text-muted-foreground"
                style={{ top: index * slotHeight }}
                aria-label={clockLabel(day.start + index * 3_600_000, timezone)}
              >
                {clockLabel(day.start + index * 3_600_000, timezone)}
              </div>
            ),
          )}
          {events.map((event) => (
            <div
              key={event.row.id}
              className="absolute overflow-auto px-0.5"
              style={{
                top: ((event.start - day.start) / 3_600_000) * slotHeight,
                height: Math.max(
                  25,
                  ((event.end - event.start) / 3_600_000) * slotHeight,
                ),
                left: `${(event.lane / lanes.length) * 100}%`,
                width: `${100 / lanes.length}%`,
              }}
            >
              <Booking
                event={event}
                timezone={timezone}
                outside={
                  !open.some(
                    (interval) =>
                      interval.start <= event.start &&
                      interval.end >= event.end,
                  )
                }
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Booking({
  event,
  timezone,
  outside,
}: {
  event: {
    row: ReservationRecord
    start: number
    end: number
    continuesBefore: boolean
    continuesAfter: boolean
  }
  timezone: string
  outside: boolean
}) {
  return (
    <Link
      to="/checkin/$bookingCode"
      params={{ bookingCode: event.row.booking_code }}
      className="block rounded border border-primary/20 bg-background px-1.5 py-1 text-[10px] leading-4 shadow-sm hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={`Booking ${event.row.booking_code}`}
    >
      <span className="block break-all font-mono font-semibold text-foreground">
        {event.row.booking_code}
      </span>
      <span className="block">
        {event.continuesBefore ? 'Continues · ' : ''}
        {clockLabel(event.start, timezone)}
        {event.continuesAfter
          ? ' · continues'
          : ` – ${clockLabel(event.end, timezone)}`}
      </span>
      <span className="block capitalize text-muted-foreground">
        {event.row.status.replaceAll('_', ' ')}
        {outside ? ' · outside hours' : ''}
      </span>
    </Link>
  )
}
