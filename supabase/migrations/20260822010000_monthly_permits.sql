-- ParkOS Week 12: assigned-space monthly permits with Stripe subscriptions.
-- Permit access is represented by an open-ended row in space_holds, so the
-- existing GiST exclusion constraint remains the single concurrency boundary
-- for reservations, permits, maintenance, and manual blocks.

-- ---------------------------------------------------------------------------
-- Schema and tenant-safe relationships
-- ---------------------------------------------------------------------------

alter table public.customers
  add column stripe_customer_id text;

create unique index customers_stripe_customer_id_key
  on public.customers (stripe_customer_id)
  where stripe_customer_id is not null;

alter table public.permits
  alter column status drop default,
  alter column status type text using status::text,
  alter column status set default 'active',
  add column stripe_subscription_id text,
  add column current_period_start timestamptz,
  add column current_period_end timestamptz,
  add column cancelled_at timestamptz,
  add constraint permits_status_check
    check (status in ('active', 'suspended', 'cancelled')),
  add constraint permits_current_period_check
    check (
      current_period_start is null
      or current_period_end is null
      or current_period_end > current_period_start
    ),
  add constraint permits_org_id_id_key unique (org_id, id);

create unique index permits_stripe_subscription_id_key
  on public.permits (stripe_subscription_id)
  where stripe_subscription_id is not null;

alter table public.permits
  drop constraint permits_facility_id_fkey,
  add constraint permits_org_id_facility_id_fkey
    foreign key (org_id, facility_id)
    references public.facilities (org_id, id);

alter table public.space_holds
  drop constraint space_holds_permit_id_fkey,
  add constraint space_holds_org_id_permit_id_fkey
    foreign key (org_id, permit_id)
    references public.permits (org_id, id);

comment on column public.customers.stripe_customer_id is
  'Stripe Customer used by trusted subscription endpoints; never supplied by a browser client.';
comment on column public.permits.stripe_subscription_id is
  'Stripe-derived subscription identity. Only the signed webhook path writes this field.';

create or replace function public.protect_customer_stripe_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role'
     and new.stripe_customer_id is not null
     and (tg_op = 'INSERT' or new.stripe_customer_id is distinct from old.stripe_customer_id) then
    raise exception using errcode = 'P0001', message = 'STRIPE_FIELDS_SERVER_ONLY';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_customer_stripe_identity() from public;

create trigger customers_protect_stripe_identity
before insert or update of stripe_customer_id on public.customers
for each row execute function public.protect_customer_stripe_identity();

-- Existing broad Week 3 grants are narrowed: permit writes must go through the
-- lifecycle functions below. RLS still defines visibility, while table grants
-- ensure no authenticated browser can bypass auditing or mutate Stripe state.
revoke insert, update, delete on public.permits from authenticated;
grant select on public.permits to authenticated;

create policy permits_select_own on public.permits
  for select
  to authenticated
  using (public.is_own_customer(customer_id));

create policy permits_update_staff on public.permits
  for update
  to authenticated
  using (public.has_any_role(org_id, array['admin','manager']))
  with check (public.has_any_role(org_id, array['admin','manager']));

