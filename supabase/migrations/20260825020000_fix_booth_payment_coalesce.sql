-- ParkOS: repair booth payment functions after 20260825010000.
--
-- COALESCE and NULLIF are PostgreSQL expression syntax, not callable functions
-- in pg_catalog. Schema-qualifying them caused the PL/pgSQL bodies to fail only
-- when first executed. Replace every affected booth function without changing
-- its signature, authorization checks, or transactional behavior.

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

  if v_end is null or p_departure_at is null or p_departure_at <= v_end then
    return query select 0, '{}'::jsonb;
    return;
  end if;

  v_quote := public.quote_reservation(v_space_id, v_end, p_departure_at);

  return query select
    coalesce((v_quote ->> 'total_cents')::integer, 0::integer),
    v_quote;
end;
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

create or replace function public.check_out_reservation(
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

  if v_checked_in_at is not null and p_departure_at < v_checked_in_at then
    raise exception using errcode = 'P0001', message = 'DEPARTURE_BEFORE_CHECK_IN';
  end if;

  select co.overstay_cents, co.breakdown
    into v_overstay, v_overstay_quote
    from public.calculate_overstay(p_reservation_id, p_departure_at) co;

  if v_overstay > 0 then
    v_breakdown := pg_catalog.jsonb_set(
      v_breakdown,
      '{line_items}',
      coalesce(v_breakdown -> 'line_items', '[]'::jsonb)
        || pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object(
               'type', 'overstay',
               'description', 'Overstay charge',
               'departed_at', p_departure_at,
               'line_items', coalesce(
                 v_overstay_quote -> 'line_items', '[]'::jsonb),
               'subtotal_cents', v_overstay
             )
           )
    );
    v_final := coalesce(
                 (v_breakdown ->> 'total_cents')::integer,
                 v_total
               ) + v_overstay;
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
