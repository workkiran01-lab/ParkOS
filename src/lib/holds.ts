// Helpers for working with Postgres tstzrange values over the wire.
// Ranges are stored UTC (ARCHITECTURE.md) and rendered local at the edge.

export type SpaceType =
  | 'standard'
  | 'compact'
  | 'accessible'
  | 'ev'
  | 'oversized'
  | 'motorcycle'

export type SpaceStatus =
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'blocked'
  | 'maintenance'
  | 'permit_assigned'

export const spaceTypes: SpaceType[] = [
  'standard',
  'compact',
  'accessible',
  'ev',
  'oversized',
  'motorcycle',
]

export const spaceStatuses: SpaceStatus[] = [
  'available',
  'occupied',
  'reserved',
  'blocked',
  'maintenance',
  'permit_assigned',
]

export type ZoneRow = {
  id: string
  name: string
  level: number | null
  archived_at: string | null
}

export type SpaceRow = {
  id: string
  zone_id: string
  space_number: string
  space_type: SpaceType
  status: SpaceStatus
  archived_at: string | null
}

export type HoldRow = {
  id: string
  space_id: string
  hold_type: 'reservation' | 'permit' | 'maintenance' | 'block'
  during: string
  released_at: string | null
  created_at: string
}

/** Build a half-open `[start, end)` tstzrange literal from ISO timestamps. */
export function makeTstzrange(startIso: string, endIso: string) {
  return `[${startIso},${endIso})`
}

/** Parse Postgres tstzrange text (e.g. `["2026-08-19 10:00:00+00","2026-08-20 10:00:00+00")`).
 * An absent bound means unbounded and comes back null. */
export function parseTstzrange(value: string): {
  start: Date | null
  end: Date | null
} {
  const match = /^[[(]\s*("?)([^,"]*)\1\s*,\s*("?)([^,")\]]*)\3\s*[)\]]$/.exec(
    value,
  )
  if (!match) return { start: null, end: null }
  return { start: parseBound(match[2]), end: parseBound(match[4]) }
}

function parseBound(raw: string): Date | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'infinity' || trimmed === '-infinity') return null
  // Postgres emits "YYYY-MM-DD HH:MM:SS+TZ"; normalize toward ISO 8601 so every
  // browser's Date parser accepts it (space -> T, bare "+00" -> "+00:00").
  let iso = trimmed.replace(' ', 'T')
  if (/[+-]\d{2}$/.test(iso)) iso = `${iso}:00`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** True when the range (treated as [start, end)) contains this instant. */
export function rangeContainsNow(value: string) {
  const { start, end } = parseTstzrange(value)
  const now = Date.now()
  return (
    (start === null || start.getTime() <= now) &&
    (end === null || now < end.getTime())
  )
}

export function formatRange(value: string) {
  const { start, end } = parseTstzrange(value)
  const fmt = (date: Date | null) =>
    date
      ? date.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : '∞'
  return `${fmt(start)} → ${fmt(end)}`
}

/** The wizard's numbering: pad to >=3 digits, wider if the batch needs it. */
export function batchSpaceNumbers(
  prefix: string,
  startingNumber: number,
  count: number,
) {
  const width = Math.max(3, String(startingNumber + count - 1).length)
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(startingNumber + index).padStart(width, '0')}`,
  )
}
