-- TRUNCATE bypasses row-level security and DELETE triggers. Supabase's broad
-- table defaults must not turn a browser role into a cross-tenant bulk deleter.
-- These are the defaults of the migration owner; no hosted admin role is used.
alter default privileges in schema public revoke truncate on tables
  from public, anon, authenticated, service_role;

do $$
declare v_table record;
begin
  for v_table in
    select c.relname from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
      and not exists (
        select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_class'::regclass
          and d.objid = c.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke truncate on table public.%I from public, anon, authenticated, service_role', v_table.relname);
  end loop;
end;
$$;
