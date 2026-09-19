// Runnable check for the operating-hours translation. The one that matters:
// public.enforce_reservation_operating_hours fires on EVERY write of a
// reservation window, so the message reaches walk-in check-in and extend, not
// only the two screens that translate it inline. Verified against the database
// with check_in_walk_in and extend_reservation, both of which raise
// OUTSIDE_OPERATING_HOURS; this pins the browser side of that contract.
// Run: node --test src/lib/errors.test.ts
import assert from 'node:assert/strict'
import { friendlyError } from './errors.ts'

const FALLBACK = 'Walk-in check-in failed. Please try again.'

// A PostgREST error carries the raise message; the shared map must translate it
// rather than letting a caller's generic fallback stand in for it.
const translated = friendlyError(
  { message: 'OUTSIDE_OPERATING_HOURS' },
  FALLBACK,
)
assert.notEqual(translated, FALLBACK)
assert.match(translated, /operating hours/)

// Extend passes a different fallback through the same helper.
assert.equal(
  friendlyError(
    { message: 'OUTSIDE_OPERATING_HOURS' },
    'The reservation could not be extended.',
  ),
  translated,
)

// Unrelated failures still fall through to the caller's own wording.
assert.equal(friendlyError({ message: 'SOMETHING_ELSE' }, FALLBACK), FALLBACK)

console.log('errors: all assertions passed')
