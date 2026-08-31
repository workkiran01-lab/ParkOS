# ParkOS Architecture

This file is the **source of truth for all schema and data-modeling decisions**. Nothing
elsewhere in the codebase — migrations, application code, docs — should contradict it. When a
decision here proves wrong, change it _here first_, then reconcile the code.

## Core Decisions

### 1. Multi-tenancy: shared schema

Every table — **no exceptions, including junction tables** — carries:

```sql
org_id uuid not null references organizations(id)
```

Tenant isolation is enforced **entirely by Row Level Security policies**, never by
application-level filtering alone.

**Reasoning:** schema-per-tenant breaks Supabase's client libraries and makes migrations
unmanageable at scale.

### 2. Time: timestamptz in UTC, IANA zone per facility

All timestamps are `timestamptz`, stored in UTC. Each facility carries an IANA timezone string
(e.g. `America/Los_Angeles`) in its own column. Conversion to local time happens **only at
render**. Never store a UTC offset or a local time directly.

**Reasoning:** offsets break across DST transitions, which reservations will regularly span.

### 3. Money: integer cents, currency column, JSONB breakdown

All amounts are **integer cents**, never floating point. A `currency` column exists from day one
even though it is always `"USD"` for now. Reservation pricing is stored as a **JSONB breakdown of
line items**, not a single total column.

**Reasoning:** itemized receipts need the breakdown; floats cause rounding errors in financial
data.

### 4. Identifiers: uuid primary keys

All primary keys are `uuid` via `gen_random_uuid()`, not sequential integers.

The narrow exception is an external-provider idempotency ledger whose natural key is the
provider's immutable event identifier (for example, Stripe's `event_id` text value). The ledger
still carries `org_id`; using the provider ID as its primary key makes duplicate delivery a
database-enforced no-op.

**Reasoning:** sequential IDs leak business volume and collide if environments are ever merged or
seeded from each other.

### 5. Soft deletes: archived_at, not hard deletes

Any table with historical or referential significance — facilities, zones, spaces,
staff/profiles, reservations, permits — uses:

```sql
archived_at timestamptz null
```

instead of hard deletes.

**Reasoning:** a deactivated staff member's name must still appear on old check-in records.

### 6. Payments: Stripe-confirmed platform collection

ParkOS v1 collects reservation payments into the platform Stripe account through hosted Stripe
Checkout. Stripe Connect and operator payouts are later decisions, not implicit parts of this
model.

The initial pending Stripe payment attempt is created only by a trusted server function. After
that, Stripe payment status changes only from signature-verified Stripe webhooks running with the
service role; browser clients never insert or update Stripe payment state. Webhook event claiming
and the corresponding payment/reservation transition happen in one database transaction so a
retry can never be acknowledged before its state change commits.

The one sanctioned non-webhook reservation-payment path is in-person collection under Decision
#8. It writes a separate ledger through a role-checked trusted RPC; it does not relax any of the
rules above for Stripe-backed `payments` rows.

Payment records are financial history: clients cannot delete them, and application workflows do
not archive or hard-delete them.

### 7. Monthly permits: assigned spaces with Stripe subscriptions

ParkOS v1 monthly permits are assigned to one concrete parking space. Issuing a permit creates
one open-ended `space_holds` row, so permits and reservations compete through the same database
exclusion constraint. Cancelling a permit releases that hold; suspending billing does not release
it automatically because loss of access is an operator decision.

Recurring billing uses Stripe Subscriptions in the platform account. Permit subscription IDs,
billing periods, and Stripe-derived lifecycle changes are written only by signature-verified
webhooks running with the service role. Staff may issue or cancel a permit through audited,
transactional server functions, but browser clients cannot claim that Stripe created, renewed,
failed, or cancelled a subscription.

The initial subscription uses a permit-specific recurring Stripe Price and Stripe's hosted invoice
payment page. Stripe Connect, pooled/unassigned permits, proration controls, and usage-based billing
remain later decisions.

### 8. In-person payments: separate ledger through a trusted booth RPC

Cash and card-terminal payments collected by staff are stored in `booth_payments`, not in
`payments`. The Stripe ledger deliberately requires `stripe_checkout_session_id` and permits
lifecycle changes only from verified provider events. Making those fields nullable or adding a
browser-written method discriminator would weaken the invariants that make a `payments` row proof
of Stripe activity. A separate ledger keeps the two kinds of evidence explicit: Stripe confirms
online money; an identified staff member attests to money taken at the booth.

