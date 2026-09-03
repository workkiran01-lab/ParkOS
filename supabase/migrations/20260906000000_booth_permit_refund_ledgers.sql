-- ParkOS: refund ledgers for booth cash/card money and permit subscription money.
--
-- Until now only `payments` (Stripe reservation money) could be refunded. Booth
-- money had no reversal at all, and a permit refund issued in the Stripe
-- Dashboard was acknowledged and dropped on the floor (20260905000000). Both
-- ledgers now carry a status, and both revenue and balance reporting learn to
-- read it.
--
-- WHY A STATUS COLUMN AND NOT A NEGATIVE ROW
--   `booth_payments.amount_cents > 0` and `permit_payments.stripe_invoice_id`
--   UNIQUE are both load-bearing. A negative correction row would have to break
--   the first, and a second row for the same invoice would have to break the
--   second -- the very index that makes webhook re-delivery idempotent. A status
--   flip keeps both.
--   THE DOCUMENTED COST: a status column records THAT money came back, not WHEN.
--   The refund date is not captured on the ledger row. `audit_log` carries the
--   actor and the timestamp of the reversal, so the information is recoverable
--   for an investigation, but it is not queryable as ledger data and no report
--   can bucket a refund into the day it happened -- a refund silently removes
--   money from the day it was COLLECTED. Accepted for v1. A `refunded_at`
--   column is the fix when refund-date reporting is actually wanted.
--
-- WHY FULL REFUNDS ONLY, AND HOW PARTIALS STAY OPEN
--   v1 reverses a payment entirely. The column is deliberately `text` with a
--   CHECK list, exactly like `payments.status`, NOT a boolean `refunded` flag:
--   adding 'partially_refunded' later is one constraint swap plus an amount
--   column, and every reporting predicate written below is already spelled
--   `status = 'succeeded'` / `status <> 'succeeded'` rather than
--   `not refunded`, so partial rows would fall out of revenue on their own
--   instead of silently counting in full. Nothing here has to be unpicked.
--
-- WHY REFUNDS ARE admin/manager WHILE COLLECTION IS admin/manager/attendant
--   The asymmetry is the control, not an oversight. An attendant who could both
--   take cash and reverse it could skim: collect, pocket, reverse the record.
--   Requiring a second, higher role to reverse means the reversal is always
--   visible to somebody who did not take the money. `record_booth_payment`
--   keeps attendant; `refund_booth_payment` does not have it.

-- ---------------------------------------------------------------------------
-- Status columns
-- ---------------------------------------------------------------------------

-- DEFAULT 'succeeded' backfills every existing row as collected, which is what
-- they are: nothing could be refunded before this migration existed.
alter table public.booth_payments
  add column status text not null default 'succeeded'
    check (status in ('succeeded', 'refunded'));

comment on column public.booth_payments.status is
  'succeeded = money is collected and counts as revenue. refunded = reversed by an admin or manager; excluded from every revenue report and from the reservation balance, so the reservation becomes collectable again. Full reversals only in v1; the CHECK list is where partially_refunded goes. The reversal DATE lives only in audit_log, not here.';

-- permit_payments.status already existed but was check-constrained to the
-- single value 'succeeded'. Widen it rather than adding a second column.
alter table public.permit_payments
  drop constraint permit_payments_status_check;
alter table public.permit_payments
  add constraint permit_payments_status_check
    check (status in ('succeeded', 'refunded'));

comment on column public.permit_payments.status is
  'succeeded = Stripe collected and kept this invoice. refunded = a full refund was issued against its PaymentIntent and confirmed by charge.refunded. Refunding does NOT void the invoice or cancel the subscription: the permit keeps billing. Full reversals only in v1; the CHECK list is where partially_refunded goes.';

-- ---------------------------------------------------------------------------
-- refund_booth_payment -- a ledger correction, not money movement
-- ---------------------------------------------------------------------------

