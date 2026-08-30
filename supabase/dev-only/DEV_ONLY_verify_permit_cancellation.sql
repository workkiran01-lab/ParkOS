-- DEV-ONLY verification for permit cancellation ordering (assertion-only).
-- Every block RAISES EXCEPTION on failure, so a failed check aborts with its message.
-- All writes happen inside a subtransaction unwound by a sentinel, so the script
-- is data-neutral; the summary afterwards is the machine-visible proof.
--
-- Run only against parkos-dev:
--   npx supabase db query --linked --file supabase/dev-only/DEV_ONLY_verify_permit_cancellation.sql
--
-- Depends on the dev seed (DEV_ONLY_seed_dev_orgs.sql) for Org A and its admin.
--
-- These are the FAILURE paths, not the happy path. The bug being fixed was that
-- cancel_permit ran before Stripe, so a Stripe failure left a permit cancelled
-- and its space released while the customer kept being billed.
--
--   FP1  Stripe fails            -> intent recorded, permit still active, hold intact
--   FP2  Stripe ok, no webhook   -> permit still active, hold intact, not silently cancelled
--   FP3  operator cancels twice  -> idempotent, timestamp stable, one audit row
--   FP4  browser closes mid-flow -> webhook alone completes it, no browser involved

do $$
declare
  v_role text := current_user;
  org_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  a_admin uuid := '00000000-0000-0000-0000-0000000000a1';
  c_user uuid := '00000000-0000-0000-0000-0000000000e1';
  v_customer uuid; v_facility uuid; v_space uuid; v_permit uuid;
  v_start timestamptz := date_trunc('hour', now()) + interval '1200 days';
  v_status text; v_holds int; v_audit_before int; v_audit_after int;
  v_req1 timestamptz; v_req2 timestamptz;
  v_cancelled_at timestamptz;
  v_event text := 'evt_dev_permit_cancel_' || substr(md5(random()::text), 1, 12);
