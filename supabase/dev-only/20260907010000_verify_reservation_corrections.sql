-- DEV-ONLY, data-neutral reservation-correction verifier.
-- Requires migrations plus DEV_ONLY_seed_dev_orgs.sql in a disposable local DB.
-- Every assertion is inside a sentinel subtransaction and the outer transaction
-- is rolled back. Any unexpected result propagates as a nonzero SQL failure.

begin;

do $$
declare
  v_original_role text := current_user;
  v_org_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_org_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  v_admin_a uuid := '00000000-0000-0000-0000-0000000000a1';
  v_attendant_a uuid := '00000000-0000-0000-0000-0000000000a3';
  v_admin_b uuid := '00000000-0000-0000-0000-0000000000b1';
  v_owner_viewer uuid := '00000000-0000-0000-0000-0000000000e1';
  v_facility uuid := '22222222-2222-2222-2222-222222222222';
  v_other_facility uuid := '11111111-1111-1111-1111-111111111111';
  v_customer uuid;
  v_vehicle uuid;
  v_space_1 uuid;
  v_space_2 uuid;
  v_space_3 uuid;
  v_other_facility_space uuid;
  v_other_tenant_space uuid;
  v_reservation uuid;
  v_blocking_reservation uuid;
  v_start timestamptz := timestamp '2028-02-15 10:00' at time zone 'America/Los_Angeles';
  v_end timestamptz := timestamp '2028-02-15 12:00' at time zone 'America/Los_Angeles';
  v_new_start timestamptz := timestamp '2028-02-15 11:00' at time zone 'America/Los_Angeles';
  v_new_end timestamptz := timestamp '2028-02-15 14:00' at time zone 'America/Los_Angeles';
  v_count integer;
  v_affected jsonb;
  v_preview jsonb;
  v_preview_count integer;
