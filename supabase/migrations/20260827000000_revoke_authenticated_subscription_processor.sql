-- ParkOS: keep Stripe subscription event processing service-role-only.
--
-- Supabase's default function privileges granted EXECUTE directly to
-- `authenticated` when this function was created. Revoking from the PUBLIC
-- pseudo-role did not remove that direct grant. The Stripe webhook calls this
-- function with the service-role client; no authenticated client calls it.

revoke execute on function public.process_stripe_subscription_event(
  text,
  text,
  uuid,
  text,
  text,
  timestamptz,
  timestamptz,
  text
) from authenticated;
