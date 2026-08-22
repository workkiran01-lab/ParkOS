-- Bugfix for Week 9 (20260819150000): process_stripe_event and
-- set_payment_updated_at were meant to be service-role-only, but Supabase's
-- default privileges grant EXECUTE on every new public-schema function directly
-- to anon and authenticated. The original `revoke all ... from public` does not
-- remove those direct role grants, so both functions remained executable by
-- anon/authenticated at the grant level.
--
-- process_stripe_event is not exploitable at runtime — its body rejects any
-- non-service_role caller with SERVICE_ROLE_REQUIRED — but the grant-level
-- boundary the migration intended (and the RLS isolation script's CHECK0c
-- asserts) was not actually enforced. Revoke the default grants so the boundary
-- holds at the grant layer too. service_role keeps its own direct grant.
revoke execute on function public.process_stripe_event(
  text, text, uuid, uuid, text, text, integer, text, integer
) from anon, authenticated;

revoke execute on function public.set_payment_updated_at() from anon, authenticated;