-- There is no Stripe object behind booth money: the cash left the drawer or the
-- card was run on a terminal ParkOS does not talk to. Reversing it is a staff
-- ATTESTATION that the money went back, recorded the same way
-- record_booth_payment records the attestation that it came in -- same audit_log
-- entry, same actor, one row changed. No Edge Function is involved because
-- there is no external system to call.
create or replace function public.refund_booth_payment(
  p_booth_payment_id uuid,
  p_reason text default null
)
returns table (booth_payment_id uuid, balance_cents integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment public.booth_payments%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select bp.* into v_payment
    from public.booth_payments bp
   where bp.id = p_booth_payment_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'BOOTH_PAYMENT_NOT_FOUND';
  end if;

  -- admin/manager only. Deliberately NOT the attendant role that
  -- record_booth_payment accepts; see the header.
  if not public.has_any_role(v_payment.org_id, array['admin','manager']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  -- Idempotent by refusal rather than by silence: reversing an already-reversed
  -- payment is a mistake worth surfacing to the person doing it, not a no-op.
  if v_payment.status = 'refunded' then
    raise exception using errcode = 'P0001', message = 'ALREADY_REFUNDED';
  end if;

  update public.booth_payments bp
     set status = 'refunded'
   where bp.id = v_payment.id;

  insert into public.audit_log
    (org_id, actor_id, action, target_table, target_id, reason)
  values
    (v_payment.org_id, v_user_id, 'refund_booth_payment', 'booth_payments',
     v_payment.id,
     v_payment.method || ' ' || v_payment.amount_cents || ' cents' ||
     coalesce(' -- ' || nullif(pg_catalog.btrim(coalesce(p_reason, ''::text)), ''::text), ''::text));

  -- The balance AFTER the reversal, which is what the booth screen needs: the
  -- reservation is collectable again for exactly this amount.
  return query
    select v_payment.id,
           public.reservation_balance_cents(v_payment.reservation_id);
end;
$$;

revoke all on function public.refund_booth_payment(uuid, text)
  from public, anon;
grant execute on function public.refund_booth_payment(uuid, text) to authenticated;

comment on function public.refund_booth_payment(uuid, text) is
  'Reverse one booth cash/card payment. admin/manager only -- attendants may collect but never reverse, which is the anti-skimming control. Records a staff attestation in audit_log; no Stripe object exists for booth money. Returns the reservation balance after the reversal.';

-- ---------------------------------------------------------------------------
-- record_permit_refund -- written from the signed webhook, never from a client
-- ---------------------------------------------------------------------------

-- Same contract as record_permit_payment: service-role only, claims the event in
-- processed_stripe_events, returns the {processed, outcome} jsonb the webhook
-- already knows how to read. Resolution is by PaymentIntent id because a refund
-- arrives as charge.refunded, whose charge metadata does NOT carry the metadata
-- attached to the refund -- exactly the reason the reservation path resolves the
-- same way.
create or replace function public.record_permit_refund(
  p_event_id text,
  p_stripe_payment_intent_id text default null,
  p_amount_cents integer default null,
  p_amount_refunded_cents integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.permit_payments%rowtype;
  v_claimed text;
  v_refund_total integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = 'P0001', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_event_id is null or length(trim(p_event_id)) = 0 then
    raise exception using errcode = '22023', message = 'STRIPE_EVENT_ID_REQUIRED';
  end if;

  if exists (
    select 1 from public.processed_stripe_events e where e.event_id = p_event_id
  ) then
    return pg_catalog.jsonb_build_object('processed', false,
                                         'outcome', 'duplicate_event');
  end if;

  -- No identifier is not an error here, for the same reason it is not one in
  -- processPaidInvoice: this endpoint sees every charge on the platform account.
  if p_stripe_payment_intent_id is null
     or length(trim(p_stripe_payment_intent_id)) = 0 then
    return pg_catalog.jsonb_build_object('processed', false,
                                         'outcome', 'permit_payment_not_found');
  end if;

  select pp.* into v_payment
    from public.permit_payments pp
   where pp.stripe_payment_intent_id = p_stripe_payment_intent_id
   for update;

  -- Not ours. Answer, do not raise -- 20260905000000 exists because raising here
  -- makes Stripe retry an event that can never apply.
  if not found then
    return pg_catalog.jsonb_build_object('processed', false,
                                         'outcome', 'permit_payment_not_found');
  end if;

  if v_payment.status = 'refunded' then
    return pg_catalog.jsonb_build_object('processed', false,
                                         'outcome', 'already_refunded',
                                         'permit_payment_id', v_payment.id);
  end if;

  -- v1 records FULL reversals only. A Dashboard partial refund is reported and
  -- deliberately not written: recording it as a full reversal would erase money
  -- ParkOS still holds. Answering rather than raising keeps Stripe from
  -- retrying it forever, which is the whole point of the guard above.
  v_refund_total := coalesce(p_amount_cents, v_payment.amount_cents);
  if p_amount_refunded_cents is null
     or p_amount_refunded_cents < v_refund_total then
    return pg_catalog.jsonb_build_object(
      'processed', false,
      'outcome', 'partial_refund_not_supported',
      'permit_payment_id', v_payment.id);
  end if;

  insert into public.processed_stripe_events (event_id, org_id)
  values (p_event_id, v_payment.org_id)
  on conflict (event_id) do nothing
  returning event_id into v_claimed;
  if v_claimed is null then
    return pg_catalog.jsonb_build_object('processed', false,
                                         'outcome', 'duplicate_event');
  end if;

  update public.permit_payments pp
     set status = 'refunded'
   where pp.id = v_payment.id;

  insert into public.audit_log
    (org_id, actor_id, action, target_table, target_id, reason)
  values
    (v_payment.org_id, null, 'record_permit_refund', 'permit_payments',
     v_payment.id,
     v_payment.stripe_invoice_id || ' ' || v_payment.amount_cents || ' cents refunded');

  return pg_catalog.jsonb_build_object(
    'processed', true,
    'outcome', 'permit_payment_refunded',
    'permit_payment_id', v_payment.id,
    'permit_id', v_payment.permit_id);
end;
$$;

revoke all on function public.record_permit_refund(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.record_permit_refund(text, text, integer, integer)
  to service_role;

comment on function public.record_permit_refund(text, text, integer, integer) is
  'Mark one permit invoice payment refunded, from a signature-verified charge.refunded. Service-role only. Resolves by PaymentIntent id because charge metadata does not carry refund metadata. Full reversals only: a partial refund is reported, not written. Never touches the permit, its subscription, or the invoice.';

-- ---------------------------------------------------------------------------
-- THE SIX READERS. Every one of these summed booth money with no status
-- predicate at all, so a refunded booth payment would have kept counting as
-- revenue -- silently, because the row is still there and still positive.
-- ---------------------------------------------------------------------------

-- (1 of 6) reservation_balance_cents -- CANONICAL definition of a balance.
-- Without the predicate a refunded reservation stays at zero balance and can
-- never be re-collected at the booth.
create or replace function public.reservation_balance_cents(p_reservation_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_customer_id uuid;
  v_total integer;
  v_paid integer;
begin
  select r.org_id, r.customer_id, r.total_cents
    into v_org_id, v_customer_id, v_total
    from public.reservations r
   where r.id = p_reservation_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if public.get_user_role(v_org_id) is null
     and not public.is_own_customer(v_customer_id) then
    raise exception using errcode = 'P0001', message = 'NOT_AUTHORIZED';
  end if;

  select coalesce(pg_catalog.sum(collected.amount_cents), 0::bigint)
    into v_paid
    from (
      select bp.amount_cents
        from public.booth_payments bp
       where bp.reservation_id = p_reservation_id
         and bp.org_id = v_org_id
         and bp.status = 'succeeded'
      union all
      select p.amount_cents
        from public.payments p
       where p.reservation_id = p_reservation_id
         and p.org_id = v_org_id
         and p.status = 'succeeded'
    ) collected;

  return greatest(v_total - v_paid, 0);
end;
$$;

-- (2 of 6) facility_daily_manifest -- the documented DUPLICATE of the balance
-- above. The comment on both functions says to change them together; this is
-- that. If these two disagree the manifest and the booth screen show different
-- money for the same reservation.
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
         paid.amount,
         greatest(r.total_cents - paid.amount, 0),
         r.currency,
         r.checked_in_at,
         r.checked_out_at
    from target t
    join public.reservations r
      on r.facility_id = t.facility_id
    join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
    join public.customers c on c.id = r.customer_id and c.org_id = r.org_id
    -- Money is summed inline rather than by calling
    -- public.reservation_balance_cents(uuid) per row: that function is
    -- SECURITY DEFINER and takes one reservation id, so a manifest of N rows
    -- would be N elevated calls inside one query. reservation_balance_cents
    -- REMAINS THE CANONICAL DEFINITION of what a reservation balance is --
    -- this is a duplicate of it, and the two must agree row for row. If you
    -- change one, change the other.
    left join lateral (
      select coalesce(pg_catalog.sum(collected.amount_cents), 0::bigint)::integer
               as amount
        from (
          select bp.amount_cents
            from public.booth_payments bp
           where bp.reservation_id = r.id
             and bp.org_id = r.org_id
             and bp.status = 'succeeded'
          union all
          select p.amount_cents
            from public.payments p
           where p.reservation_id = r.id
             and p.org_id = r.org_id
             and p.status = 'succeeded'
        ) collected
    ) paid on true
   where r.archived_at is null
     and (   (lower(r.during) at time zone t.tz)::date = t.local_date
          or (upper(r.during) at time zone t.tz)::date = t.local_date)
   order by lower(r.during), s.space_number
$$;

-- (3 of 6) facility_dashboard_summary -- today's headline money.
create or replace function public.facility_dashboard_summary(p_facility_id uuid)
returns table (
  total_spaces                           integer,
  held_now                               integer,
  occupancy_pct                          numeric,
  today_revenue_cents                    bigint,
  today_stripe_revenue_cents             bigint,
  today_booth_cash_revenue_cents         bigint,
  today_booth_card_revenue_cents         bigint,
  today_permit_revenue_cents             bigint
)
language sql
stable
set search_path = ''
as $$
  with tz as (
    select f.timezone as zone
      from public.facilities f
     where f.id = p_facility_id
       and f.archived_at is null
  ),
  active_spaces as (
    select s.id
      from public.spaces s
      join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
     where z.facility_id = p_facility_id
       and s.archived_at is null
       and z.archived_at is null
  ),
  held as (
    select distinct h.space_id
      from public.space_holds h
      join active_spaces a on a.id = h.space_id
     where h.released_at is null
       and h.during @> now()
  ),
  stripe_revenue as (
    select coalesce(pg_catalog.sum(p.amount_cents), 0::bigint) as cents
      from public.payments p
      join public.reservations r
        on r.id = p.reservation_id and r.org_id = p.org_id
      cross join tz
     where r.facility_id = p_facility_id
       and p.status = 'succeeded'
       and (p.created_at at time zone tz.zone)::date
           = (now() at time zone tz.zone)::date
  ),
  booth_revenue as (
    select coalesce(
             pg_catalog.sum(bp.amount_cents) filter (where bp.method = 'cash'),
             0::bigint
           ) as cash_cents,
           coalesce(
             pg_catalog.sum(bp.amount_cents) filter (where bp.method = 'card'),
             0::bigint
           ) as card_cents
      from public.booth_payments bp
      join public.reservations r
        on r.id = bp.reservation_id and r.org_id = bp.org_id
      cross join tz
     where r.facility_id = p_facility_id
       and bp.status = 'succeeded'
       and (bp.created_at at time zone tz.zone)::date
           = (now() at time zone tz.zone)::date
  ),
  -- No reservation hop: the permit names its own facility. Same tz.zone as the
  -- two CTEs above, so all three bin on the identical local calendar day.
  permit_revenue as (
    select coalesce(pg_catalog.sum(pp.amount_cents), 0::bigint) as cents
      from public.permit_payments pp
      join public.permits pr
        on pr.id = pp.permit_id and pr.org_id = pp.org_id
      cross join tz
     where pr.facility_id = p_facility_id
       and pp.status = 'succeeded'
       and (pp.created_at at time zone tz.zone)::date
           = (now() at time zone tz.zone)::date
  )
  select
    (select pg_catalog.count(*) from active_spaces)::integer as total_spaces,
    (select pg_catalog.count(*) from held)::integer as held_now,
    case
      when (select pg_catalog.count(*) from active_spaces) = 0 then 0
      else pg_catalog.round(
        (select pg_catalog.count(*) from held)::numeric * 100
        / (select pg_catalog.count(*) from active_spaces), 1)
    end as occupancy_pct,
    sr.cents + br.cash_cents + br.card_cents + pr.cents as today_revenue_cents,
    sr.cents as today_stripe_revenue_cents,
    br.cash_cents as today_booth_cash_revenue_cents,
    br.card_cents as today_booth_card_revenue_cents,
    pr.cents as today_permit_revenue_cents
  from stripe_revenue sr
  cross join booth_revenue br
  cross join permit_revenue pr;
$$;

-- (4 of 6) report_revenue_by_period -- the one function that both mis-summed AND
-- under-reported. Two separate defects:
--   a. the booth and permit arms hard-coded the STATUS LITERAL 'succeeded', so a
--      refunded row entered the CTE labelled as collected money;
--   b. every booth_* and permit_* output column filtered on `source` alone with
--      no status predicate, so even a correctly-labelled refunded row would
--      still have been added into booth_cash_revenue_cents et al.
-- Both arms now carry the row's REAL status, and every per-source aggregate
-- filters on it, which is what the stripe_* columns already did. That also
-- widens refunded_count to all three ledgers: it counts by status across every
-- source, so once booth and permit rows can say 'refunded' they are counted --
-- the permit arm's old `where pp.status = 'succeeded'` had been hiding them
-- from that tile entirely.
create or replace function public.report_revenue_by_period(
  p_from date,
  p_to date,
  p_facility_id uuid default null,
  p_grain text default 'day'
)
returns table (
  bucket                              date,
  payments_count                      bigint,
  revenue_cents                       bigint,
  refunded_count                      bigint,
  stripe_payments_count               bigint,
  stripe_revenue_cents                bigint,
  booth_cash_payments_count           bigint,
  booth_cash_revenue_cents            bigint,
  booth_card_payments_count           bigint,
  booth_card_revenue_cents            bigint,
  permit_payments_count               bigint,
  permit_revenue_cents                bigint
)
language sql
stable
set search_path = ''
as $$
  with local_payments as (
    select 'stripe'::text as source,
           p.status,
           p.amount_cents,
           (p.created_at at time zone public.safe_timezone(f.timezone))::date as local_day
      from public.payments p
      join public.reservations r
        on r.id = p.reservation_id and r.org_id = p.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where p_facility_id is null or r.facility_id = p_facility_id

    union all

    -- Real status, not a literal: a refunded booth payment must not enter this
    -- CTE claiming to be collected money.
    select ('booth_' || bp.method)::text,
           bp.status,
           bp.amount_cents,
           (bp.created_at at time zone public.safe_timezone(f.timezone))::date
      from public.booth_payments bp
      join public.reservations r
        on r.id = bp.reservation_id and r.org_id = bp.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where p_facility_id is null or r.facility_id = p_facility_id

    union all

    -- Permits reach the facility directly. The old `and pp.status = 'succeeded'`
    -- is GONE ON PURPOSE: filtering refunded permit rows out of the CTE kept
    -- them out of revenue correctly but also kept them out of refunded_count,
    -- which is a tile that must speak for all three ledgers. The status
    -- predicate now lives on the aggregates instead.
    select 'permit'::text,
           pp.status,
           pp.amount_cents,
           (pp.created_at at time zone public.safe_timezone(f.timezone))::date
      from public.permit_payments pp
      join public.permits pr
        on pr.id = pp.permit_id and pr.org_id = pp.org_id
      join public.facilities f on f.id = pr.facility_id and f.org_id = pr.org_id
     where p_facility_id is null or pr.facility_id = p_facility_id
  ),
  bucketed as (
    select case pg_catalog.lower(coalesce(p_grain, 'day'))
             when 'week' then pg_catalog.date_trunc('week', local_day)::date
             when 'month' then pg_catalog.date_trunc('month', local_day)::date
             else local_day
           end as bucket,
           source,
           status,
           amount_cents
      from local_payments
     where local_day between p_from and p_to
  )
  select bucketed.bucket as bucket,
         pg_catalog.count(*) filter (
           where status = 'succeeded')::bigint as payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where status = 'succeeded'),
           0::bigint
         ) as revenue_cents,
         pg_catalog.count(*) filter (
           where status in ('refunded', 'partially_refunded'))::bigint
           as refunded_count,
         pg_catalog.count(*) filter (
           where source = 'stripe' and status = 'succeeded')::bigint
           as stripe_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (
             where source = 'stripe' and status = 'succeeded'),
           0::bigint
         ) as stripe_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'booth_cash' and status = 'succeeded')::bigint
           as booth_cash_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (
             where source = 'booth_cash' and status = 'succeeded'),
           0::bigint
         ) as booth_cash_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'booth_card' and status = 'succeeded')::bigint
           as booth_card_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (
             where source = 'booth_card' and status = 'succeeded'),
           0::bigint
         ) as booth_card_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'permit' and status = 'succeeded')::bigint
           as permit_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (
             where source = 'permit' and status = 'succeeded'),
           0::bigint
         ) as permit_revenue_cents
    from bucketed
   group by bucketed.bucket
  having pg_catalog.count(*) filter (
           where status in ('succeeded', 'refunded', 'partially_refunded')) > 0
   order by bucketed.bucket;
