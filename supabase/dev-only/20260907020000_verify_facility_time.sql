-- DEV-ONLY verifier for timezone validation, local conversion, operating-hour
-- coverage, and authoritative availability/creation enforcement.
-- Requires migrations plus DEV_ONLY_seed_dev_orgs.sql in a disposable local DB.

begin;

do $$
declare
  v_original_role text := current_user;
  v_org uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_admin uuid := '00000000-0000-0000-0000-0000000000a1';
  v_facility uuid := '22222222-2222-2222-2222-222222222222';
  v_space uuid;
  v_customer uuid;
  v_count integer;
  v_result timestamptz;
  v_zone_case record;
begin
  begin
    for v_zone_case in select * from (values
      ('America/Los_Angeles', true), ('UTC', true),
      ('PST', false), ('EST', false), ('Pacific', false)
    ) expected(zone, valid) loop
      if public.is_valid_iana_timezone(v_zone_case.zone) is distinct from v_zone_case.valid then
        raise exception 'TIME FAIL: IANA timezone validation disagrees with policy for %', v_zone_case.zone;
      end if;
    end loop;

    begin
      update public.facilities set timezone = 'PST' where id = v_facility;
      raise exception 'TIME FAIL: facility accepted PST';
    exception when sqlstate '22023' then
      if sqlerrm <> 'INVALID_FACILITY_TIMEZONE' then raise; end if;
    end;
    begin
      update public.facilities
         set operating_hours = '{"type":"daily","open":"25:00","close":"17:00"}'
       where id = v_facility;
      raise exception 'TIME FAIL: facility accepted malformed operating hours';
    exception when sqlstate '22023' then
      if sqlerrm <> 'INVALID_FACILITY_OPERATING_HOURS' then raise; end if;
    end;

    -- January is PST (UTC-8), so 10:30 local is independently 18:30Z.
    select public.facility_local_to_utc(
      v_facility, timestamp '2026-01-15 10:30'
    ) into v_result;
    if v_result is distinct from timestamptz '2026-01-15 18:30:00+00' then
      raise exception 'TIME FAIL: normal conversion returned %', v_result;
    end if;

    -- 2026-03-08 02:30 is skipped in Los Angeles.
    begin
      perform public.facility_local_to_utc(
        v_facility, timestamp '2026-03-08 02:30'
      );
      raise exception 'TIME FAIL: spring-forward nonexistent time was accepted';
    -- 22023 invalid_parameter_value, not 22007: 22007 is PostgreSQL's own
    -- "could not parse that as a datetime", and catching it here would also
    -- swallow a genuine parse failure raised from inside the function.
    exception when sqlstate '22023' then
      if sqlerrm <> 'NONEXISTENT_FACILITY_LOCAL_TIME' then raise; end if;
    end;

    -- 2026-11-01 01:30 occurs at 08:30Z (PDT) and 09:30Z (PST).
    -- The documented earlier-occurrence rule must choose 08:30Z.
    select public.facility_local_to_utc(
      v_facility, timestamp '2026-11-01 01:30'
    ) into v_result;
    if v_result is distinct from timestamptz '2026-11-01 08:30:00+00' then
      raise exception 'TIME FAIL: fall-back overlap chose %, expected 08:30Z', v_result;
    end if;

    update public.facilities
       set operating_hours = '{"type":"daily","open":"06:00","close":"22:00"}'
     where id = v_facility;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamp '2028-02-15 06:00' at time zone 'America/Los_Angeles',
      timestamp '2028-02-15 22:00' at time zone 'America/Los_Angeles'
    ) is distinct from true then raise exception 'TIME FAIL: exact daily boundaries were rejected'; end if;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamp '2028-02-15 05:59' at time zone 'America/Los_Angeles',
      timestamp '2028-02-15 07:00' at time zone 'America/Los_Angeles'
    ) is distinct from false then raise exception 'TIME FAIL: before-opening window was accepted'; end if;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamp '2028-02-15 21:00' at time zone 'America/Los_Angeles',
      timestamp '2028-02-15 22:01' at time zone 'America/Los_Angeles'
    ) is distinct from false then raise exception 'TIME FAIL: after-closing window was accepted'; end if;

    update public.facilities
       set operating_hours = '{"type":"daily","open":"22:00","close":"06:00"}'
     where id = v_facility;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamp '2028-02-15 22:00' at time zone 'America/Los_Angeles',
      timestamp '2028-02-16 06:00' at time zone 'America/Los_Angeles'
    ) is distinct from true then raise exception 'TIME FAIL: overnight exact boundaries were rejected'; end if;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamp '2028-02-15 21:59' at time zone 'America/Los_Angeles',
      timestamp '2028-02-15 23:00' at time zone 'America/Los_Angeles'
    ) is distinct from false then raise exception 'TIME FAIL: pre-overnight-opening window was accepted'; end if;

    -- 2028-02-14 is Monday, 15 Tuesday, and 16 Wednesday.
    update public.facilities set operating_hours = '{
      "type":"weekly","days":{
        "mon":{"open":"09:00","close":"17:00"},
        "tue":"closed","wed":"24_hours",
        "thu":"closed","fri":"closed","sat":"closed","sun":"closed"
      }}' where id = v_facility;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamp '2028-02-14 09:00' at time zone 'America/Los_Angeles',
      timestamp '2028-02-14 17:00' at time zone 'America/Los_Angeles'
    ) is distinct from true then raise exception 'TIME FAIL: weekly open day rejected'; end if;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamp '2028-02-15 10:00' at time zone 'America/Los_Angeles',
      timestamp '2028-02-15 11:00' at time zone 'America/Los_Angeles'
    ) is distinct from false then raise exception 'TIME FAIL: weekly closed day accepted'; end if;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamp '2028-02-16 00:00' at time zone 'America/Los_Angeles',
      timestamp '2028-02-17 00:00' at time zone 'America/Los_Angeles'
    ) is distinct from true then raise exception 'TIME FAIL: weekly 24-hour day rejected'; end if;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamp '2028-02-14 16:00' at time zone 'America/Los_Angeles',
      timestamp '2028-02-16 01:00' at time zone 'America/Los_Angeles'
    ) is distinct from false then raise exception 'TIME FAIL: multi-day window crossed a closure'; end if;

    update public.facilities
       set operating_hours = '{"type":"24_hours"}'
     where id = v_facility;
    if public.facility_accepts_reservation_window(
      v_facility,
      timestamptz '2026-03-07 00:00:00+00',
      timestamptz '2026-03-10 00:00:00+00'
    ) is distinct from true then raise exception 'TIME FAIL: multi-day 24-hour DST window rejected'; end if;

    -- Prove the same predicate hides spaces and blocks authoritative creation.
    select s.id into v_space
      from public.spaces s join public.zones z on z.id = s.zone_id
     where z.facility_id = v_facility and s.archived_at is null
     order by s.id limit 1;
    insert into public.customers (org_id, full_name)
    values (v_org, '__TIME_CUSTOMER__') returning id into v_customer;
    insert into public.price_rules (
      org_id, facility_id, hourly_rate_cents, currency, priority
    ) values (v_org, v_facility, 500, 'USD', 1000000);
    update public.facilities set operating_hours = '{
      "type":"weekly","days":{"mon":"closed","tue":"closed",
      "wed":"closed","thu":"closed","fri":"closed",
      "sat":"closed","sun":"closed"}}' where id = v_facility;

    perform set_config(
      'request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', v_admin), true
    );
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    select count(*) into v_count from public.find_available_spaces(
      v_facility,
      timestamp '2028-02-15 10:00' at time zone 'America/Los_Angeles',
      timestamp '2028-02-15 11:00' at time zone 'America/Los_Angeles'
    );
    if v_count <> 0 then
      raise exception 'TIME FAIL: availability returned % spaces while closed', v_count;
    end if;
    begin
      perform public.create_reservation(
        v_space, v_customer, null,
        timestamp '2028-02-15 10:00' at time zone 'America/Los_Angeles',
        timestamp '2028-02-15 11:00' at time zone 'America/Los_Angeles'
      );
      raise exception 'TIME FAIL: authoritative reservation creation ignored closure';
    -- P0001, the code every other ParkOS policy refusal uses. A 22007 escaping
    -- this block now means the facility's operating_hours are unparseable, which
    -- is a different problem and must not be reported as a closed lot.
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'OUTSIDE_OPERATING_HOURS' then raise; end if;
    end;

    execute format('set local role %I', v_original_role);
    if public.safe_timezone('America/Los_Angeles') is distinct from 'America/Los_Angeles' then
      raise exception 'TIME FAIL: canonical report timezone changed';
    end if;
    select count(*) into v_count from public.facilities f
     where (timestamptz '2026-08-19 02:30:00+00' at time zone f.timezone)
       is distinct from
       (timestamptz '2026-08-19 02:30:00+00'
          at time zone public.safe_timezone(f.timezone));
    if v_count <> 0 then
      raise exception 'TIME FAIL: dashboard and report local dates diverge';
    end if;
    begin
      perform public.safe_timezone('Pacific');
      raise exception 'TIME FAIL: report timezone silently accepted invalid value';
    exception when sqlstate '22023' then
      if sqlerrm <> 'INVALID_FACILITY_TIMEZONE' then raise; end if;
    end;

    raise exception using errcode = 'P0001', message = '__TIME_ROLLBACK_OK__';
  exception when others then
    execute format('set local role %I', v_original_role);
    if sqlerrm <> '__TIME_ROLLBACK_OK__' then raise; end if;
  end;

  raise notice 'TIME PASS: IANA validation, conversion/DST, schedules, availability, and authoritative creation';
end $$;

rollback;

select 'PASS' as result,
  'facility timezone and operating-hours semantics verified' as detail;
