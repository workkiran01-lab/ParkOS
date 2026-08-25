# Roadmap

Working list of what is known-missing, what is deliberately deferred, and what is still just an
idea. Anything that changes the v1 boundary or a numbered decision belongs in `ARCHITECTURE.md`
first — this file tracks work, not architecture.

## Known gaps (should resolve before real launch)

- **`/checkin/{booking_code}` has no route yet.** The QR code on receipts encodes this URL, so a
  real scan 404s. Booking-code lookup itself works (confirmed via receipts); only the destination
  page is missing. Camera-based QR scanning at the booth is a separate, later feature — this is
  just the page the QR should land on.
- **Permit subscription payments are not recorded.** Successful monthly charges are never written
  anywhere — `invoice.payment_succeeded` is unhandled and `payments.reservation_id` is `NOT NULL`,
  so there is nowhere to put the row. 4 live subscriptions currently bill with zero record, and
  every revenue report is understated by that amount. See the known-gap section in
  `ARCHITECTURE.md`. Arguably the most urgent item here: this is working, selling, untracked revenue.
- **Booth-side payment collection UX.** Ties to the in-person payment gap documented in
  `ARCHITECTURE.md`. Intended flow: at check-in, staff sees what is owed and can either show the
  customer a QR/payment link to pay from their own phone, or collect cash/card directly at the
  booth. Needs the payment-method and schema work noted in `ARCHITECTURE.md` first.
- **Duplicate "Sol city" facility on parkos-dev** (id `9ee7635b-…`). Zero price rules, and an
  invalid IANA timezone string (`Pacific` rather than a real zone such as `America/Los_Angeles`),
  so it is unbookable. Looks like an abandoned setup attempt. Needs cleanup — delete or fix, not
  yet decided.
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
