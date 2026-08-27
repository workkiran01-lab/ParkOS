-- ParkOS: stop anon getting EXECUTE on new functions by default, and sweep the
-- functions that already have it.
--
-- BACKGROUND. Supabase ships ALTER DEFAULT PRIVILEGES on schema `public`
-- granting EXECUTE on new functions directly to anon, authenticated, and
-- service_role. `revoke all on function ... from public` -- which every one of
-- our migrations ends with -- drops only the PUBLIC pseudo-role and leaves the
-- direct anon grant in place. 20260826020000 and 20260826030000 fixed seven
-- functions one at a time. This fixes the cause and clears the backlog.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT FIX -- READ THIS BEFORE FILING IT AS A BUG
-- ---------------------------------------------------------------------------
-- There are TWO default-ACL entries for FUNCTIONS in schema public, one per
-- granting role:
--
--   granting_role = postgres        -> anon=X/postgres
--   granting_role = supabase_admin  -> anon=X/supabase_admin
--
-- ALTER DEFAULT PRIVILEGES can only be issued for a role you are or can become.
-- On hosted Supabase, `postgres` is NOT a superuser and cannot alter
-- supabase_admin's defaults. Migrations run as postgres, so the postgres entry
-- is the one that governs everything we create, and it is the one changed
-- below. THE supabase_admin ENTRY IS DELIBERATELY LEFT IN PLACE because it is
-- unreachable from here, not because it was missed. Anything created in public
-- by supabase_admin will still be granted to anon. Nothing we own is created
-- that way today. If a function ever appears with `anon=X/supabase_admin` in
-- its ACL, that is this latent entry, not a regression of this migration.
--
-- Likewise this changes DEFAULTS and existing FUNCTION grants only. The same
-- default privileges hand anon `arwdDxtm` on new TABLES in public; that is
-- untouched here and recorded as an open gap in docs/roadmap.md.
--
-- ---------------------------------------------------------------------------
-- THE ALLOWLIST
-- ---------------------------------------------------------------------------
-- Four functions keep anon EXECUTE:
--
--   get_public_facility(uuid)
--     The pre-login facility header on /book/$facilityId. The only deliberate
--     `to anon` grant in the repo (20260819120000). Every other call on that
--     page happens after sign-in, as authenticated.
--
--   get_user_role(uuid)
--   has_any_role(uuid, text[])
--   is_own_customer(uuid)
--     NOT called by the app as anon. Called by RLS POLICIES, which are
--     evaluated as whoever is reading -- has_any_role in 28 policies,
--     get_user_role in 18, is_own_customer in 10, across nearly every table.
--     Measured on parkos-dev: with anon holding EXECUTE, `select from
--     facilities` as anon returns 0 rows; with it revoked, the same query dies
--     with 42501 "permission denied for function get_user_role". Revoking
--     these converts RLS's silent "no rows" into a hard error on every
--     protected table. All three are SECURITY DEFINER role lookups returning
--     null/false for a caller with no membership, so anon holding EXECUTE
--     leaks nothing -- it is what lets RLS answer "no" instead of throwing.
--
-- NOTE ON REPLACING AN ALLOWLISTED FUNCTION LATER. CREATE OR REPLACE preserves
-- an existing ACL, but DROP + CREATE does not, and with the default now fixed a
-- recreated function will NOT get anon back implicitly. Any migration that
-- drops and recreates one of these four must re-issue its
-- `grant execute ... to anon` explicitly.
--
-- Verify with: npm run test:acl

-- ---------------------------------------------------------------------------
-- 1. The cause: new functions created by postgres in public no longer grant
--    EXECUTE to anon. Future objects only -- this changes nothing that already
--    exists, which is what section 2 is for.
-- ---------------------------------------------------------------------------

alter default privileges in schema public revoke execute on functions from anon;

-- ---------------------------------------------------------------------------
-- 2. The backlog: revoke anon EXECUTE from every function we own in public
--    except the four above.
--
--    Written as a loop over pg_proc rather than 36 hand-typed signatures on
--    purpose: the signature list is exactly the thing a human miscopies, and a
--    silent miss here is a function left anon-executable. The loop cannot
--    misspell an argument list. It is scoped to functions OWNED BY postgres so
--    it can never touch an extension's functions (pg_graphql, pgcrypto, and
--    ~186 others live in public and are not ours to re-privilege).
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select p.oid,
           p.proname,
           pg_catalog.pg_get_function_identity_arguments(p.oid) as args
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
       and (p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid))
           not in (
             ('get_public_facility', 'p_facility_id uuid'),
             ('get_user_role',       'check_org_id uuid'),
             ('has_any_role',        'check_org_id uuid, allowed_roles text[]'),
             ('is_own_customer',     'check_customer_id uuid')
           )
  loop
    execute pg_catalog.format(
      'revoke execute on function public.%I(%s) from anon',
      r.proname, r.args);
  end loop;
end $$;
