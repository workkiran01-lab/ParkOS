-- ParkOS: remove anon EXECUTE from the six remaining functions that still have
-- it, and put the true access model somewhere that is not a lie.
--
-- THE BUG THIS CLOSES. Supabase ships ALTER DEFAULT PRIVILEGES on the public
-- schema granting EXECUTE on new functions directly to anon, authenticated,
-- and service_role. Our migrations have consistently ended with:
--
--   revoke all on function ... from public;
--   grant execute on function ... to authenticated;
--
-- `REVOKE ... FROM PUBLIC` drops only the PUBLIC pseudo-role's privileges. It
-- does nothing to a DIRECT grant to a named role, so `anon=X/postgres` survived
-- on every function, while the migration header above it said "No anon access".
-- Verified on parkos-dev: all six functions below came back anon_exec = true.
-- 20260826020000 already fixed facility_daily_manifest the same way.
--
-- WHY NOTHING LEAKED. The four facility_* functions are SECURITY INVOKER, so an
-- anon caller is filtered by RLS as anon: no membership means
-- get_user_role(org_id) is null, the org's rows are invisible, and the call
-- returns an empty set. reservation_balance_cents and record_booth_payment are
-- SECURITY DEFINER but both check authorization in their own bodies and raise
-- NOT_AUTHORIZED for a caller with neither a membership nor ownership of the
-- customer. This is a defense-in-depth fix, not an incident: the grant was a
-- privilege nothing needed and the comments describing it were false.
--
-- record_booth_payment is the reason this is not being deferred. It is SECURITY
-- DEFINER and it writes money. Its safety rested entirely on one runtime role
-- check, with a header comment asserting a second layer that did not exist.
--
-- ABOUT THE HEADER COMMENTS. The false "No anon access" lines live in
-- migrations that are already applied, and those files are immutable -- editing
-- them would make the repo disagree with what the database actually ran, which
-- is the drift the immutability rule exists to prevent. The correction is
-- therefore recorded as COMMENT ON FUNCTION, which lives on the object itself,
-- survives, and is queryable with \df+ or obj_description(). Read those, not
-- the historical migration headers.

-- ---------------------------------------------------------------------------
-- 1. The revokes. Idempotent: revoking a privilege that is already absent is
--    not an error, so a re-run is a no-op.
-- ---------------------------------------------------------------------------

revoke execute on function public.facility_today_arrivals(uuid) from anon;
revoke execute on function public.facility_today_departures(uuid) from anon;
revoke execute on function public.facility_overstays(uuid) from anon;
revoke execute on function public.facility_dashboard_summary(uuid) from anon;
revoke execute on function public.reservation_balance_cents(uuid) from anon;
revoke execute on function public.record_booth_payment(uuid, integer, text, text)
  from anon;

-- ---------------------------------------------------------------------------
-- 2. The truth, on the objects themselves.
-- ---------------------------------------------------------------------------

comment on function public.facility_today_arrivals(uuid) is
  'Reservations CHECKED IN on the facility''s local calendar day -- events that already happened, not a schedule. For what is expected on a day, use facility_daily_manifest(uuid, date). SECURITY INVOKER: rows are filtered by the caller''s own RLS. EXECUTE: authenticated and service_role only; anon was revoked in 20260826030000.';

comment on function public.facility_today_departures(uuid) is
  'Reservations CHECKED OUT on the facility''s local calendar day -- events that already happened, not a schedule. For what is expected on a day, use facility_daily_manifest(uuid, date). SECURITY INVOKER: rows are filtered by the caller''s own RLS. EXECUTE: authenticated and service_role only; anon was revoked in 20260826030000.';

comment on function public.facility_overstays(uuid) is
  'Active reservations past their reserved end with no checkout. Deliberately not limited to today: an overstay that began yesterday is still an overstay. SECURITY INVOKER: rows are filtered by the caller''s own RLS. EXECUTE: authenticated and service_role only; anon was revoked in 20260826030000.';

comment on function public.facility_dashboard_summary(uuid) is
  'Per-facility occupancy, today''s revenue, and headline counts for the live dashboard. Bins by facilities.timezone DIRECTLY, which raises 22023 on an unusable value -- unlike the reporting and manifest functions, which use safe_timezone(). See docs/roadmap.md. SECURITY INVOKER: rows are filtered by the caller''s own RLS. EXECUTE: authenticated and service_role only; anon was revoked in 20260826030000.';

comment on function public.reservation_balance_cents(uuid) is
  'Canonical outstanding balance for one reservation: total_cents minus booth_payments plus succeeded payments, floored at zero. NOTE: public.facility_daily_manifest(uuid, date) inlines this same sum for a whole day at once. Keep the two in agreement. SECURITY DEFINER: authorization is enforced in the body (org membership or ownership of the customer), NOT by RLS. EXECUTE: authenticated and service_role only; anon was revoked in 20260826030000.';

comment on function public.record_booth_payment(uuid, integer, text, text) is
  'Trusted write path for booth/cash payments (ARCHITECTURE.md Decision #8); clients hold SELECT only on the payment tables. SECURITY DEFINER and it writes money: authorization is enforced in the body (admin/manager/attendant in the reservation''s org), NOT by RLS, and over-collection is guarded there too. EXECUTE: authenticated and service_role only; anon was revoked in 20260826030000 -- before that it was anon-executable, protected solely by the in-body role check.';
