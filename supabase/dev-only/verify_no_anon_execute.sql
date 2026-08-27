-- DEV-ONLY: assert that no function in `public` is executable by `anon`
-- except the ones deliberately meant to be.
--
--   npm run test:acl
--   npx supabase db query --linked --file supabase/dev-only/verify_no_anon_execute.sql
--
-- WHY THIS EXISTS, AND WHY IT IS NOT A GREP OVER THE MIGRATIONS.
-- Supabase ships ALTER DEFAULT PRIVILEGES on schema `public` granting EXECUTE
-- on new functions directly to anon, authenticated, and service_role. Our
-- migrations all end with `revoke all on function ... from public`, which drops
-- only the PUBLIC pseudo-role and leaves the direct anon grant untouched. Seven
-- functions shipped with a header comment reading "No anon access" while anon
-- could in fact execute them, including record_booth_payment, which is SECURITY
-- DEFINER and writes money.
--
-- A textual guard over migration files would have PASSED on all seven: the
-- `revoke` line was present in every one of them. The text and the ACL
-- disagreed, and the ACL is what the database enforces. So this check reads
-- pg_proc.proacl -- ground truth -- and never the migration text. It therefore
-- also catches functions created inside DO blocks, via CREATE OR REPLACE in a
-- later migration, or by any path a grep cannot see.
--
-- It runs against a live database and so cannot join the offline `npm test`.
-- That is inherent: the grant is created by the platform at CREATE FUNCTION
-- time, so it does not exist to be observed until after a migration is applied.
--
-- Read-only. No transaction needed; it writes nothing.
--
-- EXTENDING THIS. The same ALTER DEFAULT PRIVILEGES grants anon `arwdDxtm`
-- (INSERT/UPDATE/DELETE included) on every new TABLE in public, where RLS is
-- the only thing standing between anon and a write. Adding a second verdict
-- over pg_class/relacl for tables missing `relrowsecurity` would cover that.
-- Not done here; recorded in docs/roadmap.md.

with allowed(proname, identity_args) as (
  -- The ONLY functions anon is meant to execute. Adding a row here is a
  -- deliberate act: it means an unauthenticated visitor may call it.
  --
  -- get_public_facility backs the pre-login header on /book/$facilityId (name,
  -- address, hours). It is the single explicit `to anon` grant in the repo
  -- (20260819120000). Everything else on that page runs after sign-in.
  --
  -- The three role helpers below are NOT called by the app as anon -- they are
  -- called by RLS POLICIES, and a policy is evaluated as whoever is reading.
  -- has_any_role appears in 28 policies, get_user_role in 18, is_own_customer
  -- in 10, covering nearly every table. Measured: with anon holding EXECUTE,
  -- `select from facilities` as anon returns 0 rows; with it revoked, the same
  -- query fails with 42501 "permission denied for function get_user_role"
  -- instead of filtering. Revoking them converts a silent empty result into a
  -- hard error on every RLS-protected table. They are SECURITY DEFINER role
  -- lookups that return null/false for a caller with no membership, so anon
  -- holding EXECUTE leaks nothing -- it is what makes RLS able to say "no".
  values ('get_public_facility', 'p_facility_id uuid'),
         ('get_user_role', 'check_org_id uuid'),
         ('has_any_role', 'check_org_id uuid, allowed_roles text[]'),
         ('is_own_customer', 'check_customer_id uuid')
),
ours as (
  -- Only functions we own. The ~188 extension-owned functions in public
  -- (pg_graphql, pgcrypto, and friends) are not ours to re-privilege.
  select p.oid,
         p.proname,
         pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_args,
         p.prosecdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
),
offenders as (
  select o.*
    from ours o
   where has_function_privilege('anon', o.oid, 'EXECUTE')
     and not exists (
       select 1 from allowed a
        where a.proname = o.proname
          and a.identity_args = o.identity_args
     )
),
-- An allowlist entry that no longer matches a real function is itself a
-- problem: it silently permits nothing, and hides a rename.
stale_allowlist as (
  select a.proname, a.identity_args
    from allowed a
   where not exists (
     select 1 from ours o
      where o.proname = a.proname and o.identity_args = a.identity_args
   )
)

select case
         when (select count(*) from offenders) = 0
          and (select count(*) from stale_allowlist) = 0
           then 'PASS'
         else 'FAIL'
       end as verdict,
       (select count(*) from ours)::text          as functions_owned,
       (select count(*) from offenders)::text     as anon_executable_offenders,
       (select count(*) from stale_allowlist)::text as stale_allowlist_entries,
       coalesce(
         (select string_agg(
                   o.proname || '(' || o.identity_args || ') ['
                   || case when o.prosecdef then 'DEFINER' else 'INVOKER' end || ']',
                   ', ' order by o.prosecdef desc, o.proname)
            from offenders o),
         'none') as offending_functions;
