-- ParkOS: in-person (booth) payment collection + server-computed overstay.
--
-- Closes the "in-person payment collection" gap recorded in ARCHITECTURE.md.
-- Three structural blockers were named there; this migration answers all three:
--
--   * `payments.stripe_checkout_session_id` is NOT NULL and the table has no
--     `method`/`collected_by`. Rather than relax that table -- which would
--     weaken Decision #6 for the Stripe rows that genuinely are webhook-only --
--     cash and card-terminal collection gets its OWN table. `payments` stays
--     exactly as strict as it is today.
--   * Decision #6 restricts payment writes to signature-verified webhooks.
--     In-person money has no webhook to originate it, so the write originates
--     from a trusted server function instead: browser clients still hold no
--     INSERT/UPDATE/DELETE grant or policy on either payment table, and every
--     booth row is written by `record_booth_payment` with a role check and an
--     audit_log entry.
--   * `check_out_reservation` computed a `final_total_cents` that nothing
--     consumed. It now computes the overstay itself and can settle the balance
--     in the same transaction.
--
-- Deliberately NOT given `archived_at` (Decision #5): Decision #6 states that
-- payment records are financial history which application workflows never
-- archive or delete, and the sibling `payments` table carries no such column.
-- A soft-delete column nothing is ever allowed to set is a false affordance.

-- ---------------------------------------------------------------------------
-- booth_payments
-- ---------------------------------------------------------------------------

create table public.booth_payments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id),
  reservation_id uuid not null,
  amount_cents   integer not null check (amount_cents > 0),
  currency       text not null default 'USD' check (char_length(currency) = 3),
  method         text not null check (method in ('cash', 'card')),
  -- Who took the money. No ON DELETE action: an attendant who later leaves must
  -- still be named on the shift's cash, which is the point of Decision #5.
  collected_by   uuid not null references auth.users(id),
  note           text,
  created_at     timestamptz not null default now(),
  -- The composite tenant FK, same as payments/vehicle_photos: a booth payment
  -- cannot reference a reservation belonging to a different org.
  constraint booth_payments_org_id_reservation_id_fkey
    foreign key (org_id, reservation_id)
    references public.reservations (org_id, id)
);

create index booth_payments_org_id_idx on public.booth_payments (org_id);
create index booth_payments_reservation_id_idx
  on public.booth_payments (reservation_id);

comment on table public.booth_payments is
  'Cash and card-terminal money collected at the booth. Clients are read-only; rows are written only by record_booth_payment (staff-only, audited). Financial history: never archived or deleted.';

-- Mirrors payments exactly: SELECT for authenticated, everything for the
-- service role, and no client write path of any kind.
revoke all on public.booth_payments from anon, authenticated;
grant select on public.booth_payments to authenticated;
grant select, insert, update, delete on public.booth_payments to service_role;

alter table public.booth_payments enable row level security;

create policy booth_payments_select_members on public.booth_payments
  for select
  to authenticated
  using (public.get_user_role(org_id) is not null);

create policy booth_payments_select_own on public.booth_payments
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.reservations r
       where r.id = booth_payments.reservation_id
         and r.org_id = booth_payments.org_id
         and public.is_own_customer(r.customer_id)
    )
  );

-- ---------------------------------------------------------------------------
-- reservation_balance_cents -- what is still owed on a reservation
-- ---------------------------------------------------------------------------

