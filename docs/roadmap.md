# Roadmap

Working list of what is known-missing, what is deliberately deferred, and what is still just an
idea. Anything that changes the v1 boundary or a numbered decision belongs in `ARCHITECTURE.md`
first — this file tracks work, not architecture.

## Known gaps (should resolve before real launch)

- **Permit payments are recorded but still absent from revenue reporting.**
  `20260829000000_permit_payments.sql` and the Stripe webhook now persist each successful monthly
  invoice in an idempotent, audited ledger. The dashboard and `report_*` functions still combine
  only reservation `payments` and `booth_payments`, so their displayed totals remain understated
  by permit revenue. Extend those functions (and their online/booth breakdown contract) before
  treating the operator reports as total revenue.
- **Customer self-pay handoff at the booth doesn't exist.** Staff can collect cash or card-terminal
  payment directly, but the booth screen has no link or QR that lets the customer start Stripe
  Checkout on their own phone. This is separate from the receipt QR, which opens the staff-only
  `/checkin/{booking_code}` surface.
- **Duplicate "Sol city" facility on parkos-dev** (id `9ee7635b-…`). Zero price rules, so still
  unbookable. Its invalid timezone (`Pacific`) was corrected to `America/Los_Angeles` on
  2026-08-26 — a data fix applied directly to parkos-dev, not a migration, since it is one
  environment's row and would be a no-op or a wrong fix anywhere else. The 2 zones and 80 spaces
  were kept rather than deleting the facility.
  That timezone was a **latent `22023`, not a cosmetic wart**, which is why it was worth fixing
  immediately rather than deferring: `facility_today_arrivals` returned cleanly for this facility
  only because it has zero reservations, so `at time zone f.timezone` was never evaluated on any
  row. The first booking there would have thrown `time zone "Pacific" not recognized` and taken
  out the dashboard card. Verified after the fix: 0 of 5 facilities rejected by `safe_timezone`,
  0 facilities where the manifest and dashboard conventions resolve different local days.
  Still needs a decision on whether this duplicate should exist at all.
- **`revoke ... from public` on functions does not remove anon EXECUTE, and every RPC comment
  claiming "No anon access" is wrong.** Supabase ships `ALTER DEFAULT PRIVILEGES` on the public
  schema granting EXECUTE on new functions directly to `anon`, `authenticated`, and `service_role`.
  `REVOKE ... FROM PUBLIC` only drops the PUBLIC pseudo-role and leaves the direct `anon` grant in
  place. Confirmed on parkos-dev: `facility_today_arrivals`, `facility_today_departures`,
  `facility_overstays`, `facility_dashboard_summary`, `reservation_balance_cents`, and
  `record_booth_payment` all carry `anon=X/postgres`. Nothing leaks today — the SECURITY INVOKER
  ones return zero rows to a role with no membership, and `record_booth_payment` rejects an anon
  caller in its own role check — so this was a defense-in-depth and truth-in-comments gap, not an
  active hole. **Resolved** for all seven known functions: `facility_daily_manifest` in
  `20260826020000`, the other six in `20260826030000`, each verified `anon_exec = false` with
  `anon` absent from the raw ACL. The real access model now lives in `COMMENT ON FUNCTION` rather
  than in migration headers, because the headers that assert "No anon access" are in already-applied
  files and cannot be edited without making the repo disagree with what ran.
  **Resolved for repo-owned functions:** `20260826040000_revoke_anon_default_and_sweep.sql` revokes
  `anon` EXECUTE from the `postgres` default function privileges and sweeps existing
  `postgres`-owned functions except the deliberate public allowlist. The separate
  `supabase_admin` default ACL cannot be changed by migrations running as `postgres`, but ParkOS
  does not create functions under that owner. `npm run test:acl` audits the linked database and
  fails if an unexpected public function is executable by `anon`.