`record_booth_payment` is the only application write path. It is `SECURITY DEFINER` so it can write
while authenticated clients retain no direct `INSERT`, `UPDATE`, or `DELETE` grant or policy on
the table. The function requires an authenticated `admin`, `manager`, or `attendant` in the
reservation's organization, locks the reservation while checking its balance, rejects
over-collection, records `collected_by`, and writes an audit-log entry.

This is a narrow exception to Decision #6's webhook-only rule: it applies only to in-person rows in
`booth_payments`. It does not allow clients or staff RPCs to create or mutate Stripe-backed
`payments` rows. Booth-payment records are financial history and are neither archived nor deleted
by application workflows.

## Reference Operator

The concrete case every ambiguous UX or schema decision gets checked against.

**Harbor Park Group** — 2 lots in Long Beach, CA.

- **Lot A:** 120 spaces, 3 levels, 8 EV chargers, 4 accessible, gated with attendant booth.
  Hourly + 40 monthly permit holders.
- **Lot B:** 45 spaces, surface lot, unattended, hourly only.
- **Staff:** 1 owner/admin, 1 manager, 4 attendants across shifts.
- **Hours:** Lot A 24/7, Lot B 6am–10pm.

## v1 Scope Boundary

The following are explicitly **OUT of scope for v1**. They are **v2**, and must be checked
against this file before being added:

- Valet operations
- Property-owner portal
- License plate recognition (LPR)
- RFID
- Gate hardware integration
- Native mobile apps

## In-person payment collection and reporting implemented

Decision #8 and migration `20260825010000_booth_payments.sql` resolve the structural collection
gap in the schema and application code. Migration `20260826000000_booth_revenue_reporting.sql`
adds booth cash and card-terminal collections to the dashboard and revenue reports without
double-counting mixed-payment reservations. Migrations still have to be applied explicitly in each
environment; committing them does not deploy them.

Walk-in and drive-up parking had no payment collection path. Three structural blockers, each
sufficient on its own:

- `create-checkout-session` rejects any reservation whose status is not `pending`, while
  `check_in_walk_in` moves a reservation from `pending` to `active` inside a single
  transaction. A walk-in is therefore never observably payable through the existing Stripe
  flow, even if the booth UI offered a button. — Still true, and now moot: booth collection does
  not route through Stripe Checkout at all.
- `payments.stripe_checkout_session_id` is `NOT NULL`, and the table has no `method` or
  `collected_by` column. A cash or card-terminal payment cannot be recorded at all. — Closed by
  `booth_payments`.
- Decision #6 restricts payment-state writes to signature-verified Stripe webhooks. In-person
  collection has no way to originate such a write. — Closed by `record_booth_payment`.

`check_out_reservation` computed `final_total_cents` (overstay included) and returned it, but
nothing consumed that figure. Measured on parkos-dev: 8 of 8 historical walk-ins collected $0.
It now prices the overstay itself and can collect the balance in the same transaction.

The booth surface is `/checkin/{booking_code}` — the URL already printed as a QR on every
receipt, which until now had no route behind it.

`facility_dashboard_summary` and the `report_*` revenue functions combine Stripe-backed
`payments` with `booth_payments`, while exposing separate online, booth-cash, and booth-card
breakdowns. Cash and card-terminal collections are therefore included in dashboard and report
revenue totals.

## Permit subscription payment ledger

Monthly permit invoices use their own `permit_payments` ledger. They do not weaken the invariants
on reservation Checkout rows in `payments`: a recurring invoice has no reservation and no Checkout
Session, while both identifiers remain required there.

The signature-verified Stripe webhook handles both `invoice.payment_succeeded` and `invoice.paid`,
routing each to the service-role-only `record_permit_payment` function. That function resolves the permit from the
invoice's permit metadata or Stripe subscription id, records the amount Stripe actually collected,
and writes an audit entry in one transaction. Browser roles cannot write the table or execute the
recorder.

