-- ParkOS Week 9: Stripe Checkout payments (platform-collects model).
--
-- Authenticated clients can read payments allowed by RLS, but can never write
-- them. A checkout creator may insert the initial `pending` attempt with the
-- service role; every later state transition is derived from a signed Stripe
-- webhook and applied with the service role. A client claim that money moved
-- must never become payment state.

-- Stripe event IDs are externally assigned, globally unique idempotency keys.
-- This operational ledger deliberately uses that natural text key instead of a
-- ParkOS UUID so the database can reject the same Stripe event atomically.

alter table public.reservations
  add constraint reservations_org_id_id_key unique (org_id, id);

create table public.payments (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references public.organizations(id),
  reservation_id              uuid not null,
  stripe_checkout_session_id  text not null unique,
  stripe_payment_intent_id    text,
  amount_cents                integer not null check (amount_cents >= 0),
  currency                    text not null default 'USD' check (char_length(currency) = 3),
  status                      text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint payments_org_id_reservation_id_fkey
    foreign key (org_id, reservation_id)
    references public.reservations (org_id, id)
);

create index payments_org_id_idx on public.payments (org_id);
create index payments_reservation_id_idx on public.payments (reservation_id);
create unique index payments_stripe_payment_intent_id_key
  on public.payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create table public.processed_stripe_events (
  event_id      text primary key,
  org_id        uuid not null references public.organizations(id),
  processed_at  timestamptz not null default now(),
  check (length(event_id) > 0)
);

create index processed_stripe_events_org_id_idx
  on public.processed_stripe_events (org_id);

comment on table public.payments is
  'Authenticated clients are read-only. Pending attempts are created by trusted service code; subsequent payment state is written only from Stripe-signed webhooks, never from a client claim.';
comment on table public.processed_stripe_events is
  'Service-role-only idempotency ledger for successfully applied Stripe webhook events.';

-- Keep updated_at correct for every trusted payment transition.
create or replace function public.set_payment_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.set_payment_updated_at() from public;
grant execute on function public.set_payment_updated_at() to service_role;

create trigger payments_set_updated_at
before update on public.payments
for each row
execute function public.set_payment_updated_at();

-- Explicit grants are required because api.auto_expose_new_tables is disabled.
-- RLS decides which payment rows an authenticated caller may read. There are
-- deliberately no authenticated INSERT, UPDATE, DELETE, or ALL policies/grants.
revoke all on public.payments from anon, authenticated;
revoke all on public.processed_stripe_events from anon, authenticated;
grant select on public.payments to authenticated;
grant select, insert, update, delete on
  public.payments, public.processed_stripe_events
to service_role;

alter table public.payments enable row level security;

create policy payments_select_members on public.payments
  for select
  to authenticated
  using (public.get_user_role(org_id) is not null);

create policy payments_select_own on public.payments
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.reservations r
       where r.id = payments.reservation_id
         and r.org_id = payments.org_id
         and public.is_own_customer(r.customer_id)
    )
  );

-- Zero policies is intentional: only service_role (which bypasses RLS) uses
-- this table, through process_stripe_event below.
alter table public.processed_stripe_events enable row level security;

-- Week 8's function accepted only a staff JWT. Stripe's webhook has no end-user
-- JWT, so allow the service role explicitly while preserving the staff check.
-- Automated confirmations leave actor_id null in the existing audit trail.
create or replace function public.confirm_reservation(p_reservation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request_role text := auth.role();
  v_user_id uuid;
  v_org_id uuid;
  v_status public.reservation_status;
begin
  if v_request_role = 'service_role' then
    v_user_id := null;
  else
    v_user_id := auth.uid();
    if v_user_id is null then
      raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
    end if;
  end if;

  select r.org_id, r.status into v_org_id, v_status
    from public.reservations r
   where r.id = p_reservation_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if v_request_role <> 'service_role'
     and not public.has_any_role(v_org_id, array['admin','manager','attendant']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  if v_status <> 'pending' then
    raise exception using errcode = 'P0001',
      message = 'CANNOT_CONFIRM_FROM_' || upper(v_status::text);
  end if;

  update public.reservations
     set status = 'confirmed'
   where id = p_reservation_id;

  insert into public.audit_log (org_id, actor_id, action, target_table, target_id)
  values (v_org_id, v_user_id, 'confirm_reservation', 'reservations', p_reservation_id);
end;
$$;

revoke all on function public.confirm_reservation(uuid) from public;
grant execute on function public.confirm_reservation(uuid) to authenticated, service_role;

-- Apply one normalized Stripe event atomically. The processed-event INSERT is
-- the first write. If a later update or confirmation raises, PostgreSQL rolls
-- that claim back too, allowing Stripe's retry to perform the work. Concurrent
-- deliveries of the same event serialize on event_id; exactly one is applied.
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
    raise exception using errcode = '22023', message = 'PAYMENT_IDENTIFIER_REQUIRED';
  end if;

  if not found then
    raise exception using errcode = 'P0002', message = 'PAYMENT_NOT_FOUND';
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

revoke all on function public.process_stripe_event(
  text, text, uuid, uuid, text, text, integer, text, integer
) from public;
grant execute on function public.process_stripe_event(
  text, text, uuid, uuid, text, text, integer, text, integer
) to service_role;
