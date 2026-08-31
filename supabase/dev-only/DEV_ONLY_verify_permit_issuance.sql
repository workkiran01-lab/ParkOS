-- DEV-ONLY verification for permit issuance rollback (assertion-only).
-- Every block RAISES EXCEPTION on failure. All writes happen inside a
-- subtransaction unwound by a sentinel, so the script is data-neutral.
--
-- Run only against parkos-dev:
--   npx supabase db query --linked --file supabase/dev-only/DEV_ONLY_verify_permit_issuance.sql
--
-- Depends on the dev seed (DEV_ONLY_seed_dev_orgs.sql) for Org A and its admin.
--
-- issue_permit is internally atomic already. What these check is the workflow
-- AROUND it, which was not: the permit used to commit as 'active' holding a
-- space before Stripe was ever called, so a Stripe failure left free parking on
-- an unavailable space.
--
--   IP1  issued permit is 'pending', holds the space, has no subscription
--   IP2  Stripe fails      -> abandon releases the hold and closes the permit
--   IP3  browser closed    -> permit stays 'pending', never drifts to active
--   IP4  two operators     -> second gets SPACE_UNAVAILABLE, creates nothing
--   IP5  abandon twice     -> idempotent; and REFUSES once a subscription exists
--   IP6  webhook promotes pending -> suspended/active, and keeps the hold

do $$
declare
  v_role text := current_user;
  org_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  a_admin uuid := '00000000-0000-0000-0000-0000000000a1';
  c_user uuid := '00000000-0000-0000-0000-0000000000d1';
  v_customer uuid; v_facility uuid; v_space uuid;
  v_permit uuid; v_permit2 uuid;
  v_start timestamptz := date_trunc('hour', now()) + interval '1500 days';
  v_status text; v_holds int; v_sub text;
  v_audit_before int; v_audit_after int;
  v_event text := 'evt_dev_issue_' || substr(md5(random()::text), 1, 12);