-- ---------------------------------------------------------------------------
-- Issue and cancel lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.issue_permit(
  p_org_id uuid,
  p_facility_id uuid,
  p_space_id uuid,
  p_customer_id uuid,
  p_start timestamptz,
  p_monthly_rate_cents integer,
  p_currency text default 'USD'
)
returns public.permits
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_permit public.permits%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;
  if not public.has_any_role(p_org_id, array['admin','manager']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;
  if p_start is null or p_monthly_rate_cents is null or p_monthly_rate_cents < 0
     or p_currency is null or p_currency !~ '^[A-Za-z]{3}$' then
    raise exception using errcode = '22023', message = 'INVALID_PERMIT_DETAILS';
  end if;
  if not exists (
    select 1 from public.spaces s
    join public.zones z on z.org_id = s.org_id and z.id = s.zone_id
    where s.org_id = p_org_id and s.id = p_space_id
      and z.facility_id = p_facility_id
      and s.archived_at is null and z.archived_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'SPACE_NOT_FOUND';
  end if;
  if not exists (
    select 1 from public.facilities f
    where f.org_id = p_org_id and f.id = p_facility_id and f.archived_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'FACILITY_NOT_FOUND';
  end if;
  if not exists (
    select 1 from public.customers c
    where c.org_id = p_org_id and c.id = p_customer_id and c.archived_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;

  begin
    insert into public.permits (
      org_id, facility_id, space_id, customer_id, during,
      monthly_rate_cents, currency, status
    ) values (
      p_org_id, p_facility_id, p_space_id, p_customer_id,
      tstzrange(p_start, null, '[)'), p_monthly_rate_cents,
      upper(p_currency), 'active'
    ) returning * into v_permit;

    insert into public.space_holds (
      org_id, space_id, hold_type, during, permit_id
    ) values (
      p_org_id, p_space_id, 'permit', tstzrange(p_start, null, '[)'), v_permit.id
    );
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'SPACE_UNAVAILABLE';
  end;

  insert into public.audit_log (
    org_id, actor_id, action, target_table, target_id
  ) values (
    p_org_id, auth.uid(), 'issue_permit', 'permits', v_permit.id
  );

  return v_permit;
end;
$$;

create or replace function public.cancel_permit(
  p_permit_id uuid,
  p_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_permit public.permits%rowtype;
  v_actor uuid := auth.uid();
  v_is_service boolean := auth.role() = 'service_role';
begin
  if not v_is_service and v_actor is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select p.* into v_permit
    from public.permits p
   where p.id = p_permit_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'PERMIT_NOT_FOUND';
  end if;
  if not v_is_service
     and not public.has_any_role(v_permit.org_id, array['admin','manager']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;
  if v_permit.status = 'cancelled' then
    return;
  end if;

  update public.permits
     set status = 'cancelled', cancelled_at = now()
   where id = p_permit_id;

  update public.space_holds
     set released_at = now()
   where org_id = v_permit.org_id
     and permit_id = p_permit_id
     and released_at is null;

  insert into public.audit_log (
    org_id, actor_id, action, target_table, target_id, reason
  ) values (
    v_permit.org_id, case when v_is_service then null else v_actor end,
    'cancel_permit', 'permits', p_permit_id, p_reason
  );
end;
$$;

-- Customer-safe projection; facility and space tables remain private to staff.
create or replace function public.get_my_permits()
returns table (
  permit_id uuid,
  facility_name text,
  space_number text,
  starts_at timestamptz,
  monthly_rate_cents integer,
  currency text,
  status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancelled_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, f.name, s.space_number, lower(p.during),
         p.monthly_rate_cents, p.currency, p.status,
         p.current_period_start, p.current_period_end, p.cancelled_at
    from public.permits p
    join public.facilities f on f.org_id = p.org_id and f.id = p.facility_id
    join public.spaces s on s.org_id = p.org_id and s.id = p.space_id
   where p.archived_at is null
     and public.is_own_customer(p.customer_id)
   order by p.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- Atomic Stripe subscription event application
-- ---------------------------------------------------------------------------

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
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = 'P0001', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_event_id is null or length(trim(p_event_id)) = 0 then
    raise exception using errcode = '22023', message = 'STRIPE_EVENT_ID_REQUIRED';
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
    perform public.cancel_permit(
      v_permit.id,
      coalesce(nullif(trim(p_reason), ''), 'Stripe subscription cancelled')
    );
    v_status := 'cancelled';
  elsif p_event_type = 'invoice.payment_failed' then
    update public.permits set status = 'suspended'
     where id = v_permit.id and status <> 'cancelled';
    v_status := case when v_permit.status = 'cancelled' then 'cancelled' else 'suspended' end;
  elsif p_event_type in ('customer.subscription.created', 'customer.subscription.updated', 'invoice.paid') then
    v_status := case
      when p_stripe_status in ('active', 'trialing') then 'active'
      when v_permit.status = 'cancelled' then 'cancelled'
      else 'suspended'
    end;
    update public.permits
       set stripe_subscription_id = coalesce(stripe_subscription_id, p_stripe_subscription_id),
           status = v_status,
           current_period_start = coalesce(p_period_start, current_period_start),
           current_period_end = coalesce(p_period_end, current_period_end)
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

revoke all on function public.issue_permit(uuid, uuid, uuid, uuid, timestamptz, integer, text) from public;
revoke all on function public.cancel_permit(uuid, text) from public;
revoke all on function public.get_my_permits() from public;
revoke all on function public.process_stripe_subscription_event(text, text, uuid, text, text, timestamptz, timestamptz, text) from public;

grant execute on function public.issue_permit(uuid, uuid, uuid, uuid, timestamptz, integer, text)
  to authenticated;
grant execute on function public.cancel_permit(uuid, text)
  to authenticated, service_role;
grant execute on function public.get_my_permits() to authenticated;
grant execute on function public.process_stripe_subscription_event(text, text, uuid, text, text, timestamptz, timestamptz, text)
  to service_role;

grant select, update on public.customers to service_role;
grant select, update on public.permits to service_role;