Both events are subscribed because only `invoice.paid` fires when an invoice is marked paid
**out of band** — a wire, a cheque, cash handed over. `invoice.payment_succeeded` is never sent for
those, so before this they collected money and recorded nothing, raising no error: the same silent
shape as the Basil `paid` removal. Stripe recommends listening to `invoice.paid` *instead of*
`invoice.payment_succeeded`; ParkOS deliberately keeps both, because nothing in this repository can
see which events the Dashboard endpoint subscribes to (see "Stripe API version pinning") and
dropping `payment_succeeded` against an endpoint that does not send `invoice.paid` would silently
stop all permit revenue. Subscribing to both fails safe in the other direction.

That makes double delivery routine rather than exceptional: a normal payment arrives on **both**
events, carrying identical invoice data under **different** event ids. Idempotency exists at two
levels and the second one is what carries this case: `processed_stripe_events.event_id` collapses
ordinary webhook retries but *cannot* collapse two distinct events, and unique
`permit_payments.stripe_invoice_id` prevents a resent invoice under a different event id from
becoming duplicate revenue. The second delivery returns `duplicate_invoice` and writes neither a
payment row nor an audit entry. Concurrent delivery of the two events serializes on the permit's
`FOR UPDATE` lock, which `record_permit_payment` takes before any write — measured at 11.0s of real
lock wait in a two-connection test, after which the blocked call returned `duplicate_invoice` and
the ledger held one row. A later billing period has a different invoice id and is
therefore a separate ledger row. Payments that arrive after a permit was cancelled are still
recorded because the ledger describes money Stripe collected, not whether collection should have
happened.

The revenue-reporting functions aggregate `permit_payments` as of
`20260902000000_permit_revenue_reporting.sql`. `facility_dashboard_summary`,
`report_revenue_by_period`, `report_revenue_by_space_type` and `report_revenue_split` each gained a
permit branch, so an operator total is no longer understated by the permit take. Permits do not hang
off a reservation the way booth payments do — they carry `facility_id` and `space_id` directly — so
the permit branch joins `permit_payments -> permits -> facilities` and never touches `reservations`.
A permit counts against the type of the space it holds.

Only `succeeded` permit payments count, matching how the `payments` branches filter. `refunded_count`
stays reservation-only: `permit_payments.status` is constrained to `succeeded` alone, because the
table is written only from settled invoices and a failed invoice suspends the permit while
recording no money. `report_revenue_split`'s `permit` row previously returned NULL with
`recorded = false` and a note pointing here; it now returns real figures with `recorded = true`, which
is visible to anyone comparing a report from before that migration.

## Stripe API version pinning

Edge functions import the Stripe SDK as `npm:stripe@22.6.0` — an exact version, in all four files
that import it. There is no `deno.lock`, so a range would be re-resolved on every deploy. Within
`^22` the range's own API version already moved twice (`22.0.0` ships `2026-03-25.dahlia`, `22.6.0`
ships `2026-08-26.dahlia`, and the next release carries `2026-08-26.preview`), so a caret range moved
the wire protocol, not just the library.

`getStripeClient` also sets `apiVersion: '2026-08-26.dahlia'` explicitly. stripe-node does not fall
back to the account default when the option is omitted — it sends its own baked-in `ApiVersion`
either way — so this is a no-op against the pinned SDK by design. It exists so the code states what
it expects instead of inheriting it, and so bumping the SDK surfaces a version change as a visible
diff rather than a silent one.

**These two pins govern outbound calls only.** A webhook body is rendered at the API version
configured on the ENDPOINT in the Stripe Dashboard, which is a separate setting the SDK cannot read
or influence. Nothing in this repository can tell you what that version is, and no check here will
fail if it moves. That is not an oversight — it is the split that produced the Basil bug, where a
`2025-03-31.basil` endpoint stopped sending the top-level `paid` field and every permit invoice
began failing `INVOICE_NOT_PAID` with no error anywhere upstream.

The two versions must therefore be kept aligned deliberately, by a human, whenever either moves:

- Changing the endpoint version in the Dashboard requires re-checking the payload readers.
- Bumping the pinned SDK requires re-checking the endpoint version alongside it.

Until that alignment is machine-checkable, the real defence on the inbound path stays where it is:
the readers in `supabase/functions/_shared/stripe-payload.ts` accept both the pre-Basil and
post-Basil shapes of every field ParkOS depends on, and `stripe-payload.test.ts` exercises both
against recorded payloads. Pinning the SDK gives that path no protection whatsoever.
