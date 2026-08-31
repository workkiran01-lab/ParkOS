-- Permit issuance: a permit is 'pending' until Stripe confirms billing.
--
-- WHY. issue_permit committed the permit as 'active' and took its space hold in
-- one transaction, then the UI called create-permit-subscription. A Stripe
-- failure left an ACTIVE, space-holding permit with no billing: the customer
-- parked free and the space was unavailable to paying users.
--
-- WHY NOT REORDER (as the cancellation fix did). The space is a contended
-- resource and the space_holds exclusion constraint is the only thing that
-- arbitrates it. If Stripe ran first, two operators issuing for the same space
-- would BOTH create Stripe subscriptions, then one would lose the exclusion
-- constraint -- leaving a real subscription for a permit that will never exist,
-- which the customer can pay. That converts free parking into charging someone
-- for nothing. The hold must be taken first, so the fix is compensation.
--
-- THIS ALSO REMOVES A STATUS INVERSION. Because subscriptions are created with
-- payment_behavior 'default_incomplete', customer.subscription.created arrives
-- with Stripe status 'incomplete', which process_stripe_subscription_event maps
-- to 'suspended'. So a correctly-billed permit read 'suspended' while a permit
-- whose Stripe setup FAILED stayed 'active' -- the broken one looked healthier.
-- Inserting 'pending' removes the sole cause: nothing is 'active' until Stripe
-- says active or trialing. The ordering is now monotonic:
--
--   pending    no subscription exists          -> entitles nothing
--   suspended  subscription exists, unpaid     -> hold kept (Decision #7:88-89,
--                                                 loss of access is an operator
--                                                 decision)
--   active     Stripe active or trialing       -> entitles parking
--   cancelled  terminal                        -> hold released
--
-- INVARIANT worth stating, because abandon_pending_permit leans on it: a row
-- with stripe_subscription_id set is never 'pending'. The only writer of that
-- column (process_stripe_subscription_event) sets status in the SAME update and
-- never writes 'pending'.

alter table public.permits
  drop constraint permits_status_check,
  add constraint permits_status_check
    check (status in ('pending', 'active', 'suspended', 'cancelled'));

-- Unchanged except for the inserted status: the permit and its open-ended hold
-- are still created together so the exclusion constraint arbitrates concurrency
-- before any Stripe call happens.
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
      upper(p_currency), 'pending'
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

-- Compensation for a permit whose Stripe setup failed. Releases the space so it
-- is sellable again, and closes the permit out.
--
-- It REFUSES once stripe_subscription_id is set: that means Stripe succeeded and
-- customer.subscription.created is the writer, so tearing the permit down here
-- would destroy a permit that is actually billing. Refusing is also why the
-- browser closing mid-flow is safe -- the webhook wins any race.
create or replace function public.abandon_pending_permit(
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

  -- Stripe won: the subscription exists, so this permit is real. Never tear it
  -- down from here.
  if v_permit.stripe_subscription_id is not null then
    raise exception using errcode = 'P0001', message = 'PERMIT_HAS_SUBSCRIPTION';
  end if;
  -- Idempotent for a double-click: an already-abandoned permit is a no-op.
  if v_permit.status = 'cancelled' then
    return;
  end if;
  -- Anything that reached active or suspended has billing behind it and must go
  -- through cancel_permit, which stops Stripe first.
  if v_permit.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'PERMIT_NOT_PENDING';
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
    'abandon_pending_permit', 'permits', p_permit_id, p_reason
  );
end;
$$;

revoke all on function public.abandon_pending_permit(uuid, text) from public, anon;
grant execute on function public.abandon_pending_permit(uuid, text)
  to authenticated, service_role;

-- A pending permit has no Stripe subscription, so it is not billing and must not
-- keep an account open. The previous comment here reasoned that "a freshly
-- issued permit is active before the webhook writes it back" -- that is exactly
-- what no longer holds.
create or replace function public.deactivate_account()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  -- Billing outlives the account otherwise. A `suspended` permit is a failed
  -- payment, not a closed one, so the block stays wider than status = 'active'.
  -- `pending` is excluded because no subscription exists yet: by the invariant
  -- above, stripe_subscription_id is always null while status is 'pending'.
  if exists (
    select 1
      from public.permits p
      join public.customers c on c.id = p.customer_id
     where c.user_id = v_user_id
       and p.archived_at is null
       and p.status not in ('cancelled', 'pending')
  ) then
    raise exception using errcode = 'P0001', message = 'PERMIT_SUBSCRIPTION_ACTIVE';
  end if;

  insert into public.account_status (user_id, status, deactivated_at)
  values (v_user_id, 'deactivated', now())
  on conflict (user_id) do update
     set status = 'deactivated',
         deactivated_at = now();

  -- Revoke every active session. Refresh tokens are deleted explicitly rather
  -- than relying on GoTrue's cascade, so a schema change there cannot silently
  -- leave a usable token behind.
  delete from auth.refresh_tokens
   where session_id in (select s.id from auth.sessions s where s.user_id = v_user_id);
  delete from auth.sessions
   where user_id = v_user_id;

  -- Reservations, payments, and receipts are intentionally NOT touched.
end;
$$;
