-- ParkOS: make the permit webhook writer safe against out-of-order delivery,
-- and add a detection-only reconciliation report for permits that are stuck.
--
-- WHY A GUARD AT ALL. Stripe does not guarantee that events arrive in the order
-- they were generated, and explicitly documents that the event timestamp must
-- NOT be used to recover that order:
--
--   "Snapshot events record created in seconds, so distinct events can share a
--    timestamp. Don't use created to determine event order or whether you have
--    already processed an event."
--     -- https://docs.stripe.com/webhooks , "Event ordering"
--
-- So there is no timestamp to compare against. The Subscription object carries
-- no version or modified-at field either: its own created is the subscription's
-- creation time (identical on every event for that subscription) and the period
-- fields advance only once per billing cycle, so neither can order two events
-- inside one period. That is why NO ordering column is added here -- a column
-- comparing values Stripe disclaims would look like protection without being any.
--
-- WHAT IS COMPARABLE is our own status, which already has a documented monotonic
-- order (20260831000000):
--
--   0 pending    no subscription exists      -> entitles nothing
--   1 suspended  subscription exists, unpaid -> hold kept
--   2 active     Stripe active or trialing   -> entitles parking
--   3 cancelled  terminal                    -> hold released
--
-- THE GUARD: a subscription snapshot may not LOWER that rank, unless the payload
-- is evidence of a real demotion.
--
--   * 'past_due', 'unpaid', 'paused' ARE real post-activation failures. They
--     still demote, and so does invoice.payment_failed in its own branch.
--   * 'incomplete' and 'incomplete_expired' are NOT. Stripe defines them as
--     first-payment-attempt statuses ("Once the first invoice is paid, the
--     subscription moves into an active status"), so an active subscription
--     never returns to them. Receiving one for a permit that has already
--     advanced therefore means the event is stale -- exactly the reported bug: a
--     customer.subscription.created carrying 'incomplete' landing after the
--     update that activated the permit, demoting a working permit to suspended.
--
-- IT ALSO CLOSES A RESURRECTION HOLE that predates this change. The status CASE
-- tests p_stripe_status in ('active','trialing') BEFORE it tests whether the
-- permit is already cancelled, so a reordered 'updated' carrying 'active' landing
-- after 'deleted' set a cancelled permit back to active. Rank 3 is the highest,
-- so the guard now keeps cancelled terminal against every snapshot.
--
-- WHAT THIS DELIBERATELY DOES NOT FIX. Two customer.subscription.updated events
-- that swap order while both carry post-activation statuses remain unordered.
-- Only retrieving the subscription from Stripe can settle that, which needs the
-- API key and is therefore Edge Function work, not SQL. Tracked in docs/roadmap.md.

-- ---------------------------------------------------------------------------
-- A. Ordering guard
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
  -- Index position IS the precedence rank; see the header table.
  v_rank constant text[] := array['pending', 'suspended', 'active', 'cancelled'];
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
  elsif p_event_type in ('customer.subscription.created', 'customer.subscription.updated', 'invoice.paid') then
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

-- ---------------------------------------------------------------------------
-- B1. Detection-only reconciliation report
-- ---------------------------------------------------------------------------

-- DETECTION ONLY. This function reads; it never writes. Remediation is held for
-- a later commit because the two cases that matter cannot be resolved from
-- ParkOS state alone:
--
--   * 'stuck_pending' is indistinguishable from a permit whose subscription
--     Stripe DID create and whose customer.subscription.created was never
--     delivered. Auto-abandoning would cancel a live, billing subscription.
--   * 'suspended_unverified' is indistinguishable from a genuinely unpaid
--     subscription. Only Stripe knows which.
--
-- Resolving either needs the Stripe API. The secret key is Edge-Function-only
-- (never in the database) and neither pg_net nor http is installed, so a
-- Stripe-calling reconciler cannot be a pg_cron job at all. See docs/roadmap.md.
--
-- NOT security definer, matching the report_* functions in 20260824000000: RLS
-- on public.permits scopes every result to the caller's own org exactly as a
-- direct table read would. pg_cron runs as the database owner, which bypasses
-- RLS, so the scheduled call still sees every org.
create or replace function public.report_permit_reconciliation(
  p_pending_grace_minutes integer default 30
)
returns table (
  permit_id        uuid,
  org_id           uuid,
  facility_id      uuid,
  space_id         uuid,
  status           text,
  classification   text,
  detail           text,
  has_subscription boolean,
  open_holds       integer,
  age_hours        numeric,
  created_at       timestamptz
)
language sql
stable
set search_path = ''
as $$
  with base as (
    select p.id,
           p.org_id,
           p.facility_id,
           p.space_id,
           p.status,
           p.stripe_subscription_id is not null as has_subscription,
           p.cancellation_requested_at,
           p.created_at,
           (select pg_catalog.count(*)
              from public.space_holds h
             where h.permit_id = p.id
               and h.org_id = p.org_id
               and h.released_at is null)::integer as open_holds,
           -- extract() is a grammar construct, not an ordinary function, so it
           -- cannot be schema-qualified; it needs no search_path either.
           pg_catalog.round(
             (extract(epoch from (pg_catalog.now() - p.created_at))
              / 3600.0)::numeric, 1) as age_hours
      from public.permits p
     where p.archived_at is null
  )
  -- Issued, then the browser never completed Stripe setup and never ran the
  -- abandon_pending_permit compensation. Holds a space it is not paying for.
  -- The set operation takes its output column names from this first branch, and
  -- the trailing ORDER BY resolves against those -- hence the alias here.
  select b.id, b.org_id, b.facility_id, b.space_id, b.status,
         'stuck_pending'::text as classification,
         'Pending with no Stripe subscription past the grace window. Either Stripe setup failed and compensation never ran, or the subscription exists and its created event was lost. Requires Stripe to tell those apart.'::text,
         b.has_subscription, b.open_holds, b.age_hours, b.created_at
    from base b
   where b.status = 'pending'
     and not b.has_subscription
     and b.created_at
         < pg_catalog.now() - pg_catalog.make_interval(mins => p_pending_grace_minutes)

  union all

  -- Invariant from 20260831000000: a row carrying a subscription id is never
  -- pending, because the only writer of that column sets status in the same
  -- update. If this ever fires, that invariant has been broken.
  select b.id, b.org_id, b.facility_id, b.space_id, b.status,
         'pending_with_subscription'::text,
         'Invariant violation: pending despite holding a Stripe subscription id. The subscription writer should have set a status in the same update.'::text,
         b.has_subscription, b.open_holds, b.age_hours, b.created_at
    from base b
   where b.status = 'pending'
     and b.has_subscription

  union all

  -- Staff asked Stripe to cancel and Stripe never confirmed. The permit still
  -- holds its space and may still be billing.
  select b.id, b.org_id, b.facility_id, b.space_id, b.status,
         'cancellation_unconfirmed'::text,
         'Cancellation was requested but the Stripe webhook never confirmed it. The permit still holds its space.'::text,
         b.has_subscription, b.open_holds, b.age_hours, b.created_at
    from base b
   where b.cancellation_requested_at is not null
     and b.status <> 'cancelled'

  union all

  -- Either a genuinely unpaid subscription, or the residue of a reordered event
  -- from before the guard above existed. Not separable without Stripe.
  select b.id, b.org_id, b.facility_id, b.space_id, b.status,
         'suspended_unverified'::text,
         'Suspended. Could be a real unpaid invoice, a terminal incomplete_expired subscription, or the residue of a reordered event. Confirm against Stripe before acting.'::text,
         b.has_subscription, b.open_holds, b.age_hours, b.created_at
    from base b
   where b.status = 'suspended'

  union all

  -- An active permit whose space is not actually reserved for it: another
  -- reservation can take the slot, and the exclusion constraint will then refuse
  -- to restore the hold.
  select b.id, b.org_id, b.facility_id, b.space_id, b.status,
         'active_without_hold'::text,
         'Active but holding no space. The space is sellable to someone else and the hold cannot be restored once taken.'::text,
         b.has_subscription, b.open_holds, b.age_hours, b.created_at
    from base b
   where b.status = 'active'
     and b.open_holds = 0

  union all

  -- cancel_permit releases the hold in the same transaction as the status write,
  -- so this pairing means one of them did not land.
  select b.id, b.org_id, b.facility_id, b.space_id, b.status,
         'cancelled_with_open_hold'::text,
         'Cancelled but still holding its space, which cancel_permit releases in the same transaction. The space is unsellable.'::text,
         b.has_subscription, b.open_holds, b.age_hours, b.created_at
    from base b
   where b.status = 'cancelled'
     and b.open_holds > 0

   order by classification, created_at;
$$;

comment on function public.report_permit_reconciliation(integer) is
  'Detection only: lists permits stuck in a state the webhook cannot resolve on its own. Reads, never writes. RLS scopes results to the caller org; pg_cron runs as owner and sees all orgs. Remediation needs the Stripe API and is deliberately not here.';

revoke all on function public.report_permit_reconciliation(integer) from public, anon;
grant execute on function public.report_permit_reconciliation(integer)
  to authenticated, service_role;

-- The scheduled arm. A bare SELECT under cron would discard its own result, so
-- this thin wrapper turns a non-empty finding set into a server log line. Still
-- detection only: it reads and logs, it changes nothing.
create or replace function public.log_permit_reconciliation()
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_count integer;
begin
  select pg_catalog.count(*)::integer into v_count
    from public.report_permit_reconciliation();
  if v_count > 0 then
    raise warning 'PARKOS permit reconciliation: % finding(s) need review; select * from public.report_permit_reconciliation()', v_count;
  end if;
  return v_count;
end;
$$;

comment on function public.log_permit_reconciliation() is
  'pg_cron entry point for report_permit_reconciliation. Logs a warning when there is anything to review. Detection only: writes nothing.';

revoke all on function public.log_permit_reconciliation() from public, anon, authenticated;
grant execute on function public.log_permit_reconciliation() to service_role;

-- ---------------------------------------------------------------------------
-- Schedule. Deliberately NOT wrapped in the exception-swallowing block used by
-- 20260819130000: that pattern reports success when it scheduled nothing, so the
-- only evidence it ever produced was a NOTICE. Here a failure to schedule fails
-- the migration, and the assertion below proves the row actually exists rather
-- than trusting that cron.schedule returned without raising.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

select cron.schedule('parkos-permit-reconciliation', '*/15 * * * *',
                     'select public.log_permit_reconciliation()');

do $$
begin
  if not exists (
    select 1 from cron.job
     where jobname = 'parkos-permit-reconciliation'
       and active
  ) then
    raise exception using errcode = 'P0001',
      message = 'PARKOS: pg_cron job parkos-permit-reconciliation is not scheduled and active';
  end if;
end $$;
