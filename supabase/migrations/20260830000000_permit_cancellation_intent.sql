-- Permit cancellation intent, so the Stripe call can happen before the ParkOS write.
--
-- WHY. CancelPermitDialog called cancel_permit first and Stripe second. When the
-- Stripe call then failed, ParkOS had already marked the permit cancelled and
-- released its space hold while the customer kept being billed, and nothing
-- restored either one. Simply swapping the two calls moves the damage rather
-- than removing it: Stripe would stop billing and the ParkOS write could still
-- fail, leaving a permit that looks active and a space that is still held.
--
-- The fix is to stop the browser writing cancellation state at all. Stripe is
-- called first, and the signature-verified customer.subscription.deleted webhook
-- -- which already calls cancel_permit inside process_stripe_subscription_event,
-- atomically with its event claim, and which Stripe redelivers on failure -- is
-- the sole writer. This column records only that a request was made, so the UI
-- can tell an in-flight cancellation from a live permit.
--
-- WHY A TIMESTAMP AND NOT A FOURTH STATUS. permits.status is read in many places
-- as `= 'active'` / `<> 'cancelled'`, including process_stripe_subscription_event
-- itself. A new status value would be silently mis-bucketed by every one of them.
-- A nullable timestamp is additive: nothing existing reads it.
--
-- WHY THE HOLD IS NOT RELEASED HERE. ARCHITECTURE.md Decision #7 ties hold
-- release to cancelling a permit, not to requesting one. Holding a space
-- slightly too long is reversible; releasing it early and then failing to cancel
-- is not -- another permit or reservation can take the slot, and the shared
-- exclusion constraint will refuse to restore it.

alter table public.permits
  add column cancellation_requested_at timestamptz;

comment on column public.permits.cancellation_requested_at is
  'Set when staff request cancellation, before Stripe confirms. The permit itself is cancelled only by the Stripe webhook. Null means no request is in flight.';

-- Records the intent. Deliberately touches nothing else: no status change, no
-- hold release, no Stripe assertion. Same role gate as cancel_permit.
create or replace function public.request_permit_cancellation(
  p_permit_id uuid,
  p_reason text default null
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_permit public.permits%rowtype;
  v_actor uuid := auth.uid();
  v_is_service boolean := auth.role() = 'service_role';
  v_requested timestamptz;
begin
  if not v_is_service and v_actor is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select p.* into v_permit
    from public.permits p
   where p.id = p_permit_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'PERMIT_NOT_FOUND';
  end if;
  if not v_is_service
     and not public.has_any_role(v_permit.org_id, array['admin','manager']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  -- Idempotent, because the operator may retry a failed Stripe call: an already
  -- cancelled permit needs no intent, and a second request keeps the first
  -- timestamp rather than resetting how long the request has been outstanding.
  if v_permit.status = 'cancelled' or v_permit.cancellation_requested_at is not null then
    return v_permit.cancellation_requested_at;
  end if;

  update public.permits
     set cancellation_requested_at = now()
   where id = p_permit_id
   returning cancellation_requested_at into v_requested;

  insert into public.audit_log (
    org_id, actor_id, action, target_table, target_id, reason
  ) values (
    v_permit.org_id, case when v_is_service then null else v_actor end,
    'request_permit_cancellation', 'permits', p_permit_id, p_reason
  );

  return v_requested;
end;
$$;

revoke all on function public.request_permit_cancellation(uuid, text) from public, anon;
grant execute on function public.request_permit_cancellation(uuid, text)
  to authenticated, service_role;
