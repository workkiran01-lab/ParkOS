// Runnable check for the permit cancellation outcome rules. The one that
// matters: a permit with a live Stripe subscription must NEVER report success
// when the Stripe call failed, and the browser must never claim a final
// cancellation for it — customer.subscription.deleted decides that.
// The database side is checked in
// supabase/dev-only/DEV_ONLY_verify_permit_cancellation.sql.
// Run: node --test src/lib/permit-cancel.test.ts
import assert from 'node:assert/strict'
import { isCancelling, permitCancelOutcome } from './permit-cancel.ts'

// Stripe failed: the exact regression this change exists to prevent. The old
// code showed a green "Permit cancelled" here.
const stripeFailed = permitCancelOutcome({ hasSubscription: true, stripeFailed: true })
assert.equal(stripeFailed.kind, 'error')
assert.equal(stripeFailed.cancelled, false)
assert.match(stripeFailed.message, /still active and still billing/)

// Recording the request failed, so nothing was ever sent to Stripe.
const intentFailed = permitCancelOutcome({ hasSubscription: true, intentFailed: true })
assert.equal(intentFailed.kind, 'error')
assert.equal(intentFailed.cancelled, false)
assert.match(intentFailed.message, /unchanged/)

// The happy path WITH a subscription is still not a completed cancellation.
const requested = permitCancelOutcome({ hasSubscription: true })
assert.equal(requested.kind, 'success')
assert.equal(requested.cancelled, false)

// No subscription: cancel_permit is the whole operation, so it is final.
const direct = permitCancelOutcome({ hasSubscription: false })
assert.equal(direct.kind, 'success')
assert.equal(direct.cancelled, true)

const directFailed = permitCancelOutcome({ hasSubscription: false, directFailed: true })
assert.equal(directFailed.kind, 'error')
assert.equal(directFailed.cancelled, false)

// Success is never reported while a subscription exists and Stripe failed,
// whatever the other flags say.
for (const intent of [true, false, undefined]) {
  const out = permitCancelOutcome({
    hasSubscription: true,
    intentFailed: intent,
    stripeFailed: true,
  })
  assert.equal(out.kind, 'error')
  assert.equal(out.cancelled, false)
}

// Cancelling badge: only while a request is outstanding and not yet final.
assert.equal(isCancelling('active', '2026-08-30T00:00:00Z'), true)
assert.equal(isCancelling('suspended', '2026-08-30T00:00:00Z'), true)
assert.equal(isCancelling('cancelled', '2026-08-30T00:00:00Z'), false)
assert.equal(isCancelling('active', null), false)

console.log('permit-cancel: all assertions passed')