-- One definition of "amount due", used by the booth UI and by check-out below,
-- so the number the attendant reads and the number the database collects cannot
-- drift apart. SECURITY DEFINER with the tenant check done explicitly: staff of
-- the org, or the customer the reservation belongs to.
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

  select pg_catalog.coalesce(pg_catalog.sum(collected.amount_cents), 0)
    into v_paid
    from (
      select bp.amount_cents
        from public.booth_payments bp
       where bp.reservation_id = p_reservation_id
         and bp.org_id = v_org_id
      union all
      select p.amount_cents
        from public.payments p
       where p.reservation_id = p_reservation_id
         and p.org_id = v_org_id
         and p.status = 'succeeded'
    ) collected;

  -- Never negative: an overpayment or a refunded-then-recollected edge is a
  -- reporting question, not a reason to show the booth a negative amount due.
  return greatest(v_total - v_paid, 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- calculate_overstay -- what a late departure costs, in the facility's timezone
-- ---------------------------------------------------------------------------

-- The overstay is priced as a reservation for the interval
-- [reserved end, actual departure) against the SAME price rules. That is not a
-- shortcut, it is the point: quote_reservation already splits at facility-local
-- midnight and applies the daily cap per local calendar day, so cross-midnight
-- and DST-transition departures are handled by the one pricing implementation
-- instead of a second one written here that would drift from it.
create or replace function public.calculate_overstay(
  p_reservation_id uuid,
  p_departure_at timestamptz default now()
)
returns table (overstay_cents integer, breakdown jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_space_id uuid;
  v_end timestamptz;
  v_quote jsonb;
begin
  select r.org_id, r.space_id, pg_catalog.upper(r.during)
    into v_org_id, v_space_id, v_end
    from public.reservations r
   where r.id = p_reservation_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if not public.has_any_role(v_org_id, array['admin','manager','attendant']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  -- An unbounded window cannot be overstayed, and leaving early is not a
  -- negative charge. Both return zero rather than raising: an on-time
  -- check-out is the normal case, not an error.
  if v_end is null or p_departure_at is null or p_departure_at <= v_end then
    return query select 0, '{}'::jsonb;
    return;
  end if;

  v_quote := public.quote_reservation(v_space_id, v_end, p_departure_at);

  return query select
    pg_catalog.coalesce((v_quote ->> 'total_cents')::integer, 0),
    v_quote;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_booth_payment -- the single write path for in-person money
-- ---------------------------------------------------------------------------

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

  -- FOR UPDATE: two attendants settling the same ticket at once must serialize
  -- here, or both read the same balance and both collect it.
  select r.org_id, r.currency, r.archived_at
    into v_org_id, v_currency, v_archived
    from public.reservations r
   where r.id = p_reservation_id
   for update;

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

  -- A fat-fingered amount at the booth is the realistic failure mode, and an
  -- over-collection cannot be undone through this table.
  if p_amount_cents > v_balance then
    raise exception using errcode = 'P0001', message = 'AMOUNT_EXCEEDS_BALANCE';
  end if;

  insert into public.booth_payments
    (org_id, reservation_id, amount_cents, currency, method, collected_by, note)
  values
    (v_org_id, p_reservation_id, p_amount_cents, v_currency, p_method, v_user_id,
     pg_catalog.nullif(pg_catalog.btrim(pg_catalog.coalesce(p_note, '')), ''))
  returning id into v_payment_id;

  insert into public.audit_log
    (org_id, actor_id, action, target_table, target_id, reason)
  values
    (v_org_id, v_user_id, 'record_booth_payment', 'booth_payments', v_payment_id,
     p_method || ' ' || p_amount_cents || ' cents');

  return query select v_payment_id, v_balance - p_amount_cents;
end;
$$;

-- ---------------------------------------------------------------------------
-- check_out_reservation -- overstay computed here, not supplied by the client
-- ---------------------------------------------------------------------------

-- REPLACES check_out_reservation(uuid, integer). The old signature took the
-- overstay as a dollar figure typed at the booth, which meant the browser
-- decided how much money was owed, and the `final_total_cents` it returned was
-- never collected by anything. The departure TIME is the honest input; the
-- charge is derived from it here, priced by the facility's own rules and
-- timezone, and optionally settled in the same transaction.
drop function public.check_out_reservation(uuid, integer);

create function public.check_out_reservation(
  p_reservation_id uuid,
  p_departure_at timestamptz default now(),
  p_payment_method text default null,
  p_payment_note text default null
)
returns table (
  final_total_cents integer,
  overstay_cents integer,
  collected_cents integer,
  balance_cents integer,
  price_breakdown jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_status public.reservation_status;
  v_checked_in_at timestamptz;
  v_breakdown jsonb;
  v_total integer;
  v_final integer;
  v_overstay integer := 0;
  v_overstay_quote jsonb;
  v_collected integer := 0;
  v_balance integer;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  if p_departure_at is null then
    raise exception using errcode = 'P0001', message = 'INVALID_DEPARTURE_TIME';
  end if;

  select r.org_id, r.status, r.price_breakdown, r.total_cents, r.checked_in_at
    into v_org_id, v_status, v_breakdown, v_total, v_checked_in_at
    from public.reservations r
   where r.id = p_reservation_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;

  if not public.has_any_role(v_org_id, array['admin','manager','attendant']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  if v_status <> 'active' then
    raise exception using errcode = 'P0001',
      message = 'CANNOT_CHECK_OUT_FROM_' || upper(v_status::text);
  end if;

  -- A car cannot leave before it arrived. Guards a mistyped departure that
  -- would otherwise silently price as no overstay at all.
  if v_checked_in_at is not null and p_departure_at < v_checked_in_at then
    raise exception using errcode = 'P0001', message = 'DEPARTURE_BEFORE_CHECK_IN';
  end if;

  select co.overstay_cents, co.breakdown
    into v_overstay, v_overstay_quote
    from public.calculate_overstay(p_reservation_id, p_departure_at) co;

  if v_overstay > 0 then
    -- The overstay's own per-day line items are appended, never replacing the
    -- original ones: a receipt has to show what was reserved AND what ran over.
    v_breakdown := pg_catalog.jsonb_set(
      v_breakdown,
      '{line_items}',
      pg_catalog.coalesce(v_breakdown -> 'line_items', '[]'::jsonb)
        || pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object(
               'type', 'overstay',
               'description', 'Overstay charge',
               'departed_at', p_departure_at,
               'line_items', pg_catalog.coalesce(
                 v_overstay_quote -> 'line_items', '[]'::jsonb),
               'subtotal_cents', v_overstay
             )
           )
    );
    v_final := pg_catalog.coalesce((v_breakdown ->> 'total_cents')::integer, v_total)
               + v_overstay;
    v_breakdown := pg_catalog.jsonb_set(
      v_breakdown, '{total_cents}', pg_catalog.to_jsonb(v_final));
  else
    v_final := v_total;
  end if;

  update public.reservations
     set status = 'completed',
         checked_out_at = p_departure_at,
         checked_out_by = v_user_id,
         total_cents = v_final,
         price_breakdown = v_breakdown
   where id = p_reservation_id;

  update public.space_holds
     set released_at = now()
   where reservation_id = p_reservation_id
     and released_at is null;

  insert into public.audit_log (org_id, actor_id, action, target_table, target_id, reason)
  values (v_org_id, v_user_id, 'check_out_reservation', 'reservations', p_reservation_id,
          case when v_overstay > 0 then 'overstay ' || v_overstay || ' cents' end);

  -- Settling inside this same transaction is what makes the booth safe: if the
  -- payment insert raises, the check-out rolls back with it and the attendant
  -- retries a session that is still open, rather than one that is closed and
  -- unpaid.
  v_balance := public.reservation_balance_cents(p_reservation_id);
  if p_payment_method is not null and v_balance > 0 then
    v_collected := v_balance;
    select rp.balance_cents into v_balance
      from public.record_booth_payment(
        p_reservation_id, v_collected, p_payment_method, p_payment_note) rp;
  end if;

  return query select v_final, v_overstay, v_collected, v_balance, v_breakdown;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.reservation_balance_cents(uuid) from public;
revoke all on function public.calculate_overstay(uuid, timestamptz) from public;
revoke all on function public.record_booth_payment(uuid, integer, text, text) from public;
revoke all on function public.check_out_reservation(uuid, timestamptz, text, text) from public;

grant execute on function public.reservation_balance_cents(uuid) to authenticated;
grant execute on function public.calculate_overstay(uuid, timestamptz) to authenticated;
grant execute on function public.record_booth_payment(uuid, integer, text, text) to authenticated;
grant execute on function public.check_out_reservation(uuid, timestamptz, text, text) to authenticated;