$$;

-- (5 of 6) report_revenue_by_space_type -- filters inside the CTE, so the booth
-- arm needs the predicate its stripe and permit siblings already had.
create or replace function public.report_revenue_by_space_type(
  p_from date,
  p_to date,
  p_facility_id uuid default null
)
returns table (
  space_type                           text,
  payments_count                       bigint,
  revenue_cents                        bigint,
  stripe_payments_count                bigint,
  stripe_revenue_cents                 bigint,
  booth_cash_payments_count            bigint,
  booth_cash_revenue_cents             bigint,
  booth_card_payments_count            bigint,
  booth_card_revenue_cents             bigint,
  permit_payments_count                bigint,
  permit_revenue_cents                 bigint
)
language sql
stable
set search_path = ''
as $$
  with collected as (
    select s.space_type::text as space_type,
           'stripe'::text as source,
           p.amount_cents
      from public.payments p
      join public.reservations r
        on r.id = p.reservation_id and r.org_id = p.org_id
      join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where p.status = 'succeeded'
       and (p_facility_id is null or r.facility_id = p_facility_id)
       and (p.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to

    union all

    select s.space_type::text,
           ('booth_' || bp.method)::text,
           bp.amount_cents
      from public.booth_payments bp
      join public.reservations r
        on r.id = bp.reservation_id and r.org_id = bp.org_id
      join public.spaces s on s.id = r.space_id and s.org_id = r.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where bp.status = 'succeeded'
       and (p_facility_id is null or r.facility_id = p_facility_id)
       and (bp.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to

    union all

    -- The permit's own space, not a reservation's. No archived_at filter, so an
    -- archived space keeps contributing its type exactly as above.
    select s.space_type::text,
           'permit'::text,
           pp.amount_cents
      from public.permit_payments pp
      join public.permits pr
        on pr.id = pp.permit_id and pr.org_id = pp.org_id
      join public.spaces s on s.id = pr.space_id and s.org_id = pr.org_id
      join public.facilities f on f.id = pr.facility_id and f.org_id = pr.org_id
     where pp.status = 'succeeded'
       and (p_facility_id is null or pr.facility_id = p_facility_id)
       and (pp.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to
  )
  select collected.space_type as space_type,
         pg_catalog.count(*)::bigint as payments_count,
         pg_catalog.sum(amount_cents)::bigint as revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'stripe')::bigint as stripe_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'stripe'),
           0::bigint
         ) as stripe_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'booth_cash')::bigint as booth_cash_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_cash'),
           0::bigint
         ) as booth_cash_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'booth_card')::bigint as booth_card_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_card'),
           0::bigint
         ) as booth_card_revenue_cents,
         pg_catalog.count(*) filter (
           where source = 'permit')::bigint as permit_payments_count,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'permit'),
           0::bigint
         ) as permit_revenue_cents
    from collected
   group by collected.space_type
   order by revenue_cents desc;
