-- ParkOS: an unresolvable Stripe charge must not 500 the webhook forever.
--
-- THE BUG. A permit refund issued from the Stripe Dashboard fires
-- charge.refunded. The webhook normalizes it and calls process_stripe_event,
-- which resolves against public.payments by payment_intent_id, misses (permit
-- money lives in permit_payments), and raises PAYMENT_NOT_FOUND. PostgREST
-- turns that into an error, the webhook returns 500, and Stripe retries the
-- same event for days and never succeeds. Reachable today with no code change.
--
-- WHY THE FIX IS HERE AND NOT IN THE charge.refunded ARM. The raise sits in the
-- resolution block shared by ALL six event types this function handles, so the
-- shape is not specific to refunds. A second instance is already live:
-- create-checkout-session creates the Stripe Checkout Session BEFORE inserting
-- the pending payments row, and expires that session if the insert fails. The
-- resulting checkout.session.expired then arrives for a session with no payment
-- row and 500s identically. One guard at the resolution site covers both.
--
-- WHY 200-IGNORED AND NOT A LOOKUP IN permit_payments. Same reasoning as
-- processPaidInvoice in the webhook: this endpoint receives every charge on the
-- platform Stripe account, and a charge with no ParkOS payment row behind it is
-- not a malformed payload -- it is simply not ours, or not ours YET.
-- permit_payments has no refund concept at all (its status is check-constrained
-- to 'succeeded' alone), so resolving against it here could only write nothing.
-- Recording permit refunds needs a ledger this schema does not have; that is a
-- feature, and this migration is not it. This migration stops the endpoint from
-- being poisoned by an event it can never apply.
--
-- NOT A WEAKENING OF THE PATH THAT WORKS. Resolution itself is untouched: a
-- charge.refunded that DOES match a payments row takes exactly the same arm and
-- writes exactly the same status. Only the miss changes, and only from "raise,
-- retry forever" to "report it and stop".
--
-- The event is deliberately NOT claimed in processed_stripe_events on this
-- path: there is no org to claim it for (processed_stripe_events.org_id is NOT
-- NULL and is read from the payment row), and a re-delivery re-derives the same
-- answer anyway, so nothing needs the claim to stay idempotent.
--
-- Everything else below is verbatim from 20260819150000 so this file is
-- self-contained if replayed onto a fresh database.

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
