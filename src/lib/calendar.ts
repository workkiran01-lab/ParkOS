import {
  FacilityTimeError,
  facilityInputToUtc,
  instantToFacilityInput,
} from './facility-time.ts'
import { parseTstzrange } from './holds.ts'

export type CalendarView = 'month' | 'week'
type Schedule =
  | 'closed'
  | '24_hours'
  | { type?: string; open?: string; close?: string }
  | null
export type OperatingHours = {
  type: string
  open?: string
  close?: string
  days?: Record<string, Schedule>
} | null
export type CalendarDay = { date: string; start: number; end: number }

/** Calendar arithmetic is on date labels in UTC, never on the machine's clock. */
export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function shiftMonth(date: string, months: number) {
  const value = new Date(`${date.slice(0, 7)}-01T12:00:00Z`)
  value.setUTCMonth(value.getUTCMonth() + months)
  return value.toISOString().slice(0, 10)
}

export function facilityToday(timeZone: string, now = new Date()) {
  return instantToFacilityInput(now, timeZone).slice(0, 10)
}

export function dayStart(date: string, timeZone: string) {
  // Some IANA zones advance at midnight, or skip a date entirely.
  for (let minute = 0; minute <= 1440; minute++) {
    const label =
      minute === 1440
        ? `${shiftDate(date, 1)}T00:00`
        : `${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    try {
      return Date.parse(facilityInputToUtc(label, timeZone))
    } catch (error) {
      if (
        !(error instanceof FacilityTimeError) ||
        error.code !== 'NONEXISTENT_TIME'
      )
        throw error
    }
  }
  throw new Error('Unable to find the start of this facility day.')
}

export function calendarDays(
  anchor: string,
  view: CalendarView,
  timeZone: string,
): CalendarDay[] {
  const first = view === 'month' ? `${anchor.slice(0, 7)}-01` : anchor
  const weekday = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7
  const start = shiftDate(first, -weekday)
  const count =
    view === 'week'
      ? 7
      : Math.ceil(
          (weekday + Number(shiftDate(shiftMonth(first, 1), -1).slice(8))) / 7,
        ) * 7
  return Array.from({ length: count }, (_, index) => {
    const date = shiftDate(start, index)
    return {
      date,
      start: dayStart(date, timeZone),
      end: dayStart(shiftDate(date, 1), timeZone),
    }
  })
}

export function segmentForDay(during: string, day: CalendarDay) {
  const { start, end } = parseTstzrange(during)
  const from = Math.max(start?.getTime() ?? -Infinity, day.start)
  const until = Math.min(end?.getTime() ?? Infinity, day.end)
  return from < until
    ? {
        start: from,
        end: until,
        continuesBefore: from > (start?.getTime() ?? -Infinity),
        continuesAfter: until < (end?.getTime() ?? Infinity),
      }
    : null
}

function scheduleFor(date: string, hours: OperatingHours): Schedule {
  if (!hours || hours.type === '24_hours') return '24_hours'
  if (hours.type !== 'weekly') return hours
  return (
    hours.days?.[
      ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][
        new Date(`${date}T12:00:00Z`).getUTCDay()
      ]
    ] ?? 'closed'
  )
}

function scheduleBoundary(local: string, timeZone: string) {
  try {
    return Date.parse(facilityInputToUtc(local, timeZone, 'later'))
  } catch (error) {
    if (
      !(error instanceof FacilityTimeError) ||
      error.code !== 'NONEXISTENT_TIME'
    )
      throw error
    // PostgreSQL interprets a skipped wall time using the pre-transition offset.
    const wall = Date.parse(`${local}:00Z`)
    for (let minute = 1; minute <= 1440; minute++) {
      const previous = new Date(wall - minute * 60_000)
        .toISOString()
        .slice(0, 16)
      try {
        return (
          Date.parse(facilityInputToUtc(previous, timeZone, 'later')) +
          minute * 60_000
        )
      } catch (prior) {
        if (
          !(prior instanceof FacilityTimeError) ||
          prior.code !== 'NONEXISTENT_TIME'
        )
          throw prior
      }
    }
    throw error
  }
}

export function openingIntervals(
  day: CalendarDay,
  hours: OperatingHours,
  timeZone: string,
) {
  const intervals: { start: number; end: number }[] = []
  for (const date of [shiftDate(day.date, -1), day.date]) {
    const schedule = scheduleFor(date, hours)
    if (
      !schedule ||
      schedule === 'closed' ||
      (typeof schedule === 'object' && schedule.type === 'closed')
    )
      continue
    let start: number, end: number
    if (
      schedule === '24_hours' ||
      (typeof schedule === 'object' && schedule.type === '24_hours')
    ) {
      start = dayStart(date, timeZone)
      end = dayStart(shiftDate(date, 1), timeZone)
    } else if (
      typeof schedule === 'object' &&
      schedule.open &&
      schedule.close
    ) {
      start = scheduleBoundary(`${date}T${schedule.open}`, timeZone)
      end = scheduleBoundary(
        `${schedule.close > schedule.open ? date : shiftDate(date, 1)}T${schedule.close}`,
        timeZone,
      )
    } else {
      throw new Error('The facility operating hours are invalid.')
    }
    start = Math.max(start, day.start)
    end = Math.min(end, day.end)
    if (start < end) intervals.push({ start, end })
  }
  return intervals
    .sort((a, b) => a.start - b.start)
    .reduce<{ start: number; end: number }[]>((merged, interval) => {
      const last = merged.at(-1)
      if (last && interval.start <= last.end)
        last.end = Math.max(last.end, interval.end)
      else merged.push({ ...interval })
      return merged
    }, [])
}

export function clockLabel(instant: number, timeZone: string) {
  return new Date(instant).toLocaleTimeString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

export function dayLabel(
  date: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  },
) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    ...options,
    timeZone: 'UTC',
  })
}
