-- A payment reserves money while pending and retains amount minus refunds
-- after settlement. Status alone cannot represent a partial refund.
alter table public.payments add column refunded_cents integer default 0
  check (refunded_cents >= 0 and refunded_cents <= amount_cents);
alter table public.reservations add column payment_version bigint not null default 0;

update public.payments set refunded_cents = amount_cents where status = 'refunded';
-- Historical partial refunds discarded the amount. Do not invent it or make
-- the booking collectable: a verified cumulative refund event can repair it.
update public.payments set refunded_cents = null where status = 'partially_refunded';
-- Historical failed rows did not distinguish a declined retry from a closed
-- Checkout. Hold them until a terminal event or verified session lookup.
update public.payments set status = 'pending' where status = 'failed';
comment on column public.payments.refunded_cents is
  'Cumulative confirmed refund, monotonic. NULL on a historical partial refund requires reconciliation and blocks collection.';

-- Shared by the canonical balance and manifest: no duplicated money formula.
-- INVOKER preserves each reader's RLS; this does not elevate a manifest query.
create function public.reservation_payment_totals(p_reservation_id uuid)
returns table (paid_cents bigint, pending_cents bigint, refund_unknown boolean,
               collectable_cents integer)
language sql stable set search_path = '' as $$
  select m.paid, m.pending, m.unknown,
         case when m.unknown then 0
              else greatest(r.total_cents - m.paid - m.pending, 0)::integer end
    from public.reservations r
    cross join lateral (
      select coalesce(sum(x.paid), 0)::bigint paid,
             coalesce(sum(x.pending), 0)::bigint pending,
             coalesce(bool_or(x.unknown), false) unknown
        from (
          select case when bp.status = 'succeeded' then bp.amount_cents else 0 end paid,
                 0 pending, false unknown
            from public.booth_payments bp
           where bp.reservation_id = r.id and bp.org_id = r.org_id
          union all
          select case when p.status = 'partially_refunded' and
                           (p.refunded_cents is null or p.refunded_cents = 0) then 0
                      when p.status in ('succeeded', 'partially_refunded')
                      then p.amount_cents - coalesce(p.refunded_cents, 0)
                      else 0 end,
                 case when p.status = 'pending' then p.amount_cents else 0 end,
                 p.status = 'partially_refunded' and
                   (p.refunded_cents is null or p.refunded_cents = 0)
            from public.payments p
           where p.reservation_id = r.id and p.org_id = r.org_id
        ) x
    ) m
   where r.id = p_reservation_id
$$;
revoke all on function public.reservation_payment_totals(uuid) from public, anon;
grant execute on function public.reservation_payment_totals(uuid) to authenticated, service_role;

create or replace function public.reservation_balance_cents(p_reservation_id uuid)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare v_org_id uuid; v_customer_id uuid; v_balance integer;
begin
  select org_id, customer_id into v_org_id, v_customer_id
    from public.reservations where id = p_reservation_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;
  if public.get_user_role(v_org_id) is null and not public.is_own_customer(v_customer_id) then
    raise exception using errcode = 'P0001', message = 'NOT_AUTHORIZED';
  end if;
  select collectable_cents into strict v_balance
    from public.reservation_payment_totals(p_reservation_id);
  return v_balance;
end;
$$;

-- Acquire a versioned reservation lock before admitting a new online claim.
-- This races safely with cash collection at READ COMMITTED and REPEATABLE READ.
create function public.reserve_online_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_available integer;
begin
  if new.status <> 'pending' then return new; end if;
  update public.reservations set payment_version = payment_version + 1
   where id = new.reservation_id and org_id = new.org_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;
  select collectable_cents into strict v_available
    from public.reservation_payment_totals(new.reservation_id);
  if new.amount_cents > v_available then
    raise exception using errcode = 'P0001', message = 'AMOUNT_EXCEEDS_BALANCE';
  end if;
  return new;
end;
$$;
revoke all on function public.reserve_online_payment() from public, anon, authenticated, service_role;
create trigger payments_reserve_online before insert on public.payments
for each row execute function public.reserve_online_payment();

create or replace function public.facility_daily_manifest(
  p_facility_id uuid,
  p_date date default null
)
returns table (
  reservation_id  uuid,
  booking_code    text,
  customer_name   text,
  space_number    text,
  zone_name       text,
  starts_at       timestamptz,
  ends_at         timestamptz,
  status          public.reservation_status,
  kind            text,
  total_cents     integer,
  paid_cents      integer,
  balance_cents   integer,
  currency        text,
  checked_in_at   timestamptz,
  checked_out_at  timestamptz
)
language sql
stable
set search_path = ''
as $$
  with target as (
    select f.id  as facility_id,
           public.safe_timezone(f.timezone) as tz,
           coalesce(
             p_date,
             (now() at time zone public.safe_timezone(f.timezone))::date
           ) as local_date
      from public.facilities f
     where f.id = p_facility_id
  )
  select r.id,
         r.booking_code,
         c.full_name,
         s.space_number,
         z.name,
         lower(r.during),
         upper(r.during),
         r.status,
         case
           when (lower(r.during) at time zone t.tz)::date = t.local_date
            and (upper(r.during) at time zone t.tz)::date = t.local_date
             then 'turnaround'
           when (lower(r.during) at time zone t.tz)::date = t.local_date
             then 'arriving'
           else 'departing'
         end,
         r.total_cents,
         paid.paid_cents::integer,
         paid.collectable_cents,
         r.currency,
         r.checked_in_at,
         r.checked_out_at
    from target t
    join public.reservations r
      on r.facility_id = t.facility_id
    join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
    join public.customers c on c.id = r.customer_id and c.org_id = r.org_id
    cross join lateral public.reservation_payment_totals(r.id) paid
   where r.archived_at is null
     and (   (lower(r.during) at time zone t.tz)::date = t.local_date
          or (upper(r.during) at time zone t.tz)::date = t.local_date)
   order by lower(r.during), s.space_number
