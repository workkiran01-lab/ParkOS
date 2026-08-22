-- Bugfix: check_out_reservation raised
--   42883: function pg_catalog.coalesce(jsonb, jsonb) does not exist
-- whenever a staff member checked out with an overstay amount (> 0). The
-- generic "Check-out failed. Please try again." toast came from friendlyError
-- falling back, since 42883 is not a mapped app error code.
--
-- Root cause: COALESCE is a SQL special construct (like NULLIF/GREATEST/LEAST),
-- not an ordinary function, so it cannot be schema-qualified. The Week 8
-- attendant-checkin migration qualified it as `pg_catalog.coalesce(...)` in the
-- overstay branch (the two calls below), which fails at runtime. Check-out with
-- a blank/0 overstay took the else branch and never hit the bad call, so only
-- the overstay path was broken.
--
-- Fix: call coalesce unqualified (as every other function in the schema does,
-- even under `set search_path = ''`). Signature, return type, grants, and the
-- rest of the body are unchanged from the Week 8 definition.
create or replace function public.check_out_reservation(
  p_reservation_id uuid,
  p_overstay_cents integer default 0
)
returns table (final_total_cents integer, price_breakdown jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_status public.reservation_status;
  v_breakdown jsonb;
  v_total integer;
  v_final integer;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  if p_overstay_cents is null or p_overstay_cents < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_OVERSTAY_AMOUNT';
  end if;

  select r.org_id, r.status, r.price_breakdown, r.total_cents
    into v_org_id, v_status, v_breakdown, v_total
    from public.reservations r
   where r.id = p_reservation_id;

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

  if p_overstay_cents > 0 then
    v_breakdown := pg_catalog.jsonb_set(
      v_breakdown,
      '{line_items}',
      coalesce(v_breakdown -> 'line_items', '[]'::jsonb)
        || pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object(
               'type', 'overstay',
               'description', 'Overstay charge',
               'subtotal_cents', p_overstay_cents
             )
           )
    );
    v_final := coalesce((v_breakdown ->> 'total_cents')::integer, v_total)
               + p_overstay_cents;
    v_breakdown := pg_catalog.jsonb_set(
      v_breakdown, '{total_cents}', pg_catalog.to_jsonb(v_final));
  else
    v_final := v_total;
  end if;

  update public.reservations
     set status = 'completed',
         checked_out_at = now(),
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
          case when p_overstay_cents > 0
               then 'overstay ' || p_overstay_cents || ' cents' end);

  return query select v_final, v_breakdown;
end;
$$;
