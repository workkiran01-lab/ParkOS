-- Bugfix: public_ensure_customer (Week 7) raised
--   42702: column reference "org_id" is ambiguous
-- on the new-customer INSERT path (the booking page's "Almost there" step).
--
-- Root cause: the function's OUT columns (org_id, full_name) share names with
-- public.customers columns. In `insert into customers (...) on conflict
-- (org_id, user_id) ...` the bare identifier org_id could bind to either the
-- PL/pgSQL OUT variable or the table column, and PL/pgSQL's default
-- variable_conflict=error rejects it. ON CONFLICT inference columns cannot be
-- table-qualified, and the OUT names must stay (the client reads customer_id /
-- org_id / full_name), so the fix is to resolve bare identifiers to columns for
-- this function body via `#variable_conflict use_column`. Signature and return
-- type are unchanged; body is otherwise identical to the Week 7 definition.
create or replace function public.public_ensure_customer(
  p_facility_id uuid,
  p_full_name text default null,
  p_email text default null,
  p_phone text default null
)
returns table (customer_id uuid, org_id uuid, full_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_customer public.customers%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select f.org_id into v_org_id
    from public.facilities f
   where f.id = p_facility_id
     and f.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'FACILITY_NOT_FOUND';
  end if;

  select * into v_customer
    from public.customers c
   where c.org_id = v_org_id
     and c.user_id = v_user_id;

  if found then
    return query select v_customer.id, v_customer.org_id, v_customer.full_name;
    return;
  end if;

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_DETAILS_REQUIRED';
  end if;

  insert into public.customers (org_id, user_id, full_name, email, phone)
  values (
    v_org_id,
    v_user_id,
    trim(p_full_name),
    nullif(trim(coalesce(p_email, '')), ''),
    nullif(trim(coalesce(p_phone, '')), '')
  )
  on conflict (org_id, user_id) where user_id is not null do nothing;

  -- Re-read instead of RETURNING: a concurrent insert may have won the race.
  select * into v_customer
    from public.customers c
   where c.org_id = v_org_id
     and c.user_id = v_user_id;

  return query select v_customer.id, v_customer.org_id, v_customer.full_name;
end;
$$;