$$;

-- (6 of 6) report_revenue_split -- same shape, same missing predicate.
create or replace function public.report_revenue_split(
  p_from date,
  p_to date,
  p_facility_id uuid default null
)
returns table (
  category                           text,
  revenue_cents                      bigint,
  stripe_revenue_cents               bigint,
  booth_cash_revenue_cents           bigint,
  booth_card_revenue_cents           bigint,
  recorded                           boolean,
  note                               text
)
language sql
stable
set search_path = ''
as $$
  with collected as (
    select 'stripe'::text as source,
           p.amount_cents
      from public.payments p
      join public.reservations r
        on r.id = p.reservation_id and r.org_id = p.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where p.status = 'succeeded'
       and (p_facility_id is null or r.facility_id = p_facility_id)
       and (p.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to

    union all

    select ('booth_' || bp.method)::text,
           bp.amount_cents
      from public.booth_payments bp
      join public.reservations r
        on r.id = bp.reservation_id and r.org_id = bp.org_id
      join public.facilities f on f.id = r.facility_id and f.org_id = r.org_id
     where bp.status = 'succeeded'
       and (p_facility_id is null or r.facility_id = p_facility_id)
       and (bp.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to
  ),
  -- Deliberately its own CTE rather than a third arm of `collected`: permit money
  -- is the OTHER category here, not part of the hourly total.
  permit_collected as (
    select coalesce(pg_catalog.sum(pp.amount_cents), 0::bigint) as cents
      from public.permit_payments pp
      join public.permits pr
        on pr.id = pp.permit_id and pr.org_id = pp.org_id
      join public.facilities f on f.id = pr.facility_id and f.org_id = pr.org_id
     where pp.status = 'succeeded'
       and (p_facility_id is null or pr.facility_id = p_facility_id)
       and (pp.created_at at time zone public.safe_timezone(f.timezone))::date
           between p_from and p_to
  )
  select 'hourly'::text as category,
         coalesce(pg_catalog.sum(amount_cents), 0::bigint) as revenue_cents,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'stripe'),
           0::bigint
         ) as stripe_revenue_cents,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_cash'),
           0::bigint
         ) as booth_cash_revenue_cents,
         coalesce(
           pg_catalog.sum(amount_cents) filter (where source = 'booth_card'),
           0::bigint
         ) as booth_card_revenue_cents,
         true as recorded,
         null::text as note
    from collected
  union all
  -- Every permit invoice is collected by Stripe, so the whole figure sits in the
  -- online column and both booth columns are zero. That keeps the per-row identity
  -- revenue = stripe + booth_cash + booth_card true on this row as well, which is
  -- what the Reports breakdown line renders.
  select 'permit'::text,
         pc.cents,
         pc.cents,
         0::bigint,
         0::bigint,
         true,
         null::text
    from permit_collected pc;
$$;

-- create or replace preserves privileges on all six, but restate them so a
-- replay of this file alone lands the same ACL the originals established.
revoke all on function public.reservation_balance_cents(uuid) from public, anon;
grant execute on function public.reservation_balance_cents(uuid)
  to authenticated, service_role;
revoke all on function public.facility_daily_manifest(uuid, date) from public, anon;
grant execute on function public.facility_daily_manifest(uuid, date)
  to authenticated, service_role;
revoke all on function public.facility_dashboard_summary(uuid) from public, anon;
grant execute on function public.facility_dashboard_summary(uuid)
  to authenticated, service_role;
revoke all on function public.report_revenue_by_period(date, date, uuid, text)
  from public, anon;
grant execute on function public.report_revenue_by_period(date, date, uuid, text)
  to authenticated, service_role;
revoke all on function public.report_revenue_by_space_type(date, date, uuid)
  from public, anon;
grant execute on function public.report_revenue_by_space_type(date, date, uuid)
  to authenticated, service_role;
revoke all on function public.report_revenue_split(date, date, uuid)
  from public, anon;
grant execute on function public.report_revenue_split(date, date, uuid)
  to authenticated, service_role;
