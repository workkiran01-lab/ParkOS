const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

type LocalParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export class FacilityTimeError extends Error {
  readonly code: 'INVALID_TIMEZONE' | 'INVALID_LOCAL_TIME' | 'NONEXISTENT_TIME'

  constructor(
    message: string,
    code: 'INVALID_TIMEZONE' | 'INVALID_LOCAL_TIME' | 'NONEXISTENT_TIME',
  ) {
    super(message)
    this.name = 'FacilityTimeError'
    this.code = code
  }
}

/** True only when Intl recognizes the supplied IANA time-zone identifier. */
export function isValidIanaTimeZone(timeZone: string) {
  if (!timeZone || !timeZone.includes('/')) return timeZone === 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
    return true
  } catch {
    return false
  }
}

/** Format an instant for a datetime-local input using the facility's clock. */
export function instantToFacilityInput(
  instant: Date | string,
  timeZone: string,
) {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime())) {
    throw new FacilityTimeError(
      'Enter a valid date and time.',
      'INVALID_LOCAL_TIME',
    )
  }
  const parts = zonedParts(date.getTime(), timeZone)
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
}

/** Render a stored instant on the facility clock for operational UI. */
export function formatInstantForFacility(
  instant: Date | string,
  timeZone: string,
) {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime()) || !isValidIanaTimeZone(timeZone)) return '—'
  return date.toLocaleString(undefined, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/**
 * Convert a wall-clock value entered for a facility to a canonical UTC ISO
 * timestamp. A spring-forward gap is rejected. During a fall-back overlap,
 * the earlier occurrence is selected so the result is deterministic.
 */
export function facilityInputToUtc(localValue: string, timeZone: string) {
  const local = parseLocal(localValue)
  if (!isValidIanaTimeZone(timeZone)) {
    throw new FacilityTimeError(
      'The facility has an invalid timezone. Ask an administrator to correct it.',
      'INVALID_TIMEZONE',
    )
  }

  const wallClockUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  )
  const offsets = new Set<number>()

  // Sampling either side of the requested day captures both offsets at a DST
  // transition without relying on the browser machine's own timezone.
  for (const dayOffset of [-2, -1, 0, 1, 2]) {
    const sample = wallClockUtc + dayOffset * 86_400_000
    const shown = zonedParts(sample, timeZone)
    offsets.add(
      Date.UTC(
        shown.year,
        shown.month - 1,
        shown.day,
        shown.hour,
        shown.minute,
        shown.second,
      ) - sample,
    )
  }

  const matches = [...offsets]
    .map((offset) => wallClockUtc - offset)
    .filter((candidate) => sameParts(zonedParts(candidate, timeZone), local))
    .sort((left, right) => left - right)

  if (matches.length === 0) {
    throw new FacilityTimeError(
      'That local time does not exist because the facility clock moves forward. Choose another time.',
      'NONEXISTENT_TIME',
    )
  }

  return new Date(matches[0]).toISOString()
}

export function parseFacilityWindow(
  startValue: string,
  endValue: string,
  timeZone: string,
) {
  const startIso = facilityInputToUtc(startValue, timeZone)
  const endIso = facilityInputToUtc(endValue, timeZone)
  if (new Date(endIso) <= new Date(startIso)) {
    throw new FacilityTimeError(
      'Departure must be after arrival.',
      'INVALID_LOCAL_TIME',
    )
  }
  return { startIso, endIso }
}

function parseLocal(value: string): LocalParts {
  const match = LOCAL_DATETIME.exec(value)
  if (!match) {
    throw new FacilityTimeError(
      'Enter a valid date and time.',
      'INVALID_LOCAL_TIME',
    )
  }
  const [, year, month, day, hour, minute, second = '0'] = match
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  }
  const normalized = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  )
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59 ||
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day
  ) {
    throw new FacilityTimeError(
      'Enter a valid date and time.',
      'INVALID_LOCAL_TIME',
    )
  }
  return parts
}

function zonedParts(instantMs: number, timeZone: string): LocalParts {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    throw new FacilityTimeError(
      'The facility has an invalid timezone. Ask an administrator to correct it.',
      'INVALID_TIMEZONE',
    )
  }
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(instantMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  }
}

function sameParts(left: LocalParts, right: LocalParts) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  )
}

function pad(value: number, length = 2) {
  return String(value).padStart(length, '0')
}
