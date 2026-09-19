-- DEV-ONLY: inventory every ParkOS-owned SECURITY DEFINER function and make
-- privilege drift fatal. Behavioral money-path tests remain in the booth,
-- permit, refund, correction, and event-ordering verifiers named below.
--
-- Run only through the loopback-guarded npm command:
--   npm run verify:privileged

begin;

-- One policy/coverage declaration. Both directions of the catalog comparison
-- read this table; a second list cannot drift away from the declared coverage.
create temporary table verifier_privileged_coverage on commit drop as
select * from (
  values
    ('abandon_pending_permit', 'caller', 'tenant', 'DEV_ONLY_verify_permit_issuance.sql'),
    ('accept_invite', 'caller', 'identity', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('calculate_overstay', 'caller', 'tenant', '20260825010000_verify_booth_payments.sql'),
    ('cancel_permit', 'caller', 'tenant', 'DEV_ONLY_verify_permit_cancellation.sql'),
    ('cancel_reservation', 'caller', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('check_in_reservation', 'caller', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('check_in_walk_in', 'caller', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('check_out_reservation', 'caller', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('confirm_reservation', 'caller', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('correct_reservation', 'caller', 'tenant', '20260907010000_verify_reservation_corrections.sql'),
    ('create_facility_with_zones_and_spaces', 'caller', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('create_organization_with_admin', 'caller', 'identity', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('deactivate_account', 'caller', 'identity', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('extend_reservation', 'caller', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('generate_booking_code', 'internal', 'internal', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('get_my_permits', 'caller', 'identity', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('get_my_reservations', 'caller', 'identity', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('get_public_availability', 'caller', 'public-facility', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('get_public_facility', 'public', 'public-facility', 'verify_no_anon_execute.sql'),
    ('get_user_role', 'policy-helper', 'tenant', 'verify_no_anon_execute.sql'),
    ('has_any_role', 'policy-helper', 'tenant', 'verify_no_anon_execute.sql'),
    ('is_account_deactivated', 'caller', 'identity', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('issue_permit', 'caller', 'tenant', 'DEV_ONLY_verify_permit_issuance.sql'),
    ('mark_no_shows', 'service', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('preserve_last_active_admin', 'internal', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql CHECK13; scripts/last-admin-race-test.mjs'),
    ('process_stripe_event', 'service', 'tenant', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('process_stripe_subscription_event', 'service', 'tenant', '20260901000000_verify_permit_event_ordering_guard.sql'),
    ('public_create_reservation', 'caller', 'public-facility', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('public_ensure_customer', 'caller', 'identity', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('public_quote_reservation', 'caller', 'public-facility', 'DEV_ONLY_verify_rls_isolation.sql'),
    ('record_booth_payment', 'caller', 'tenant', '20260825010000_verify_booth_payments.sql'),
    ('record_permit_payment', 'service', 'tenant', '20260829000000_verify_permit_payments.sql'),
    ('record_permit_refund', 'service', 'tenant', '20260906000000_verify_refund_ledgers.sql'),
    ('refund_booth_payment', 'caller', 'tenant', '20260906000000_verify_refund_ledgers.sql'),
    ('request_permit_cancellation', 'caller', 'tenant', 'DEV_ONLY_verify_permit_cancellation.sql'),
    ('reservation_balance_cents', 'caller', 'tenant', '20260825010000_verify_booth_payments.sql'),
    ('reservation_correction_scope', 'caller', 'tenant', '20260907010000_verify_reservation_corrections.sql')
) as coverage(proname, exposure, scope, verifier);

create temporary table verifier_privileged_catalog on commit drop as
with catalog as (
  select p.oid,
         p.proname,
         pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_args,
         p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute,
         exists (
           select 1
             from pg_catalog.aclexplode(
               coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
             ) privilege
            where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
         ) as public_execute
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.prosecdef
     -- Ownership can change. Extension membership, not owner name, separates
     -- application functions from platform-provided extension functions.
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass
          and d.objid = p.oid and d.deptype = 'e'
     )
)
select c.*, coverage.exposure, coverage.scope, coverage.verifier
  from catalog c
  left join verifier_privileged_coverage coverage using (proname);

do $$
declare
  v_missing text;
  v_stale text;
  v_unpinned text;
  v_public text;
  v_anon text;
  v_duplicate text;
begin
  select string_agg(proname, ', ' order by proname)
    into v_duplicate
    from (
      select proname
        from verifier_privileged_catalog
       group by proname
      having count(*) > 1
    ) duplicates;
  if v_duplicate is not null then
    raise exception 'SECURITY DEFINER overload needs an explicit coverage identity: %', v_duplicate;
  end if;

  select string_agg(proname || '(' || identity_args || ')', ', ' order by proname)
    into v_missing
    from verifier_privileged_catalog
   where exposure is null;
  if v_missing is not null then
    raise exception 'SECURITY DEFINER function has no verifier coverage: %', v_missing;
  end if;

  select string_agg(coverage.proname, ', ' order by coverage.proname)
    into v_stale
    from verifier_privileged_coverage coverage
   where not exists (
     select 1 from verifier_privileged_catalog catalog
      where catalog.proname = coverage.proname
   );
  if v_stale is not null then
    raise exception 'SECURITY DEFINER coverage names no deployed function: %', v_stale;
  end if;

  -- `is not true`, NOT `not (...)`: proconfig is NULL for a function that pins
  -- nothing at all, and `not (NULL @> ...)` is NULL, which this WHERE discards.
  -- Written the obvious way this clause could only ever catch a function with a
  -- WRONG search_path, never one with NO search_path -- the case that actually
  -- lets a definer function resolve names as the caller chooses.
  select string_agg(proname, ', ' order by proname)
    into v_unpinned
    from verifier_privileged_catalog
   where (proconfig @> array['search_path=""']) is not true;
  if v_unpinned is not null then
    raise exception 'SECURITY DEFINER function lacks pinned empty search_path: %', v_unpinned;
  end if;

  select string_agg(proname, ', ' order by proname)
    into v_public
    from verifier_privileged_catalog
   where public_execute;
  if v_public is not null then
    raise exception 'SECURITY DEFINER function is executable by PUBLIC: %', v_public;
  end if;

  select string_agg(proname, ', ' order by proname)
    into v_anon
    from verifier_privileged_catalog
   where anon_execute
     and proname not in ('get_public_facility', 'get_user_role', 'has_any_role');
  if v_anon is not null then
    raise exception 'Unexpected anon EXECUTE on SECURITY DEFINER function: %', v_anon;
  end if;

  if not exists (
    select 1 from verifier_privileged_catalog
     where proname = 'record_booth_payment'
       and authenticated_execute and not anon_execute
  ) then
    raise exception 'record_booth_payment must be authenticated-only (not anon)';
  end if;
  if not exists (
    select 1 from verifier_privileged_catalog
     where proname = 'refund_booth_payment'
       and authenticated_execute and not anon_execute
  ) then
    raise exception 'refund_booth_payment must be authenticated-only (not anon)';
  end if;
  if exists (
    select 1 from verifier_privileged_catalog
     where proname in ('record_permit_payment', 'record_permit_refund')
       and (anon_execute or authenticated_execute or not service_execute)
  ) then
    raise exception 'Permit money writers must be service_role-only';
  end if;
end $$;

select proname,
       identity_args,
       exposure,
       scope,
       verifier,
       case when anon_execute then 'anon' else '-' end as anon_execute,
       case when authenticated_execute then 'authenticated' else '-' end as authenticated_execute,
       case when service_execute then 'service_role' else '-' end as service_execute
  from verifier_privileged_catalog
 order by proname, identity_args;

rollback;
