-- ParkOS: drop the unreachable 'invoice.paid' arm from
-- process_stripe_subscription_event.
--
-- WHY IT IS UNREACHABLE. The webhook is the function's only production caller,
-- and it never routes invoice.paid here. As of the previous commit the dispatch
-- reads:
--
--   if (
--     event.type === 'invoice.payment_succeeded' ||
--     event.type === 'invoice.paid'
--   ) {
--     return await processPaidInvoice(event)      // -> record_permit_payment
--   }
--
--   if (
--     event.type === 'customer.subscription.created' ||
--     event.type === 'customer.subscription.updated' ||
--     event.type === 'customer.subscription.deleted' ||
--     event.type === 'invoice.payment_failed'
--   ) {
--     return await processSubscriptionEvent(event) // -> this function
--   }
--
-- The first block RETURNS, so invoice.paid can never fall through to the
-- second, and invoice.paid is not in the second block's list regardless. The
-- money path and the state path are different functions. No dev-only verifier
-- or test passes 'invoice.paid' as p_event_type either.
--
-- Adding the invoice.paid SUBSCRIPTION did not make this arm reachable: it
-- routes to record_permit_payment, which is a different function entirely.
--
-- WHAT THE ARM WOULD HAVE DONE, measured rather than assumed. An invoice
-- payload carries no subscription status, so the webhook passes
-- p_stripe_status = NULL for every invoice event. Feeding NULL through the arm:
--
--   pending   -> SUSPENDED, and it also writes stripe_subscription_id and the
--                billing period   <-- a real change, not a no-op
--   suspended -> suspended (unchanged)
--   active    -> active (the ordering guard discards the demotion)
--   cancelled -> cancelled (unchanged)
--
-- So the arm was not inert. It could never produce 'active' -- the one status a
-- paid invoice ought to imply -- because it has no status to read; the best it
-- could do to a pending permit was mark it unpaid. Removing it is therefore a
-- removal of dead AND wrong code, not the loss of a capability. Nothing that
-- can call this function can tell the difference.
--
-- Everything else in the function is byte-identical to 20260901000000; only the
-- IN list changes. The signature is unchanged, so the existing grants stand.
-- They are restated below so this file is self-contained if replayed onto a
-- fresh database.

create or replace function public.process_stripe_subscription_event(
  p_event_id text,
  p_event_type text,
  p_permit_id uuid default null,
  p_stripe_subscription_id text default null,
  p_stripe_status text default null,
  p_period_start timestamptz default null,
  p_period_end timestamptz default null,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_permit public.permits%rowtype;
  v_claimed text;
  v_status text;
  -- Index position IS the precedence rank; see the header table.
  v_rank constant text[] := array['pending', 'suspended', 'active', 'cancelled'];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = 'P0001', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_event_id is null or length(trim(p_event_id)) = 0 then
    raise exception using errcode = '22023', message = 'STRIPE_EVENT_ID_REQUIRED';
  end if;
  if exists (select 1 from public.processed_stripe_events e where e.event_id = p_event_id) then
    return jsonb_build_object('processed', false, 'outcome', 'duplicate_event');
  end if;

  if p_permit_id is not null then
    select p.* into v_permit from public.permits p
     where p.id = p_permit_id for update;
  elsif p_stripe_subscription_id is not null then
    select p.* into v_permit from public.permits p
     where p.stripe_subscription_id = p_stripe_subscription_id for update;
  else
    raise exception using errcode = '22023', message = 'PERMIT_IDENTIFIER_REQUIRED';
  end if;
  if not found then
    raise exception using errcode = 'P0002', message = 'PERMIT_NOT_FOUND';
  end if;
  if (p_permit_id is not null and p_permit_id <> v_permit.id)
     or (p_stripe_subscription_id is not null
         and v_permit.stripe_subscription_id is not null
         and p_stripe_subscription_id <> v_permit.stripe_subscription_id) then
    raise exception using errcode = 'P0001', message = 'PERMIT_IDENTIFIER_MISMATCH';
  end if;

  -- First write: the event claim and all state changes commit or roll back together.
  insert into public.processed_stripe_events (event_id, org_id)
  values (p_event_id, v_permit.org_id)
  on conflict (event_id) do nothing
  returning event_id into v_claimed;
  if v_claimed is null then
    return jsonb_build_object('processed', false, 'outcome', 'duplicate_event');
  end if;

  if p_event_type = 'customer.subscription.deleted'
     or p_stripe_status = 'canceled' then
    -- Unguarded on purpose: cancellation is rank 3 and terminal, so it is never
    -- a demotion. A real cancellation must always apply.
    perform public.cancel_permit(
      v_permit.id,
      coalesce(nullif(trim(p_reason), ''), 'Stripe subscription cancelled')
    );
    v_status := 'cancelled';
  elsif p_event_type = 'invoice.payment_failed' then
    -- Unguarded on purpose: a failed invoice IS the evidence of a real demotion.
    update public.permits set status = 'suspended'
     where id = v_permit.id and status <> 'cancelled';
    v_status := case when v_permit.status = 'cancelled' then 'cancelled' else 'suspended' end;
  elsif p_event_type in ('customer.subscription.created', 'customer.subscription.updated') then
    v_status := case
      when p_stripe_status in ('active', 'trialing') then 'active'
      when v_permit.status = 'cancelled' then 'cancelled'
      else 'suspended'
    end;

    -- THE GUARD. Discard a snapshot that would move the permit backwards, unless
    -- its status is a genuine post-activation failure. See the header.
    if array_position(v_rank, v_status) < array_position(v_rank, v_permit.status)
       and coalesce(p_stripe_status, '') not in ('past_due', 'unpaid', 'paused') then
      v_status := v_permit.status;
    end if;

    update public.permits
       set stripe_subscription_id = coalesce(stripe_subscription_id, p_stripe_subscription_id),
           status = v_status,
           -- greatest(), not coalesce(): the period must never move backwards
           -- either. A stale snapshot carries the FIRST period, and overwriting a
           -- later one with it makes a live permit look already expired.
           -- greatest() ignores nulls, so a null on either side keeps the other.
           current_period_start = greatest(p_period_start, current_period_start),
           current_period_end = greatest(p_period_end, current_period_end)
     where id = v_permit.id;
  else
    v_status := v_permit.status;
  end if;

  return jsonb_build_object(
    'processed', true, 'outcome', 'permit_' || v_status,
    'permit_id', v_permit.id, 'permit_status', v_status
  );
end;
$$;

comment on function public.process_stripe_subscription_event(
  text, text, uuid, text, text, timestamptz, timestamptz, text
) is
  'Applies one Stripe subscription event atomically with its idempotency claim. Stripe does not guarantee delivery order and disclaims event.created for recovering it, so a snapshot may not lower the permit status rank (pending < suspended < active < cancelled) unless it carries a real post-activation failure (past_due/unpaid/paused). invoice.payment_failed and cancellation are never guarded.';

-- Signature is unchanged, so the grants from 20260822010000 and the authenticated
-- revoke from 20260827000000 still stand. Restated so this file is self-contained
-- if it is ever replayed onto a fresh database.
revoke all on function public.process_stripe_subscription_event(
  text, text, uuid, text, text, timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.process_stripe_subscription_event(
  text, text, uuid, text, text, timestamptz, timestamptz, text
) to service_role;