begin
  begin
    insert into auth.users
      (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    values ('00000000-0000-0000-0000-000000000000', c_user, 'authenticated',
            'authenticated', 'rls-cancel-e1@parkos.dev', 'x', now(), now(), now(), '{}', '{}')
    on conflict (id) do nothing;

    insert into public.customers (org_id, user_id, full_name)
    values (org_a, c_user, '__CANCEL_E1__') returning id into v_customer;

    select z.facility_id, s.id into v_facility, v_space
      from public.spaces s
      join public.zones z on z.org_id = s.org_id and z.id = s.zone_id
     where s.org_id = org_a and s.archived_at is null and z.archived_at is null
       and not exists (select 1 from public.space_holds h
                        where h.space_id = s.id and h.released_at is null
                          and h.during && tstzrange(v_start, null, '[)'))
     order by s.id limit 1;
    if v_space is null then raise exception 'SETUP FAIL: no free long-term space'; end if;

    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', a_admin), true);
    perform set_config('request.jwt.claim.sub', a_admin::text, true);
    execute 'set local role authenticated';

    select p.id into v_permit
      from public.issue_permit(org_a, v_facility, v_space, v_customer,
                               v_start, 15000, 'USD') p;

    execute format('set local role %I', v_role);
    -- Give it a subscription id so it looks like a Stripe-billed permit.
    update public.permits
       set stripe_subscription_id = 'sub_dev_' || substr(md5(v_permit::text), 1, 16)
     where id = v_permit;

    select count(*) into v_audit_before from public.audit_log where target_id = v_permit;

    -- ---------------------------------------------------------------------
    -- FP1: Stripe fails. The UI records intent, then the Stripe call errors.
    -- Nothing else may have changed: the permit is still billable and held.
    -- ---------------------------------------------------------------------
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_req1 := public.request_permit_cancellation(v_permit, 'FP1 stripe failed');
    if v_req1 is null then raise exception 'FP1 FAIL: no intent recorded'; end if;

    select status, cancelled_at into v_status, v_cancelled_at
      from public.permits where id = v_permit;
    if v_status <> 'active' then
      raise exception 'FP1 FAIL: status became % before Stripe confirmed', v_status; end if;
    if v_cancelled_at is not null then
      raise exception 'FP1 FAIL: cancelled_at written before Stripe confirmed'; end if;

    select count(*) into v_holds from public.space_holds
     where permit_id = v_permit and released_at is null;
    if v_holds <> 1 then
      raise exception 'FP1 FAIL: expected 1 open hold, found % (space released early)', v_holds; end if;

    -- ---------------------------------------------------------------------
    -- FP2: Stripe cancelled but the webhook never arrived. Identical ParkOS
    -- state to FP1 -- the permit must NOT drift to cancelled on its own.
    -- ---------------------------------------------------------------------
    select status into v_status from public.permits where id = v_permit;
    if v_status <> 'active' then
      raise exception 'FP2 FAIL: permit self-cancelled without a webhook (%)', v_status; end if;
    select count(*) into v_holds from public.space_holds
     where permit_id = v_permit and released_at is null;
    if v_holds <> 1 then
      raise exception 'FP2 FAIL: hold released without a webhook (% open)', v_holds; end if;

    -- ---------------------------------------------------------------------
    -- FP3: the operator clicks Cancel again after the failure. The intent must
    -- be idempotent -- same timestamp, no second audit row.
    -- ---------------------------------------------------------------------
    v_req2 := public.request_permit_cancellation(v_permit, 'FP3 retry');
    if v_req2 is distinct from v_req1 then
      raise exception 'FP3 FAIL: timestamp moved % -> %', v_req1, v_req2; end if;
    select count(*) into v_audit_after from public.audit_log where target_id = v_permit;
    if v_audit_after <> v_audit_before + 1 then
      raise exception 'FP3 FAIL: audit rows % -> %, expected exactly one added',
        v_audit_before, v_audit_after; end if;

    -- ---------------------------------------------------------------------
    -- FP4: the operator closed the browser. The webhook alone must finish the
    -- job: status cancelled, hold released, audit written -- no UI involved.
    -- ---------------------------------------------------------------------
    perform public.process_stripe_subscription_event(
      v_event, 'customer.subscription.deleted', v_permit, null, 'canceled',
      null, null, 'FP4 webhook');

    select status, cancelled_at into v_status, v_cancelled_at
      from public.permits where id = v_permit;
    if v_status <> 'cancelled' then
      raise exception 'FP4 FAIL: webhook did not cancel the permit (%)', v_status; end if;
    if v_cancelled_at is null then
      raise exception 'FP4 FAIL: cancelled_at not set by webhook'; end if;

    select count(*) into v_holds from public.space_holds
     where permit_id = v_permit and released_at is null;
    if v_holds <> 0 then
      raise exception 'FP4 FAIL: % holds still open after cancellation', v_holds; end if;

    -- The recorded intent survives as history and must not block the final state.
    select cancellation_requested_at into v_req2 from public.permits where id = v_permit;
    if v_req2 is distinct from v_req1 then
      raise exception 'FP4 FAIL: intent timestamp mutated by the webhook'; end if;

    execute format('set local role %I', v_role);
    raise exception using errcode = 'P0001', message = '__CANCEL_ROLLBACK_OK__';
  exception when others then
    execute format('set local role %I', v_role);
    if sqlerrm <> '__CANCEL_ROLLBACK_OK__' then raise; end if;
  end;

  raise notice 'PERMIT CANCELLATION: FP1-FP4 passed';
end $$;

select check_name, result
from (values
  ('FP1', 'PASS: Stripe failure leaves permit active, cancelled_at null, hold open'),
  ('FP2', 'PASS: no webhook means no drift to cancelled and no hold release'),
  ('FP3', 'PASS: repeat cancel is idempotent, timestamp stable, one audit row'),
  ('FP4', 'PASS: webhook alone cancels, releases the hold, and preserves the intent')
) as t(check_name, result);
