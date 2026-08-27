// Runnable check for the booth screen's two pure invariants:
//   (1) every reservation a scanned code can resolve to maps to exactly one
//       state, and archived always beats status — a screen that offered
//       "Check in" on an archived booking would admit a car that was never
//       supposed to be admitted;
//   (2) times print on the FACILITY's clock, not the browser's, so a booth
//       tablet set to the wrong zone still shows the driver the same window
//       their receipt shows.
// The overstay CHARGE is priced in the database and is checked there, in
// supabase/dev-only/20260825010000_verify_booth_payments.sql.
// Run: node --test src/lib/checkin.test.ts
import assert from 'node:assert/strict'
import {
  checkinState,
  formatInZone,
  formatWindowInZone,
  overstayElapsed,
} from './checkin.ts'

const live = (status: string) => ({ status, archived_at: null })

// --- booking_code lookup states -------------------------------------------

// Every value of the reservation_status enum lands somewhere deliberate.
assert.equal(checkinState(live('pending')), 'ready')
assert.equal(checkinState(live('confirmed')), 'ready')
assert.equal(checkinState(live('active')), 'checked_in')
assert.equal(checkinState(live('completed')), 'completed')
assert.equal(checkinState(live('cancelled')), 'cancelled')
assert.equal(checkinState(live('no_show')), 'cancelled')

// A status this build has never heard of must not fall through to "check them
// in". Refusing entry is the safe default.
assert.equal(checkinState(live('some_future_status')), 'cancelled')

// Archived outranks every status, including the ones that would otherwise
// offer a check-in or a check-out button.
for (const status of ['pending', 'confirmed', 'active', 'completed']) {
  assert.equal(
    checkinState({ status, archived_at: '2026-08-01T00:00:00Z' }),
    'archived',
    `archived ${status} must not present an action`,
  )
}

// --- facility timezone, not browser timezone ------------------------------

const instant = '2026-08-19T02:30:00Z'

// The same instant is the previous evening in Long Beach and mid-morning in
// Auckland. Whichever machine renders it, the facility's zone decides.
assert.match(formatInZone(instant, 'America/Los_Angeles'), /Aug 18, 2026, 7:30/)
assert.match(formatInZone(instant, 'Pacific/Auckland'), /Aug 19, 2026, 2:30/)
assert.notEqual(
  formatInZone(instant, 'America/Los_Angeles'),
  formatInZone(instant, 'America/New_York'),
)

// A window that crosses local midnight prints two different local dates.
const overnight = '["2026-08-19 04:00:00+00","2026-08-19 15:00:00+00")'
const window = formatWindowInZone(overnight, 'America/Los_Angeles')
assert.match(window, /Aug 18, 2026, 9:00\s?PM → Aug 19, 2026, 8:00\s?AM/)

// Unparseable input degrades to the em dash rather than "Invalid Date".
assert.equal(formatInZone(null, 'America/Los_Angeles'), '—')
assert.equal(formatInZone('not a date', 'America/Los_Angeles'), '—')
assert.equal(formatWindowInZone('garbage', 'America/Los_Angeles'), '∞ → ∞')

// --- how far past the reserved end ----------------------------------------

const ended = '["2026-08-19 04:00:00+00","2026-08-19 15:00:00+00")'
assert.equal(overstayElapsed(ended, new Date('2026-08-19T17:15:00Z')), '2h 15m')
assert.equal(overstayElapsed(ended, new Date('2026-08-19T15:20:00Z')), '20m')

// Inside the window, and exactly at the boundary, show nothing at all.
assert.equal(overstayElapsed(ended, new Date('2026-08-19T14:59:00Z')), null)
assert.equal(overstayElapsed(ended, new Date('2026-08-19T15:00:00Z')), null)

console.log('checkin: all assertions passed')