begin
  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at, raw_app_meta_data,
      raw_user_meta_data
    ) values (
      '00000000-0000-0000-0000-000000000000', v_owner_viewer,
      'authenticated', 'authenticated', 'correction-owner@parkos.test', 'x',
      now(), now(), now(), '{}', '{}'
    ) on conflict (id) do nothing;
    insert into public.memberships (org_id, user_id, role)
    values (v_org_a, v_owner_viewer, 'owner_viewer')
    on conflict (org_id, user_id) do update set role = excluded.role;

    insert into public.customers (org_id, full_name, email, phone)
    values (v_org_a, '__CORRECTION_CUSTOMER__', 'before@example.com', '562-555-0100')
    returning id into v_customer;
    insert into public.vehicles (org_id, customer_id, license_plate)
    values (v_org_a, v_customer, 'OLD123')
    returning id into v_vehicle;

    select s.id into v_space_1
      from public.spaces s join public.zones z on z.id = s.zone_id
     where z.facility_id = v_facility and s.archived_at is null
     order by s.id limit 1;
    select s.id into v_space_2
      from public.spaces s join public.zones z on z.id = s.zone_id
     where z.facility_id = v_facility and s.archived_at is null
       and s.id <> v_space_1
     order by s.id limit 1;
    select s.id into v_space_3
      from public.spaces s join public.zones z on z.id = s.zone_id
     where z.facility_id = v_facility and s.archived_at is null
       and s.id not in (v_space_1, v_space_2)
     order by s.id limit 1;
    select s.id into v_other_facility_space
      from public.spaces s join public.zones z on z.id = s.zone_id
     where z.facility_id = v_other_facility and s.archived_at is null
     order by s.id limit 1;
    select s.id into v_other_tenant_space
      from public.spaces s
     where s.org_id = v_org_b and s.archived_at is null
     order by s.id limit 1;

    if v_space_1 is null or v_space_2 is null or v_space_3 is null
       or v_other_facility_space is null or v_other_tenant_space is null then
      raise exception 'CORRECTION FAIL: required seed spaces are missing';
    end if;

    insert into public.price_rules (
      org_id, facility_id, hourly_rate_cents, currency, priority
    ) values (v_org_a, v_facility, 525, 'USD', 1000000);

    perform set_config(
      'request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', v_admin_a),
      true
    );
    perform set_config('request.jwt.claim.sub', v_admin_a::text, true);
    execute 'set local role authenticated';
    select created.reservation_id into v_reservation
      from public.create_reservation(
        v_space_1, v_customer, v_vehicle, v_start, v_end
      ) created;
    select created.reservation_id into v_blocking_reservation
      from public.create_reservation(
        v_space_3, v_customer, v_vehicle, v_new_start, v_new_end
      ) created;

    -- Attendant is an existing operational role and may perform a constrained
    -- same-facility correction. This one exercises plate/contact/time/space.
    execute format('set local role %I', v_original_role);
    perform set_config(
      'request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', v_attendant_a),
      true
    );
    perform set_config('request.jwt.claim.sub', v_attendant_a::text, true);
    execute 'set local role authenticated';
    -- What staff are shown BEFORE confirming, captured before anything moves.
    select scope.affected_count, scope.affected_reservations
      into v_preview_count, v_preview
      from public.reservation_correction_scope(v_reservation) scope;

    select corrected.affected_reservations into v_affected
      from public.correct_reservation(
        v_reservation, v_space_2, v_new_start, v_new_end,
        'Corrected Customer', 'after@example.com', '+1 (562) 555-0199',
        'NEW-456', 'front desk corrected intake details'
      ) corrected;

    execute format('set local role %I', v_original_role);
    select count(*) into v_count
      from public.reservations r
      join public.space_holds h on h.reservation_id = r.id
      join public.customers c on c.id = r.customer_id
      join public.vehicles v on v.id = r.vehicle_id
     where r.id = v_reservation
       and r.space_id = v_space_2
       and r.during = tstzrange(v_new_start, v_new_end, '[)')
       and r.total_cents = 1575
       and h.space_id = v_space_2
       and h.during = r.during
       and h.released_at is null
       and c.full_name = 'Corrected Customer'
       and c.email = 'after@example.com'
       and c.phone = '+1 (562) 555-0199'
       and v.license_plate = 'NEW-456';
    if v_count <> 1 then
      raise exception 'CORRECTION FAIL: valid same-facility correction was not atomic';
    end if;

    select count(*) into v_count from public.audit_log a
     where a.target_id = v_reservation
       and a.action = 'correct_reservation'
       and a.actor_id = v_attendant_a
       and (a.reason::jsonb ->> 'operator_reason') = 'front desk corrected intake details'
       and a.reason::jsonb -> 'before' ->> 'space_id' = v_space_1::text
       and a.reason::jsonb -> 'after' ->> 'space_id' = v_space_2::text;
    if v_count <> 1 then
      raise exception 'CORRECTION FAIL: before/after audit record missing';
    end if;

    -- Customer and vehicle rows are shared per org, so this correction is
    -- global BY DESIGN. v_blocking_reservation shares both with v_reservation
    -- and must now show the corrected values. Asserting the sibling explicitly
    -- is what stops the global write being silently unverified: without this,
    -- the defect satisfies the single-reservation assertion above.
    select count(*) into v_count
      from public.reservations r
      join public.customers c on c.id = r.customer_id
      join public.vehicles v on v.id = r.vehicle_id
     where r.id = v_blocking_reservation
       and c.full_name = 'Corrected Customer'
       and c.email = 'after@example.com'
       and c.phone = '+1 (562) 555-0199'
       and v.license_plate = 'NEW-456';
    if v_count <> 1 then
      raise exception 'CORRECTION FAIL: shared-record correction did not reach the sibling reservation';
    end if;

    -- ...and the change must be discoverable FROM the sibling itself, keyed on
    -- its own id, not only from the reservation the operator corrected.
    select count(*) into v_count from public.audit_log a
     where a.target_id = v_blocking_reservation
       and a.target_table = 'reservations'
       and a.action = 'correct_reservation_side_effect'
       and a.actor_id = v_attendant_a
       and (a.reason::jsonb ->> 'origin_reservation_id') = v_reservation::text
       and (a.reason::jsonb ->> 'shared_record') = 'customer+vehicle'
       and a.reason::jsonb -> 'before' -> 'customer' ->> 'full_name'
             = '__CORRECTION_CUSTOMER__'
       and a.reason::jsonb -> 'before' -> 'vehicle' ->> 'license_plate' = 'OLD123'
       and a.reason::jsonb -> 'after' -> 'customer' ->> 'full_name'
             = 'Corrected Customer'
       and a.reason::jsonb -> 'after' -> 'vehicle' ->> 'license_plate' = 'NEW-456';
    if v_count <> 1 then
      raise exception 'CORRECTION FAIL: sibling reservation has no side-effect audit row';
    end if;

    -- The RPC must hand the caller the same set, so the UI can name it.
    if v_affected is null
       or pg_catalog.jsonb_array_length(v_affected) <> 1
       or (v_affected -> 0 ->> 'reservation_id') is distinct from v_blocking_reservation::text
       or (v_affected -> 0 ->> 'shared') is distinct from 'customer+vehicle' then
      raise exception 'CORRECTION FAIL: correct_reservation did not return the affected reservation';
    end if;

    -- The preview staff confirm against must match what actually happened.
    if v_preview_count is distinct from 1
       or v_preview is null
       or (v_preview -> 0 ->> 'reservation_id') is distinct from v_blocking_reservation::text then
      raise exception 'CORRECTION FAIL: correction scope preview did not match the affected set';
    end if;

    -- No reservation UPDATE policy exists. Even an org admin cannot directly
    -- alter a protected total; the attempted UPDATE must affect zero rows.
    perform set_config(
      'request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', v_admin_a),
      true
    );
    perform set_config('request.jwt.claim.sub', v_admin_a::text, true);
    execute 'set local role authenticated';
    update public.reservations set total_cents = 1 where id = v_reservation;
    get diagnostics v_count = row_count;
    if v_count <> 0 then
      raise exception 'CORRECTION FAIL: direct protected financial update succeeded';
    end if;

    -- The exclusion constraint must reject a move onto an occupied space and
    -- roll the preceding reservation/customer/vehicle writes back together.
    begin
      perform public.correct_reservation(
        v_reservation, v_space_3, v_new_start, v_new_end,
        'Should Roll Back', 'rollback@example.com', '562-555-0111',
        'BAD999', 'expected overlap rejection'
      );
      raise exception 'CORRECTION FAIL: conflicting space/time correction succeeded';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'SPACE_UNAVAILABLE' then raise; end if;
    end;

    -- Same tenant but different facility is deliberately outside this RPC.
    begin
      perform public.correct_reservation(
        v_reservation, v_other_facility_space, v_new_start, v_new_end,
        'Corrected Customer', 'after@example.com', '+1 (562) 555-0199',
        'NEW-456', 'expected facility rejection'
      );
      raise exception 'CORRECTION FAIL: cross-facility correction succeeded';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'WRONG_FACILITY' then raise; end if;
    end;

    begin
      perform public.correct_reservation(
        v_reservation, v_other_tenant_space, v_new_start, v_new_end,
        'Corrected Customer', 'after@example.com', '+1 (562) 555-0199',
        'NEW-456', 'expected tenant rejection'
      );
      raise exception 'CORRECTION FAIL: cross-tenant target space succeeded';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'WRONG_TENANT' then raise; end if;
    end;

    -- Another tenant's admin cannot correct an Org A reservation at all.
    execute format('set local role %I', v_original_role);
    perform set_config(
      'request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', v_admin_b),
      true
    );
    perform set_config('request.jwt.claim.sub', v_admin_b::text, true);
    execute 'set local role authenticated';
    begin
      perform public.correct_reservation(
        v_reservation, v_space_2, v_new_start, v_new_end,
        'Corrected Customer', 'after@example.com', '+1 (562) 555-0199',
        'NEW-456', 'expected role rejection'
      );
      raise exception 'CORRECTION FAIL: foreign-tenant admin corrected reservation';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'ROLE_NOT_ALLOWED' then raise; end if;
    end;

    -- owner_viewer remains read-only under the existing role model.
    execute format('set local role %I', v_original_role);
    perform set_config(
      'request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', v_owner_viewer),
      true
    );
    perform set_config('request.jwt.claim.sub', v_owner_viewer::text, true);
    execute 'set local role authenticated';
    begin
      perform public.correct_reservation(
        v_reservation, v_space_2, v_new_start, v_new_end,
        'Corrected Customer', 'after@example.com', '+1 (562) 555-0199',
        'NEW-456', 'expected owner viewer rejection'
      );
      raise exception 'CORRECTION FAIL: owner_viewer corrected reservation';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'ROLE_NOT_ALLOWED' then raise; end if;
    end;

    -- anon has no EXECUTE grant, independently of the RPC's auth.uid guard.
    execute format('set local role %I', v_original_role);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    execute 'set local role anon';
    begin
      perform public.correct_reservation(
        v_reservation, v_space_2, v_new_start, v_new_end,
        'Corrected Customer', 'after@example.com', '+1 (562) 555-0199',
        'NEW-456', 'expected anonymous rejection'
      );
      raise exception 'CORRECTION FAIL: anonymous correction succeeded';
    exception when sqlstate '42501' then null;
    end;

    execute format('set local role %I', v_original_role);
    raise exception using errcode = 'P0001', message = '__CORRECTION_ROLLBACK_OK__';
  exception when others then
    execute format('set local role %I', v_original_role);
    if sqlerrm <> '__CORRECTION_ROLLBACK_OK__' then raise; end if;
  end;

  raise notice 'CORRECTION PASS: staff authorization, tenant/facility scope, protected fields, conflicts, contact/plate/time/space, and audit';
end $$;

rollback;

select 'PASS' as result,
  'reservation corrections are constrained, atomic, and audited' as detail;
