-- Reject misrouted events before lookup, deduplication or the event claim.
-- An invoice sent to a state processor must remain replayable by its money recorder.
-- Function signatures, grants and every supported event branch stay unchanged.

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
  if p_event_type is null or p_event_type not in (
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_failed'
  ) then
    raise exception using errcode = '22023', message = 'STRIPE_EVENT_TYPE_UNSUPPORTED';
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

create or replace function public.process_stripe_event(
  p_event_id text,
  p_event_type text,
  p_payment_id uuid default null,
  p_reservation_id uuid default null,
  p_checkout_session_id text default null,
  p_payment_intent_id text default null,
  p_amount_cents integer default null,
  p_currency text default null,
  p_amount_refunded_cents integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_claimed_event_id text;
  v_reservation_status public.reservation_status;
  v_reservation_total_cents integer;
  v_reservation_currency text;
  v_amount_currency_match boolean := false;
  v_outcome text;
  v_refund_total integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = 'P0001', message = 'SERVICE_ROLE_REQUIRED';
  end if;

  if p_event_id is null or length(trim(p_event_id)) = 0 then
    raise exception using errcode = '22023', message = 'STRIPE_EVENT_ID_REQUIRED';
  end if;
  if p_event_type is null or p_event_type not in (
    'checkout.session.completed',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
    'payment_intent.payment_failed',
    'charge.failed',
    'charge.refunded'
  ) then
    raise exception using errcode = '22023', message = 'STRIPE_EVENT_TYPE_UNSUPPORTED';
  end if;

  if p_event_type is null or length(trim(p_event_type)) = 0 then
    raise exception using errcode = '22023', message = 'STRIPE_EVENT_TYPE_REQUIRED';
  end if;

  -- Fast no-op for a delivery already committed by an earlier invocation.
  if exists (
    select 1 from public.processed_stripe_events e where e.event_id = p_event_id
  ) then
    return pg_catalog.jsonb_build_object(
      'processed', false,
      'outcome', 'duplicate_event',
      'event_id', p_event_id
    );
  end if;

  -- Resolve by the strongest supplied identifier, then require every other
  -- supplied identifier to agree. reservation_id alone is intentionally not
  -- accepted because a reservation may have more than one historical attempt.
  if p_payment_id is not null then
    select p.* into v_payment
      from public.payments p
     where p.id = p_payment_id
     for update;
  elsif p_checkout_session_id is not null then
    select p.* into v_payment
      from public.payments p
     where p.stripe_checkout_session_id = p_checkout_session_id
     for update;
  elsif p_payment_intent_id is not null then
    select p.* into v_payment
      from public.payments p
     where p.stripe_payment_intent_id = p_payment_intent_id
     for update;
  else
    -- Still a raise, deliberately: being handed no identifier at all is a
    -- payload this function does not understand, not an event that belongs to
    -- somebody else. Nothing the webhook routes here can reach it today.
    raise exception using errcode = '22023', message = 'PAYMENT_IDENTIFIER_REQUIRED';
  end if;

  -- The event names a charge ParkOS has no payments row for. See the header:
  -- report it, do not raise. A raise here makes Stripe retry an event that can
  -- never apply, for days, against an endpoint that has to stay healthy for the
  -- reservation payments that DO resolve.
  if not found then
    return pg_catalog.jsonb_build_object(
      'processed', false,
      'outcome', 'payment_not_found',
      'event_id', p_event_id,
      'event_type', p_event_type
    );
  end if;

  if (p_payment_id is not null and p_payment_id <> v_payment.id)
     or (p_reservation_id is not null and p_reservation_id <> v_payment.reservation_id)
     or (p_checkout_session_id is not null
         and p_checkout_session_id <> v_payment.stripe_checkout_session_id)
     or (p_payment_intent_id is not null
         and v_payment.stripe_payment_intent_id is not null
         and p_payment_intent_id <> v_payment.stripe_payment_intent_id) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_IDENTIFIER_MISMATCH';
  end if;

  -- First write: claim the event. A conflict means a concurrent invocation
  -- committed while this transaction waited on the payment row.
  insert into public.processed_stripe_events (event_id, org_id)
  values (p_event_id, v_payment.org_id)
  on conflict (event_id) do nothing
  returning event_id into v_claimed_event_id;

  if v_claimed_event_id is null then
    return pg_catalog.jsonb_build_object(
      'processed', false,
      'outcome', 'duplicate_event',
      'event_id', p_event_id,
      'payment_id', v_payment.id
    );
  end if;

  if p_event_type = 'checkout.session.completed' then
    -- A late completion must not regress a payment whose refund event arrived
    -- first. Failed attempts may later succeed after the customer retries.
    update public.payments p
       set stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id,
                                                p_payment_intent_id),
           status = case
             when p.status in ('refunded', 'partially_refunded') then p.status
             else 'succeeded'
           end
     where p.id = v_payment.id
     returning p.* into v_payment;

    select r.status, r.total_cents, r.currency
      into v_reservation_status, v_reservation_total_cents, v_reservation_currency
      from public.reservations r
     where r.id = v_payment.reservation_id
       and r.org_id = v_payment.org_id
     for update;

    if not found then
      raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
    end if;

    v_amount_currency_match :=
      p_amount_cents is not null
      and p_currency is not null
      and p_amount_cents = v_payment.amount_cents
      and p_amount_cents = v_reservation_total_cents
      and upper(p_currency) = upper(v_payment.currency)
      and upper(p_currency) = upper(v_reservation_currency);

    if v_payment.status <> 'succeeded' then
      v_outcome := 'completion_ignored_after_' || v_payment.status;
    elsif v_reservation_status = 'pending' and v_amount_currency_match then
      perform public.confirm_reservation(v_payment.reservation_id);
      v_reservation_status := 'confirmed';
      v_outcome := 'payment_succeeded_reservation_confirmed';
    elsif v_reservation_status = 'pending' then
      v_outcome := 'payment_succeeded_confirmation_skipped_amount_currency_mismatch';
    elsif v_reservation_status = 'confirmed' then
      v_outcome := 'payment_succeeded_reservation_already_confirmed';
    else
      v_outcome := 'payment_succeeded_confirmation_skipped_reservation_' ||
                   v_reservation_status::text;
    end if;

  elsif p_event_type = 'charge.refunded' then
    if p_amount_refunded_cents is null or p_amount_refunded_cents < 0 then
      raise exception using errcode = '22023', message = 'REFUNDED_AMOUNT_REQUIRED';
    end if;

    v_refund_total := coalesce(p_amount_cents, v_payment.amount_cents);
    if v_refund_total < 0 then
      raise exception using errcode = '22023', message = 'INVALID_CHARGE_AMOUNT';
    end if;

    update public.payments p
       set stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id,
                                                p_payment_intent_id),
           status = case
             -- Never let an older partial-refund event regress a full refund.
             when p.status = 'refunded' then 'refunded'
             when p_amount_refunded_cents >= v_refund_total then 'refunded'
             when p_amount_refunded_cents > 0 then 'partially_refunded'
             else p.status
           end
     where p.id = v_payment.id
     returning p.* into v_payment;

    v_outcome := 'payment_' || v_payment.status;

  elsif p_event_type in (
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
    'payment_intent.payment_failed',
    'charge.failed'
  ) then
    -- Out-of-order failures cannot overwrite money Stripe already confirmed or
    -- refunded. A later completion may still promote failed -> succeeded.
    update public.payments p
       set stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id,
                                                p_payment_intent_id),
           status = case when p.status = 'pending' then 'failed' else p.status end
     where p.id = v_payment.id
     returning p.* into v_payment;

    v_outcome := case
      when v_payment.status = 'failed' then 'payment_failed'
      else 'failure_ignored_after_' || v_payment.status
    end;

  else
    v_outcome := 'ignored_event_type';
  end if;

  if v_reservation_status is null then
    select r.status into v_reservation_status
      from public.reservations r
     where r.id = v_payment.reservation_id
       and r.org_id = v_payment.org_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'processed', true,
    'outcome', v_outcome,
    'event_id', p_event_id,
    'payment_id', v_payment.id,
    'reservation_id', v_payment.reservation_id,
    'payment_status', v_payment.status,
    'reservation_status', v_reservation_status,
    'amount_currency_match', v_amount_currency_match
  );
end;
$$;

-- create or replace preserves the existing ACL, but restate it so replaying
-- this file alone onto a fresh database lands what 20260819150000 and
-- 20260819160000 together established: service_role only.
revoke all on function public.process_stripe_event(
  text, text, uuid, uuid, text, text, integer, text, integer
) from public, anon, authenticated;
grant execute on function public.process_stripe_event(
  text, text, uuid, uuid, text, text, integer, text, integer
) to service_role;