- **The same default privileges grant `anon` full DML on every new table in `public`, and RLS is
  the only thing stopping it. UNMITIGATED.** The `ALTER DEFAULT PRIVILEGES` behind the function
  issue above is not limited to functions. Confirmed on parkos-dev, for both the `postgres` and
  `supabase_admin` grantors: new **tables** in `public` default to
  `anon=arwdDxtm` — SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER — and new
  sequences to `anon=rwU`. Every ParkOS table happens to have RLS enabled (Decision #1), which is
  what makes this survivable today. But that means **a single table created without
  `enable row level security` is an immediate, unauthenticated read _and write_ hole**, not a slow
  leak — the grant is already there waiting, and nothing announces it. This is a strictly larger
  exposure than the function grants, and unlike those it has not been fixed or worked around.
  `supabase/dev-only/verify_no_anon_execute.sql` could be extended to cover it: the check is a join
  over `pg_class` for tables in `public` where `relrowsecurity` is false or `anon` holds any
  privilege. Not built. Recording only — do not assume this is handled.
- **`reservations` has zero RLS UPDATE policies, so no field is correctable after creation.**
  The table has only `reservations_select`, `reservations_select_own`, `reservations_insert`, and
  `reservations_insert_own` — no UPDATE policy at all, while RLS is enabled. Every mutation goes
  through a `SECURITY DEFINER` RPC (`confirm_reservation`, `cancel_reservation`,
  `check_in_reservation`, `extend_reservation`, …), each of which writes a fixed set of columns.
  **The failure mode is silent.** Table-level `UPDATE` _is_ granted to `authenticated`, so a client
  UPDATE is not rejected — it matches zero rows and returns success. Measured on parkos-dev: the
  same `update reservations set vehicle_id = …` affects 1 row as `postgres` and **0 rows as a real
  staff admin**, with no error, on a row that same admin can `SELECT`. Nothing in the UI does this
  today, so nothing is broken; the hazard is that the next person who tries will get a green path
  that does nothing.
  Direct consequence: **`vehicle_id` must be supplied at creation or never** — which is why
  `/app/booking/new` requires a vehicle even though the column is nullable. Any future "edit
  reservation" feature (fix a plate, correct a customer, adjust a window outside `extend_reservation`)
  needs an RPC or an UPDATE policy **first** — it cannot be built in the client alone.
- **`create-checkout-session` is unusable from any staff context.** Its success and cancel URLs are
  hardcoded to `${returnOrigin}/my/reservations?checkout=…`
  (`supabase/functions/create-checkout-session/index.ts`), which is the customer area. The function
  itself works for staff — it authorizes with the caller's JWT and staff can select any org
  reservation under RLS — so a staff member _can_ start a Checkout session, but completing it
  dumps them on a customer page that is empty for a user with no customer record. This is why the
  New Booking flow deliberately stops at `pending` rather than offering Checkout. Fixing it means
  making the return path caller-aware; not attempted.
- **`facilities.timezone` has no validation, and the obvious constraint is worse than none.**
  Nothing stops an arbitrary string being stored; `'Pacific'` reached parkos-dev that way. The
  tempting fix is `check (public.safe_timezone(timezone) = timezone)`. **Do not add it.** Measured
  against a live database: it correctly blocks `'Pacific'` and the empty string, but it **allows
  `'PST'` and `'EST'`** — fixed-offset abbreviations that Postgres parses happily and that do not
  observe DST. `timestamptz '2026-07-01 12:00+00' at time zone 'PST'` yields `04:00` where
  `America/Los_Angeles` yields `05:00`: a one-hour divergence for roughly eight months a year,
  which silently shifts every facility-local day boundary, and therefore every manifest, report,
  and daily-cap split. A constraint that blocks the loud failure while admitting the quiet one
  reads as protection and is not.
  `check (timezone in (select name from pg_timezone_names))` is not an option either — Postgres
  rejects it outright with `0A000 cannot use subquery in check constraint`.
  Real validation needs one of: a `BEFORE INSERT/UPDATE` trigger checking membership in
  `pg_timezone_names`, or a lookup table seeded from `pg_timezone_names` with a foreign key.
  Either is deliberate work, not a one-liner.
  Also note `public.safe_timezone(text)` is declared `IMMUTABLE` only **approximately**: tzdata
  updates can change which zone names are valid, and existing rows are never re-checked against a
  constraint once stored. That is tolerable for a fallback helper; it is a further reason not to
  build a data constraint on top of it.
- **Two timezone conventions coexist in SQL, and the Daily Manifest can disagree with the
  dashboard.** The `occupancy_dashboard` family (`facility_today_arrivals`,
  `facility_today_departures`, `facility_dashboard_summary`) bins by `f.timezone` directly, which
  raises `22023` on an unusable value. The `reporting_functions` family and the newer
  `facility_daily_manifest` bin by `public.safe_timezone(f.timezone)`, which falls back to UTC so
  one bad facility cannot take down a whole query. Consequence: for a facility whose timezone
  string is malformed, the manifest bins by UTC while the dashboard's arrivals card raises an
  error. Before the duplicate "Sol city" facility was corrected from `Pacific` to
  `America/Los_Angeles` on 2026-08-26, its manifest "today" was 2026-08-27 while every
  correctly-configured facility's was 2026-08-26. No invalid facility timezone is currently known,
  but the two SQL conventions still diverge if another malformed value is stored. The manifest
  chose `safe_timezone` as the safer behavior; converging the dashboard family onto
  `safe_timezone` remains the durable fix and requires its own migration.
- **RLS isolation CHECK10 calls a removed checkout signature.**
  `supabase/dev-only/20260819050000_verify_rls_isolation.sql` still invokes
  `check_out_reservation(uuid, integer)`, but `20260825010000_booth_payments.sql` replaced that
  overload with `check_out_reservation(uuid, timestamptz, text, text)`. The rollback-wrapped
  verifier now reaches CHECK10 and fails with `42883` before it can prove cross-org checkout
  isolation. Both application callers already use the current named parameters, so this is
  verifier drift rather than a broken production call. Update CHECK10 and rerun the full verifier.
- **No back/breadcrumb navigation anywhere in the staff app** (`/app/*`). Noticed during testing.
  A real UX gap, not yet scoped.
- **Multi-role login edge cases.** One auth user holding both a staff membership and a customer
  record has not been tested beyond the basic case. Worth a deliberate pass before launch.
- **`/signup` has no invite awareness.** `create_organization_with_admin()` unconditionally makes
  any fresh signup the admin of a brand-new org — it never checks the `invites` table for a
  pending row matching the signer's email. So if an invited user ever lands on `/signup` instead
  of the actual invite-acceptance link (more likely now, since invite email delivery is itself
  deferred), they silently become admin of an unrelated new org, and the original invite sits
  unaccepted forever with no warning to either party. Fixing this properly means `/signup`
  checking `invites` by email before minting a new org — worth deciding whether to auto-redirect
  to acceptance, or just block and inform. Separate from the invite-email deferral already listed
  above; that gap is about delivery, this one is about connecting the two flows even once delivery
  exists.
- **`public_create_reservation` doesn't return `booking_code`.** The booking confirmation page
  reads it back via a second `get_my_reservations()` call, with a fallback to the raw reservation
  ID if that fails. Fixing properly means a DROP/CREATE cascade across `create_reservation` →
  `public_create_reservation` → `check_in_walk_in` for the return-type change (same pattern
  already handled once for booking_code generation itself). Not done now — deliberately kept out
  of a UI/design-pass task.

## Implemented in code; deployment remains explicit

- **Receipt QR destination.** `/checkin/{booking_code}` now exists as a staff-only booth surface
  with booking-code lookup and lifecycle-aware check-in/check-out actions.
- **Direct booth collection.** `booth_payments` and the trusted `record_booth_payment` RPC record
  audited cash/card-terminal collection without weakening the Stripe ledger. Migration
  `20260825010000_booth_payments.sql` must still be applied explicitly to each environment; a code
  commit does not apply it.

## Deferred to v2 (already in ARCHITECTURE.md)

- Valet operations
- Property-owner portal
- License plate recognition (LPR)
- RFID
- Gate hardware integration
- Native mobile apps
- Floating (zone-level) permits
- Time-of-day pricing rules
- Stripe Connect (operator-collects)
- Real email delivery for invites

## New ideas from planning discussion (not yet scoped)

- **Airport valet / meet-and-greet parking.** The operator's own existing staff — not a driver
  marketplace — receive the customer's car at a drop-off point, park it, retrieve it on a return
  request, and deliver it to the terminal curb. Reuses `space_holds`, `vehicle_photos`,
  `audit_log`, and the existing RLS/role patterns as-is. New pieces needed: a custody state
  machine (awaiting drop-off → received → parked → return requested → retrieved → delivered), a
  staff job-queue screen, a drop-off/pickup location concept distinct from zones, and a
  customer-facing "request my car" trigger. Opt-in per facility (e.g. a `supports_valet` flag),
  not global.
- **Org slug for human-readable booking URLs** — `/book/harbor-park` instead of a UUID.
- **Platform billing model.** How ParkOS itself charges operators: flat SaaS fee vs.
  per-transaction vs. tiered. Undecided, but it affects the landing page and demo-org work, so
  the direction is worth settling before launch even if nothing is built.
- **Legal.** Terms of Service, Privacy Policy, and a cancellation/refund policy that is
  configurable per operator rather than hardcoded. Plus a liability acceptance flow at
  booking/check-in, which matters more once valet exists.
- **Promo/discount codes** — layers onto the existing `price_rules` scope resolution.
- **Waitlist when a facility is full.**
- **Per-org branding on the customer booking page** — logo and accent color, not full
  white-labeling.
- **Verify password reset / account recovery actually works.** Likely already exists; needs
  explicit confirmation rather than new build.
- **Support/contact path for customers hitting real issues.**
