# Payment balance correction

Base: `origin/main` at `963ac933`. Branch: `fix/payment-balance`.
PR #9 remains a separate draft. No deployment or merge is part of this work.

## Root cause

Both reported overcharges share a settled-only balance model. The SQL balance,
the manifest's copied calculation, and Customer Books counted only rows whose
status was `succeeded`. Pending commitments disappeared from the calculation.
Changing a payment to `partially_refunded` also discarded its entire contribution;
the cumulative refunded amount was not stored at all.

On the unchanged baseline, a 1,000-cent pending payment left 1,000 cents
collectable, and a 1,000-cent payment followed by a 200-cent refund also left
1,000 cents collectable. Both actual `record_booth_payment(...,1000,'cash')`
calls succeeded. Fixtures were rolled back before applying the migration.

There was also a concurrency gap: the old reservation row lock did not change
the row version, allowing repeatable-read transactions to retain a stale ledger
snapshot. Online Checkout creation preceded the database payment insert, leaving
another window where payable online money was invisible to booth collection.

## Corrected contract

Collectable cents = max(booking total − retained settled money − pending online
commitments, 0). Retained online money = gross amount − cumulative confirmed
refund. Succeeded booth payments contribute their amount; refunded booth
payments contribute zero. A refund does not alter the booking price.

`reservation_payment_totals` is the single SQL calculation used by both
`reservation_balance_cents` and `facility_daily_manifest`. The manifest's
`paid_cents` is retained settled money; its `balance_cents` is collectable money.
Pending money reduces the latter without increasing the former. The helper is
security invoker and preserves tenant isolation.

Booth collection, new online claims, and Stripe processing serialize on a
versioned reservation row. A pending database claim is inserted before creating
Checkout. The Checkout amount is the current collectable remainder. Database
admission rechecks it under the lock. Signed completion can attach a Checkout
session even if its webhook arrives before the edge function saves the session ID.

