# Navigation restructure verification

Implemented from `5c141ba` on `feature/nav-restructure`. Feature code ends at
`88772fc05fa644345a6a766ab73747de8c18cdb4`.
[CI run 35469046189](https://github.com/workkiran01-lab/ParkOS/actions/runs/35469046189)
passed all three jobs, all 17 existing SQL verifiers, all 18 new isolation mutation
cases, the correction race, and the 50-request reservation concurrency test.

All changes are in `C:\dev\ParkOS-week1-closeout`. The original worktree's working
files were not modified. No hosted Supabase environment was contacted. There is
no new migration, table, policy, or RPC. No merge, PR, or push to main was made.

## Services decision remains open

No Services route, navigation entry, placeholder, or backend was built.

| Plausible meaning                         | Existing support                                                                            | Work needed                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Parking offerings and prices              | Facility price rules, hourly reservations, monthly permits                                  | Define whether this is a combined view or configuration surface over existing features. Most plausible reading of the existing domain. |
| Facility amenities                        | Facility attributes and operating-hours metadata, but no structured service/amenity catalog | Define the data and editing rules; a structured catalog would require a separately approved migration.                                 |
| Add-on work such as valet or vehicle care | No service catalog, booking line items, or fulfillment workflow                             | Product definition and backend design first; would require new schema and authorization work.                                          |

## Existing sections retained

| Section      | Route               | Purpose                                                        | Placement  |
| ------------ | ------------------- | -------------------------------------------------------------- | ---------- |
| Availability | `/app/availability` | Find spaces available during a requested period                | Booking    |
| Reservations | `/app/reservations` | Search/review existing reservations and their actions          | Booking    |
| Occupancy    | `/app/occupancy`    | Space status, active stays, overstays, arrivals and departures | Operations |
| Permits      | `/app/permits`      | Issue and manage monthly permits                               | Operations |
| Reports      | `/app/reports`      | Revenue and occupancy reporting                                | Operations |

Calendar precedes Dashboard. Booking also retains Daily Manifest, New Booking,
and Booth. Employees retains `/app/staff`. Customer contains Directory, Customer,
and contextual Customer ID / Books links once a customer is selected. Management
retains Facilities and Override; conditional Setup/Onboarding remains available.
Existing role visibility is preserved.

## Employees scope and backend findings

Existing `memberships` supports organization roles: admin, manager, attendant,
customer, and owner_viewer. `profiles` provides names. `invites` already supports
role-bearing links, acceptance, seven-day expiry, and revocation. The screen uses
these tables and their existing RLS, with pagination and explicit org filters.

No staff-to-facility assignment relation exists. Existing account deactivation
is a self-service flow, not administrator-controlled staff deactivation, and
archiving a profile is not equivalent to removing membership authorization.
Facility assignment, admin deactivation, and membership removal were excluded.

Role changes have the same last-admin risk as removal. This implementation lets
an administrator change other non-admin members, including promotion to admin.
Existing administrators and the acting user's own membership are read-only.
The update query also excludes those records, including if the roster is stale.
This restriction is not a database-wide last-admin guarantee: existing direct
admin membership DML remains unchanged.

A reliable last-admin safeguard requires approved backend work: serialize access
changes per organization, reject the last administrator's removal/demotion, cover
every write path (including relevant account closure), and test concurrent
demotions/removals. A row lock on the organization plus a database-enforced guard
is one design. No migration or removal feature was built.

## Commits

`3fd8793` — **Reorganize navigation and remember expanded groups**

- Files: `src/routes/app.tsx`, `src/components/layout/AppShell.tsx`.
- Groups the existing navigation; persists expanded state in session storage;
  supplies accessible expansion controls; retains existing routes.

`b0e94e1` — **Add facility timezone reservation calendar**

- Files: `.github/workflows/ci.yml`, `package.json`,
  `scripts/query-isolation.mjs`, `src/components/layout/AppShell.tsx`,
  `src/lib/calendar.test.ts`, `src/lib/calendar.ts`,
  `src/lib/facility-time.ts`, `src/lib/reservation-queries.ts`,
  `src/routeTree.gen.ts`, `src/routes/app.tsx`,
  `src/routes/app/calendar.tsx`, `src/routes/app/reservations.tsx`.
- Adds month/week views, facility-local dates, operating-hours shading,
  midnight clipping and DST handling. Shares the existing reservation query
  with Reservations. Adds loopback-only query mutation tests to CI and enables
  CI on this feature branch. Vite's router plugin generated the route tree.

`fa81ea0` — **Add customer directory and booking history**

- Files: `package.json`, `scripts/query-isolation.mjs`,
  `src/components/customers/CustomerRecord.tsx`,
  `src/components/layout/AppShell.tsx`, `src/lib/customer-queries.test.ts`,
  `src/lib/customer-queries.ts`, `src/routeTree.gen.ts`, `src/routes/app.tsx`,
  `src/routes/app/customers/index.tsx`,
  `src/routes/app/customers/$customerId/index.tsx`,
  `src/routes/app/customers/$customerId/books.tsx`.
- Adds search by name/email/phone/plate, contact and vehicle detail, and booking
  history. Reads both payment ledgers using the existing succeeded-payment
  balance semantics. Adds tenant and explicit-org-filter mutation coverage.

`88772fc` — **Add employee search and protected role editing**

- Files: `scripts/employee-isolation.mjs`, `scripts/query-isolation.mjs`,
  `src/lib/employee-queries.ts`, `src/routes/app/staff.tsx`.
- Adds roster search and protected role editing; retains invitation creation,
  copying and revocation; adds tenant and authorization mutation tests.

The report commit adds only this file. `git log -1 --format=full` was executed
before each feature commit and each resulting message was inspected. The new
messages have no trailers.

## Runtime verification

Browser checks used Chrome against Vite on `127.0.0.1:5175`, real PostgREST and
Postgres on loopback, and the existing fake two-organization seed. Browser
requests to all non-loopback hosts were blocked. Temporary bookings, payments,
invitations, foreign customers, and role changes were cleaned up/restored.

| Screen      | Executed browser verification                                                                                                                                                                                                                      | Additional source/unit verification                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Navigation  | Group collapse survives reload; mobile drawer opens, navigates, closes; existing route sweep below                                                                                                                                                 | Conditional role visibility and session-storage fallback                                                                                                                 |
| Calendar    | Month midnight booking appears on both local days; click opens existing booking detail; Tokyo browser viewing Los Angeles facility; March 8 spring gap; November 1 repeated PDT/PST hour; each DST booking appears once; Lot B hours display       | Exclusive midnight end, 23/25-hour bounds, six-week months, open-ended stays, weekly closure and overnight spillover, PostgreSQL-compatible schedule boundary resolution |
| Customer    | Searches name, email, unformatted phone, plate; seeded foreign customer absent from search; desktop and mobile render                                                                                                                              | Paginated reads and cancellation of stale org/customer responses                                                                                                         |
| Customer ID | Actual contact and vehicle values render; existing foreign-customer ID returns not found                                                                                                                                                           | Explicit organization and customer predicates                                                                                                                            |
| Books       | Six columns and real values render; $3 Stripe + $2 booth against $10 yields $5 due; Jan 10 2031 10 AM–noon Los Angeles despite Tokyo browser; status Completed; both 10:05 AM check-in and 11:55 AM check-out render; foreign customer URL denied  | Refund/pending exclusion follows the canonical balance function                                                                                                          |
| Employees   | Six seeded members; name/role/user-ID searches; own admin has no editor; another member's role persists in Postgres and after reload; invite create/copy/revoke persists; manager sees access denial; 390px layout has no horizontal page overflow | Existing admins/self excluded from update predicate; no removal, assignment, or deactivation control                                                                     |

Retained routes actually loaded: `/app`, `/app/booking/manifest`,
`/app/booking/new`, `/app/reservations`, `/app/availability`, `/app/staff`,
`/app/occupancy`, `/app/permits`, `/app/reports`, `/app/facilities`,
`/app/facilities/:facilityId`, `/app/override`, `/app/onboarding`,
`/attendant`, `/attendant/active`, `/my/reservations`, `/my/settings`,
`/book/:facilityId`, `/checkin/:bookingCode`, `/`, `/about`, `/privacy`,
`/login`, `/signup`, and `/accept-invite`. `/app/setup` redirects an existing
member to Dashboard; a separate profile-less local user rendered the recovery
form. Route loading is a smoke check, not a claim that every existing action was
exercised.

Screenshots and browser scripts remain in ignored local `screenshots/` and
`.verification.local/` directories for review. The in-app browser tool failed
before execution with a `sandboxPolicy` error; these checks used standalone
Playwright/Chrome instead. Local login was a synthetic fixture gateway, not
Supabase Auth. Realtime, email delivery, Stripe, edge functions and account
creation/deactivation were not exercised in browser checks. The full database
migration/verifier result comes from CI's containerized Supabase, not this
Windows fixture environment: native Windows Postgres lacks `pg_cron`.

## Isolation tests with deliberate failures

Command: `npm run test:queries`, using the existing CI-exported local Supabase
variables and `PARKOS_TEST_DATABASE_URL`. Both database and HTTP destinations
must pass loopback guards. The same suite also passed against local PostgREST.

Every case runs green, breaks isolation, requires child exit **1** with the
intended leak/authorization assertion, restores in `finally`, then requires
child exit **0**. All 18 cases completed this sequence locally and in
[database job 105966544627](https://github.com/workkiran01-lab/ParkOS/actions/runs/35469046189/job/105966544627).
The job log records each `MUTATION DETECTED` and `RESTORED GREEN` pair.

| Actual query/test                                        | Deliberate break                                         | Failed child / restored child |
| -------------------------------------------------------- | -------------------------------------------------------- | ----------------------------- |
| Calendar facility                                        | Disable facilities RLS                                   | 1 / 0                         |
| Calendar reservations                                    | Disable reservations RLS                                 | 1 / 0                         |
| Customer list                                            | Disable customers RLS                                    | 1 / 0                         |
| Customer detail                                          | Disable customers RLS                                    | 1 / 0                         |
| Customer organization filter                             | Remove actual query source org predicates, retaining RLS | 1 / 0                         |
| Customer vehicles list                                   | Disable vehicles RLS                                     | 1 / 0                         |
| Customer vehicles detail                                 | Disable vehicles RLS                                     | 1 / 0                         |
| Customer books                                           | Disable reservations RLS                                 | 1 / 0                         |
| Customer Stripe payments                                 | Disable payments RLS                                     | 1 / 0                         |
| Customer booth payments                                  | Disable booth_payments RLS                               | 1 / 0                         |
| Employee memberships                                     | Disable memberships RLS                                  | 1 / 0                         |
| Employee profiles                                        | Disable profiles RLS                                     | 1 / 0                         |
| Employee invitations                                     | Disable invites RLS                                      | 1 / 0                         |
| Employee invitation creation                             | Disable invites RLS                                      | 1 / 0                         |
| Employee invitation revocation                           | Disable invites RLS                                      | 1 / 0                         |
| Employee role tenant boundary                            | Disable memberships RLS                                  | 1 / 0                         |
| Non-admin changes another employee role                  | Disable memberships RLS                                  | 1 / 0                         |
| Self-elevation via direct API, bypassing UI/query guards | Disable memberships RLS                                  | 1 / 0                         |

Positive controls verify own-organization data and real foreign fixtures. Write
tests inspect persisted state and restore mutations. The source mutation catches
an important existing-schema exception: self-service RLS permits a login to read
its own customer record in another organization. Therefore RLS alone is not a
sufficient Directory filter. The explicit organization predicate prevents that
record appearing in the staff Directory; removing it made the assertion fail.

## Individual checks

| Check                     | Executed command                                           | Result                                            |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| Format                    | `npm run format:check`                                     | PASS                                              |
| Lint                      | `npm run lint`                                             | PASS                                              |
| TypeScript                | `npm run typecheck` (`tsc -b`)                             | PASS                                              |
| Edge typecheck            | `npm run typecheck:edge`                                   | PASS, five entrypoints                            |
| Node tests                | `npm run test:unit`                                        | PASS, 24 tests                                    |
| SQL guard                 | `npm run check:sql`                                        | PASS, 64 files                                    |
| Build                     | `npm run build`                                            | PASS                                              |
| Route-tree stability      | Build, then `git diff --exit-code -- src/routeTree.gen.ts` | PASS; no generated diff                           |
| Query isolation mutations | `npm run test:queries`                                     | PASS, all 18 fail/restore cycles                  |
| Correction race           | CI `npm run test:correction-race`                          | PASS, overlapping sessions and intact audit chain |
| Reservation concurrency   | CI `npm run test:concurrency`                              | PASS, 1 success / 49 SPACE_UNAVAILABLE / 0 other  |

The first eight commands were executed individually on Windows, and their CI
counterparts also passed. SQL verifiers below ran on CI's disposable containerized
Postgres with the complete existing migration chain. No RLS counts changed.

| Existing verifier       | CI result |
| ----------------------- | --------- |
| No anonymous execute    | PASS      |
| Privileged functions    | PASS      |
| RLS isolation           | PASS      |
| Permit issuance         | PASS      |
| Permit cancellation     | PASS      |
| Daily manifest          | PASS      |
| Reservation corrections | PASS      |
| Facility time           | PASS      |
| Booth payments          | PASS      |
| Booth revenue           | PASS      |
| Permit payments         | PASS      |
| Permit event ordering   | PASS      |
| Permit revenue          | PASS      |
| Invoice paid            | PASS      |
| Dead branch removal     | PASS      |
| Unresolved payment      | PASS      |
| Refund ledgers          | PASS      |

The first eight are in the database job linked above. The remaining nine are in
[financial job 105966544735](https://github.com/workkiran01-lab/ParkOS/actions/runs/35469046189/job/105966544735).
