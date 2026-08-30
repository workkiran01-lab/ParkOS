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

The signature-verified Stripe webhook handles `invoice.payment_succeeded` and calls the
service-role-only `record_permit_payment` function. That function resolves the permit from the
invoice's permit metadata or Stripe subscription id, records the amount Stripe actually collected,
and writes an audit entry in one transaction. Browser roles cannot write the table or execute the
recorder.

Idempotency exists at two levels: `processed_stripe_events.event_id` collapses ordinary webhook
retries, and unique `permit_payments.stripe_invoice_id` prevents a resent invoice under a different
event id from becoming duplicate revenue. A later billing period has a different invoice id and is
therefore a separate ledger row. Payments that arrive after a permit was cancelled are still
recorded because the ledger describes money Stripe collected, not whether collection should have
happened.

The v1 revenue-reporting functions do not yet aggregate `permit_payments`; they still report
reservation Checkout and booth collections only. Recording and reporting are separate concerns:
the ledger is now durable and reconcilable, while adding permit revenue to facility/date reports
remains launch work tracked in `docs/roadmap.md`.