$$;

create or replace function public.record_booth_payment(
  p_reservation_id uuid,
  p_amount_cents integer,
  p_method text,
  p_note text default null
)
returns table (payment_id uuid, balance_cents integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_currency text;
  v_archived timestamptz;
  v_balance integer;
  v_payment_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_PAYMENT_AMOUNT';
  end if;

  if p_method is null or p_method not in ('cash', 'card') then
    raise exception using errcode = 'P0001', message = 'INVALID_PAYMENT_METHOD';
  end if;

  update public.reservations r set payment_version = r.payment_version + 1
   where r.id = p_reservation_id
   returning r.org_id, r.currency, r.archived_at
    into v_org_id, v_currency, v_archived;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if not public.has_any_role(v_org_id, array['admin','manager','attendant']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  if v_archived is not null then
    raise exception using errcode = 'P0001', message = 'RESERVATION_ARCHIVED';
  end if;

  v_balance := public.reservation_balance_cents(p_reservation_id);

  if p_amount_cents > v_balance then
    raise exception using errcode = 'P0001', message = 'AMOUNT_EXCEEDS_BALANCE';
  end if;

  insert into public.booth_payments
    (org_id, reservation_id, amount_cents, currency, method, collected_by, note)
  values
    (v_org_id, p_reservation_id, p_amount_cents, v_currency, p_method, v_user_id,
     nullif(pg_catalog.btrim(coalesce(p_note, ''::text)), ''::text))
  returning id into v_payment_id;

  insert into public.audit_log
    (org_id, actor_id, action, target_table, target_id, reason)
  values
    (v_org_id, v_user_id, 'record_booth_payment', 'booth_payments', v_payment_id,
     p_method || ' ' || p_amount_cents || ' cents');

  return query select v_payment_id, v_balance - p_amount_cents;
end;
$$;

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
     where p.id = p_payment_id;
  elsif p_checkout_session_id is not null then
    select p.* into v_payment
      from public.payments p
     where p.stripe_checkout_session_id = p_checkout_session_id;
  elsif p_payment_intent_id is not null then
    select p.* into v_payment
      from public.payments p
     where p.stripe_payment_intent_id = p_payment_intent_id;
  else
    -- Still a raise, deliberately: being handed no identifier at all is a
    -- payload this function does not understand, not an event that belongs to
    -- somebody else. Nothing the webhook routes here can reach it today.
    raise exception using errcode = '22023', message = 'PAYMENT_IDENTIFIER_REQUIRED';
  end if;

  -- The event names a charge ParkOS has no payments row for:
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

  -- All money writers take the reservation before locking a ledger row.
  update public.reservations set payment_version = payment_version + 1
   where id = v_payment.reservation_id;
  select * into strict v_payment from public.payments where id = v_payment.id for update;

  if (p_payment_id is not null and p_payment_id <> v_payment.id)
     or (p_reservation_id is not null and p_reservation_id <> v_payment.reservation_id)
     or (p_checkout_session_id is not null
         and p_checkout_session_id <> v_payment.stripe_checkout_session_id
         and v_payment.stripe_checkout_session_id <> 'parkos_pending:' || v_payment.id::text)
     or (p_payment_intent_id is not null
         and v_payment.stripe_payment_intent_id is not null
         and p_payment_intent_id <> v_payment.stripe_payment_intent_id) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_IDENTIFIER_MISMATCH';
  end if;

  -- Claim the event. A conflict means a concurrent invocation
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
       set stripe_checkout_session_id = coalesce(p_checkout_session_id, p.stripe_checkout_session_id),
           stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id,
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
       and r.org_id = v_payment.org_id;

    if not found then
      raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
    end if;

    v_amount_currency_match :=
      p_amount_cents is not null
      and p_currency is not null
      and p_amount_cents = v_payment.amount_cents
      and upper(p_currency) = upper(v_payment.currency)
      and upper(p_currency) = upper(v_reservation_currency);

    if v_payment.status <> 'succeeded' then
      v_outcome := 'completion_ignored_after_' || v_payment.status;
    elsif v_reservation_status = 'pending' and v_amount_currency_match
      and (select paid_cents >= v_reservation_total_cents
             from public.reservation_payment_totals(v_payment.reservation_id)) then
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

    if p_amount_cents is not null and p_amount_cents <> v_payment.amount_cents then
      raise exception using errcode = '22023', message = 'REFUND_CHARGE_AMOUNT_MISMATCH';
    end if;
    if p_amount_refunded_cents > v_payment.amount_cents then
      raise exception using errcode = '22023', message = 'REFUND_EXCEEDS_PAYMENT';
    end if;
    v_refund_total := greatest(coalesce(v_payment.refunded_cents, 0), p_amount_refunded_cents);
    update public.payments p
       set stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id, p_payment_intent_id),
           refunded_cents = v_refund_total,
           status = case
             when p.status = 'refunded' or v_refund_total >= p.amount_cents then 'refunded'
             when v_refund_total > 0 then 'partially_refunded'
             else p.status end
     where p.id = v_payment.id returning p.* into v_payment;

    v_outcome := 'payment_' || v_payment.status;

  elsif p_event_type in ('payment_intent.payment_failed', 'charge.failed') then
    -- A declined attempt can still be retried in an open Checkout. It is not
    -- permission to collect cash. The terminal session event releases its claim.
    v_outcome := 'payment_attempt_failed_checkout_open';

  elsif p_event_type in (
    'checkout.session.async_payment_failed',
    'checkout.session.expired'
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