Terminal `checkout.session.async_payment_failed` and `checkout.session.expired`
release the claim. A retryable `payment_intent.payment_failed` or `charge.failed`
does not: an open Checkout may still be paid. Confirmed expiry during Checkout
cleanup also releases the claim. A definite invalid-request rejection before
session creation releases it; ambiguous transport/server failures retain it.
Stripe documents [Checkout states](https://docs.stripe.com/api/checkout/sessions/object)
and that [expired sessions cannot be paid](https://docs.stripe.com/api/checkout/sessions/expire).

Customer Books uses the same arithmetic and distinguishes pending payments and
refunds needing reconciliation. The four medium UI findings below are unchanged.
The manifest labels an unpaid zero-collectable booking “Collection on hold”;
only retained settled money covering the total earns its “Paid” label.

## Independent cent oracles

Every expected amount in the SQL verifier is a literal derived from these raw
fixture rows. Neither balance reader supplies an expected value for the other.

| Case / raw ledger transition                           | Retained settled |   Pending | Collectable on a 1,000-cent booking |
| ------------------------------------------------------ | ---------------: | --------: | ----------------------------------: |
| A: online 1,000 pending; retryable decline             |                0 |     1,000 |                                   0 |
| A: terminal failure                                    |                0 |         0 |                               1,000 |
| A: collect 1,000 cash                                  |            1,000 |         0 |                                   0 |
| B: online 1,000 succeeded                              |            1,000 |         0 |                                   0 |
| B: cumulative refund 200                               |              800 |         0 |                                 200 |
| B: collect 200 cash                                    |            1,000 |         0 |                                   0 |
| B: older refund 100, then duplicate refund 200         |            1,000 |         0 |                                   0 |
| B: cumulative refund grows to 1,000; cash 200 remains  |              200 |         0 |                                 800 |
| B: collect another 800 cash                            |            1,000 |         0 |                                   0 |
| C: online 500 − refund 100 + cash 200; pending 300     |              600 |       300 |                                 100 |
| C: collect 100 cash                                    |              700 |       300 |                                   0 |
| C: pending 300 expires                                 |              700 |         0 |                                 300 |
| C: collect another 300 cash                            |            1,000 |         0 |                                   0 |
| D: historical partial refund, amount unknown           |          Unknown |         0 |                             Blocked |
| D: verified cumulative refund 300 against gross 1,000  |              700 |         0 |                                 300 |
| D: collect 300 cash                                    |            1,000 |         0 |                                   0 |
| E: pending 1,000; completion before session attachment |        0 → 1,000 | 1,000 → 0 |                        0 throughout |
| F: gross 1,000 − refund 200; new pending remainder 200 |              800 |       200 |                                   0 |
| F: remainder 200 completes                             |            1,000 |         0 |                                   0 |

The verifier checks both readers at every listed transition, rejects amounts
above the literal limit (including one cent above it), checks that refusal writes
no booth row, and accepts legitimate collection. Raw refund/cash assertions catch
duplicate and out-of-order refund mistakes. Nine targeted SQL mutants cover the
money calculation, each collection guard, release semantics, the manifest, and
refund monotonicity. The prior manifest mutation now targets the shared helper.

Eight two-session races cover booth/booth, online/booth, booth/online, and
online/online at read committed and repeatable read. Each proves a real lock
wait, one committed payment, one refusal, and exactly 1,000 cents in raw rows.
Restoring the old lock permits two collections at repeatable read and fails the
race test; the corrected function is restored afterward.

Local browser verification used native PostgreSQL/PostgREST, synthetic local
authentication, and blocked external browser requests. A pending 1,000-cent
payment offered no collection button. Terminal failure then allowed an actual
1,000-cent cash collection. After a 200-cent partial refund the ticket offered
and collected exactly 200 cents: 1,000 − 200 + 200 = 1,000 net. No browser errors.
Hosted Auth, live Stripe, and deployed Edge Functions were not exercised.

## Rollout and reconciliation

This is a coordinated database, Edge Function, and frontend change. Apply the
migration before code that reads `refunded_cents` or relies on claim admission.
Do not keep the old Checkout creator active during rollout: it creates the
external session before reserving the database amount. Quiesce payment creation
and collection during that transition and reconcile existing attempts before
reopening them. No rollout was performed in this task.

Historical full refunds can be backfilled exactly. Historical partial refunds
cannot: their amounts were discarded. The migration stores NULL, blocks further
collection, and Customer Books says reconciliation is needed. Verify the
cumulative refunded amount against the processor before an audited repair. A
new valid cumulative refund event can repair it; replaying an already processed
event ID remains a deduplicated no-op and is not a reconciliation procedure.

Historical `failed` rows also cannot distinguish a retryable card decline from
a closed Checkout. The migration conservatively changes those rows to pending.
A terminal session event or authoritative expired-session lookup releases them.
Completed sessions require verified settlement; unresolved placeholder claims
after ambiguous creation errors require authoritative reconciliation. Do not
release a claim merely because it is old or because a request timed out.

Existing overpayments are not erased or automatically refunded. Their balance
is clamped to zero, preventing additional collection; review and remediation of
already overpaid bookings is a separate authorized operational action. No hosted
data was queried to estimate the affected population.

## Medium findings: report only, recommended order

1. **Stale facility results.** Changing the selected facility leaves the prior
   facility's result and actionable booking visible. Clear results immediately
   and reject late responses for an earlier facility/search. This is first
   because staff can act against the wrong facility.
2. **Advance payment forces check-in.** A future confirmed booking exposes
   collection only after Check in changes it to active. Separate collection
   eligibility from arrival so taking an advance payment cannot fabricate arrival
   or occupancy. PR #9's new payment link lands in this existing flow.
3. **Cash-paid customers see “Not paid.”** My Reservations reads online payments
   without the booth ledger, so a fully cash-paid booking looks unpaid and lacks
   the corresponding payment evidence. Use the shared financial meaning and
   include booth payments in the customer view.
4. **Checkout disappears after collection.** The success ticket replaces the
   action area, hiding checkout until reload. Refresh the booking and preserve a
   clear checkout action after successful collection.

These findings were reproduced in the preceding local audit; their relevant
UI files remain unchanged in this branch. Zero collectable balance also does
not prove settlement while an online payment is pending; remaining booth/manifest
copy should distinguish those states when addressing the payment UI.
