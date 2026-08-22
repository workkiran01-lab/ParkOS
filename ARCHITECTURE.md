# ParkOS Architecture

This file is the **source of truth for all schema and data-modeling decisions**. Nothing
elsewhere in the codebase — migrations, application code, docs — should contradict it. When a
decision here proves wrong, change it *here first*, then reconcile the code.

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

The initial pending payment attempt is created only by a trusted server function. After that,
payment status changes only from signature-verified Stripe webhooks running with the service
role; browser clients never insert or update payment state. Webhook event claiming and the
corresponding payment/reservation transition happen in one database transaction so a retry can
never be acknowledged before its state change commits.

Payment records are financial history: clients cannot delete them, and application workflows do
not archive or hard-delete them.

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
