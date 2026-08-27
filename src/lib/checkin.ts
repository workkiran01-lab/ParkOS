// Pure booth-screen logic: what state a scanned ticket is in, and how its
// times read on the lot's own clock. No Supabase import — the data access for
// this screen lives in `attendant.ts` — so these stay runnable under
// `node --test` (which is why the one dependency below is a relative path
// rather than the `@/` alias the app code uses; node resolves no tsconfig
// paths).
import { parseTstzrange } from './holds.ts'

/**
 * What the booth sees after scanning a ticket. Every value is a distinct
 * screen, not a shade of "error": an attendant standing at a raised gate needs
 * to know which of these six situations they are in at a glance.
 */
export type CheckinState =
  | 'unknown' // no reservation with that code is visible to this org
  | 'archived' // the row exists but has been archived
  | 'ready' // pending/confirmed — check them in
  | 'checked_in' // active — collect, then check them out
  | 'completed' // already checked out
  | 'cancelled' // cancelled or no_show — nothing to admit

type Classifiable = { status: string; archived_at: string | null }

/**
 * Archived wins over status: an archived reservation must never present a
 * check-in button, whatever state it was in when it was archived.
 */
export function checkinState(
  row: Classifiable,
): Exclude<CheckinState, 'unknown'> {
  if (row.archived_at) return 'archived'
  switch (row.status) {
    case 'pending':
    case 'confirmed':
      return 'ready'
    case 'active':
      return 'checked_in'
    case 'completed':
      return 'completed'
    default:
      // cancelled, no_show, and anything a later migration adds. Refusing entry
      // is the safe default for a status this screen does not recognise.
      return 'cancelled'
  }
}

/**
 * Render an instant in the FACILITY's timezone, never the browser's.
 *
 * A booth tablet can be set to the wrong zone, and a support laptop opening the
 * same screen from another state certainly is. The reserved window means the
 * lot's local wall clock, so that is what gets printed.
 */
export function formatInZone(
  value: Date | string | null,
  timezone: string,
): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (!date || Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  })
}

/** The reserved window, both bounds on the facility's clock. */
export function formatWindowInZone(during: string, timezone: string): string {
  const bound = (date: Date | null) =>
    date ? formatInZone(date, timezone) : '∞'
  const { start, end } = parseTstzrange(during)
  return `${bound(start)} → ${bound(end)}`
}

/**
 * How far past the reserved end a vehicle is, as a coarse "2h 15m".
 *
 * Elapsed time is a difference between two instants, so it needs no timezone —
 * only the money does, and that is priced in the database. Returns null while
 * the vehicle is still inside its window: the ordinary case should show
 * nothing, not "0m over".
 */
export function overstayElapsed(during: string, now: Date): string | null {
  const { end } = parseTstzrange(during)
  if (!end) return null
  const ms = now.getTime() - end.getTime()
  if (ms <= 0) return null
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}