begin
  begin
    insert into auth.users
      (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    values ('00000000-0000-0000-0000-000000000000', c_user, 'authenticated',
            'authenticated', 'rls-issue-d1@parkos.dev', 'x', now(), now(), now(), '{}', '{}')
    on conflict (id) do nothing;

    insert into public.customers (org_id, user_id, full_name)
    values (org_a, c_user, '__ISSUE_D1__') returning id into v_customer;

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

    -- -------------------------------------------------------------------
    -- IP1: a freshly issued permit is pending, holds the space, no billing.
    -- -------------------------------------------------------------------
    select p.id into v_permit
      from public.issue_permit(org_a, v_facility, v_space, v_customer,
                               v_start, 15000, 'USD') p;

    execute format('set local role %I', v_role);
    select status, stripe_subscription_id into v_status, v_sub
      from public.permits where id = v_permit;
    if v_status <> 'pending' then
      raise exception 'IP1 FAIL: new permit is % not pending', v_status; end if;
    if v_sub is not null then
      raise exception 'IP1 FAIL: new permit already has a subscription'; end if;
    select count(*) into v_holds from public.space_holds
     where permit_id = v_permit and released_at is null;
    if v_holds <> 1 then
      raise exception 'IP1 FAIL: expected 1 open hold, found %', v_holds; end if;

    -- -------------------------------------------------------------------
    -- IP4: a second operator issuing the SAME space loses the exclusion
    -- constraint. This is why Stripe is not called first.
    -- -------------------------------------------------------------------
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', a_admin), true);
    execute 'set local role authenticated';
    begin
      select p.id into v_permit2
        from public.issue_permit(org_a, v_facility, v_space, v_customer,
                                 v_start + interval '1 day', 15000, 'USD') p;
      raise exception 'IP4 FAIL: second operator issued on a held space';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'SPACE_UNAVAILABLE' then
        raise exception 'IP4 FAIL: wrong rejection "%"', sqlerrm; end if;
    end;
    execute format('set local role %I', v_role);
    select count(*) into v_holds from public.space_holds
     where space_id = v_space and released_at is null;
    if v_holds <> 1 then
      raise exception 'IP4 FAIL: loser left a hold behind (% open)', v_holds; end if;

    -- -------------------------------------------------------------------
    -- IP3: browser closed mid-flow. Nothing runs. The permit must simply
    -- stay pending -- never drift to active, never release its own hold.
    -- -------------------------------------------------------------------
    select status into v_status from public.permits where id = v_permit;
    if v_status <> 'pending' then
      raise exception 'IP3 FAIL: pending permit drifted to %', v_status; end if;
    select count(*) into v_holds from public.space_holds
     where permit_id = v_permit and released_at is null;
    if v_holds <> 1 then
      raise exception 'IP3 FAIL: hold released with no compensation'; end if;

    -- -------------------------------------------------------------------
    -- IP2: Stripe failed, so the UI compensates. Hold released, permit closed.
    -- -------------------------------------------------------------------
    select count(*) into v_audit_before from public.audit_log where target_id = v_permit;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform public.abandon_pending_permit(v_permit, 'IP2 stripe failed');

    select status into v_status from public.permits where id = v_permit;
    if v_status <> 'cancelled' then
      raise exception 'IP2 FAIL: abandoned permit is % not cancelled', v_status; end if;
    select count(*) into v_holds from public.space_holds
     where permit_id = v_permit and released_at is null;
    if v_holds <> 0 then
      raise exception 'IP2 FAIL: % holds still open after abandon', v_holds; end if;
    select count(*) into v_audit_after from public.audit_log where target_id = v_permit;
    if v_audit_after <> v_audit_before + 1 then
      raise exception 'IP2 FAIL: audit rows % -> %, expected one added',
        v_audit_before, v_audit_after; end if;

    -- The space must be sellable again immediately.
    perform set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', a_admin), true);
    execute 'set local role authenticated';
    select p.id into v_permit2
      from public.issue_permit(org_a, v_facility, v_space, v_customer,
                               v_start, 15000, 'USD') p;
    execute format('set local role %I', v_role);
    if v_permit2 is null then
      raise exception 'IP2 FAIL: space not reissuable after abandon'; end if;

    -- -------------------------------------------------------------------
    -- IP5a: abandon twice is a no-op, not an error (operator double-click).
    -- -------------------------------------------------------------------
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform public.abandon_pending_permit(v_permit, 'IP5 repeat');
    select count(*) into v_audit_after from public.audit_log
     where target_id = v_permit and action = 'abandon_pending_permit';
    if v_audit_after <> 1 then
      raise exception 'IP5a FAIL: repeat abandon wrote % audit rows', v_audit_after; end if;

    -- -------------------------------------------------------------------
    -- IP6: the webhook promotes pending. Stripe 'incomplete' is not active or
    -- trialing, so the permit becomes suspended -- and KEEPS its hold.
    -- -------------------------------------------------------------------
    perform public.process_stripe_subscription_event(
      v_event, 'customer.subscription.created', v_permit2,
      'sub_dev_issue_' || substr(md5(v_permit2::text), 1, 12),
      'incomplete', null, null, 'IP6 webhook');

    select status, stripe_subscription_id into v_status, v_sub
      from public.permits where id = v_permit2;
    if v_status <> 'suspended' then
      raise exception 'IP6 FAIL: promoted permit is % not suspended', v_status; end if;
    if v_sub is null then
      raise exception 'IP6 FAIL: webhook did not write stripe_subscription_id'; end if;
    select count(*) into v_holds from public.space_holds
     where permit_id = v_permit2 and released_at is null;
    if v_holds <> 1 then
      raise exception 'IP6 FAIL: promotion released the hold (% open)', v_holds; end if;

    -- -------------------------------------------------------------------
    -- IP5b: abandon MUST refuse once a subscription exists. Stripe won; the
    -- webhook is the writer, and tearing this down would kill live billing.
    -- -------------------------------------------------------------------
    begin
      perform public.abandon_pending_permit(v_permit2, 'IP5b must refuse');
      raise exception 'IP5b FAIL: abandon accepted a permit with a subscription';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'PERMIT_HAS_SUBSCRIPTION' then
        raise exception 'IP5b FAIL: wrong refusal "%"', sqlerrm; end if;
    end;
    select status into v_status from public.permits where id = v_permit2;
    if v_status <> 'suspended' then
      raise exception 'IP5b FAIL: refused call still changed status to %', v_status; end if;
    select count(*) into v_holds from public.space_holds
     where permit_id = v_permit2 and released_at is null;
    if v_holds <> 1 then
      raise exception 'IP5b FAIL: refused call released the hold'; end if;

    execute format('set local role %I', v_role);
    raise exception using errcode = 'P0001', message = '__ISSUE_ROLLBACK_OK__';
  exception when others then
    execute format('set local role %I', v_role);
    if sqlerrm <> '__ISSUE_ROLLBACK_OK__' then raise; end if;
  end;

  raise notice 'PERMIT ISSUANCE: IP1-IP6 passed';
end $$;

select check_name, result
from (values
  ('IP1', 'PASS: issued permit is pending, holds its space, has no subscription'),
  ('IP2', 'PASS: Stripe failure abandons the permit, releases the hold, space reissuable'),
  ('IP3', 'PASS: closed browser leaves pending untouched, no drift to active'),
  ('IP4', 'PASS: concurrent issue on the same space rejected SPACE_UNAVAILABLE, no residue'),
  ('IP5', 'PASS: abandon is idempotent and REFUSES once stripe_subscription_id exists'),
  ('IP6', 'PASS: webhook promotes pending to suspended, writes the id, keeps the hold')
) as t(check_name, result);
