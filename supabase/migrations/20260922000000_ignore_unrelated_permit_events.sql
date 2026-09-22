-- A valid subscription identifier that matches no ParkOS permit is a no-op.
-- Do not claim its event id, write money, or mutate a permit. An explicit permit
-- id that cannot be resolved still raises PERMIT_NOT_FOUND; missing/blank
-- identifiers, mismatches, authorization and payload errors remain errors.
-- CREATE OR REPLACE retains the signatures and service-role-only privileges.

create or replace function public.record_permit_payment(
  p_event_id text,
  p_permit_id uuid default null,
  p_stripe_subscription_id text default null,
  p_stripe_invoice_id text default null,
  p_amount_cents integer default null,
  p_currency text default null,
  p_stripe_payment_intent_id text default null,
  p_paid boolean default null
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
  v_payment_id uuid;
  v_currency text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = 'P0001', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_event_id is null or length(trim(p_event_id)) = 0 then
    raise exception using errcode = '22023', message = 'STRIPE_EVENT_ID_REQUIRED';
  end if;
  if p_stripe_invoice_id is null or length(trim(p_stripe_invoice_id)) = 0 then
    raise exception using errcode = '22023', message = 'STRIPE_INVOICE_ID_REQUIRED';
  end if;
  -- The event name says the invoice was paid; the payload has to agree. If it
  -- ever does not, that is a payload we do not understand, not money to book.
  if p_paid is distinct from true then
    raise exception using errcode = '22023', message = 'INVOICE_NOT_PAID';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_AMOUNT';
  end if;
  if p_currency is null or p_currency !~ '^[A-Za-z]{3}$' then
    raise exception using errcode = '22023', message = 'INVALID_CURRENCY';
  end if;
  v_currency := upper(p_currency);

  -- FOR UPDATE, like every other permit lifecycle write: a payment landing while
  -- a cancellation is applying must serialize behind it rather than interleave.
  if p_permit_id is not null then
    select p.* into v_permit from public.permits p
     where p.id = p_permit_id for update;
  elsif nullif(trim(p_stripe_subscription_id), '') is not null then
    select p.* into v_permit from public.permits p
     where p.stripe_subscription_id = p_stripe_subscription_id for update;
  else
    raise exception using errcode = '22023', message = 'PERMIT_IDENTIFIER_REQUIRED';
  end if;
  if not found then
    -- A subscription-only miss can belong to another app on the Stripe account.
    -- A supplied ParkOS permit id is an explicit ownership claim: keep failures
    -- retryable instead of silently acknowledging a missing application record.
    if p_permit_id is not null then
      raise exception using errcode = 'P0002', message = 'PERMIT_NOT_FOUND';
    end if;
    return jsonb_build_object('processed', false, 'outcome', 'permit_not_found');
  end if;
  if p_stripe_subscription_id is not null
     and v_permit.stripe_subscription_id is not null
     and p_stripe_subscription_id <> v_permit.stripe_subscription_id then
    raise exception using errcode = 'P0001', message = 'PERMIT_IDENTIFIER_MISMATCH';
  end if;

  -- Deliberately NOT gated on permit status or archived_at. Stripe has already
  -- taken this money; refusing to write it down because the permit was since
  -- cancelled would lose the record AND make Stripe retry the delivery forever.
  -- The ledger records what happened, not what should have happened.

  -- First write: the event claim and the payment row commit or roll back
  -- together, same as process_stripe_subscription_event.
  insert into public.processed_stripe_events (event_id, org_id)
  values (p_event_id, v_permit.org_id)
  on conflict (event_id) do nothing
  returning event_id into v_claimed;
  if v_claimed is null then
    return jsonb_build_object('processed', false, 'outcome', 'duplicate_event');
  end if;

  -- Second line of defence, and the one that holds when Stripe re-delivers the
  -- same invoice under a NEW event id: unique on stripe_invoice_id.
  insert into public.permit_payments (
    org_id, permit_id, stripe_invoice_id, stripe_payment_intent_id,
    amount_cents, currency
  ) values (
    v_permit.org_id, v_permit.id, p_stripe_invoice_id, p_stripe_payment_intent_id,
    p_amount_cents, v_currency
  )
  on conflict (stripe_invoice_id) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    return jsonb_build_object('processed', false, 'outcome', 'duplicate_invoice');
  end if;

  insert into public.audit_log (
    org_id, actor_id, action, target_table, target_id, reason
  ) values (
    v_permit.org_id, null, 'record_permit_payment', 'permit_payments',
    v_payment_id, p_stripe_invoice_id || ' ' || p_amount_cents || ' cents'
  );

  return jsonb_build_object(
    'processed', true, 'outcome', 'permit_payment_recorded',
    'permit_id', v_permit.id, 'payment_id', v_payment_id
  );
end;
$$;

-- `revoke all ... from public` does NOT drop the direct grant Supabase default
-- privileges hand `authenticated` on a newly created function -- that is the
-- whole subject of 20260827000000. Revoke it by name, or every signed-in browser
-- can call this and assert that Stripe collected money.
revoke all on function public.record_permit_payment(
  text, uuid, text, text, integer, text, text, boolean
) from public, anon, authenticated;

grant execute on function public.record_permit_payment(
  text, uuid, text, text, integer, text, text, boolean
) to service_role;

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
  elsif nullif(trim(p_stripe_subscription_id), '') is not null then
    select p.* into v_permit from public.permits p
     where p.stripe_subscription_id = p_stripe_subscription_id for update;
  else
    raise exception using errcode = '22023', message = 'PERMIT_IDENTIFIER_REQUIRED';
  end if;
  if not found then
    -- A subscription-only miss can belong to another app on the Stripe account.
    -- A supplied ParkOS permit id is an explicit ownership claim: keep failures
    -- retryable instead of silently acknowledging a missing application record.
    if p_permit_id is not null then
      raise exception using errcode = 'P0002', message = 'PERMIT_NOT_FOUND';
    end if;
    return jsonb_build_object('processed', false, 'outcome', 'permit_not_found');
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
