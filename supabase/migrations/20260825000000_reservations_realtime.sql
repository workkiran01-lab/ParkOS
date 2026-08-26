-- Dashboard reservation and check-in changes are delivered through Realtime.
-- Existing reservation check-in updates do not touch space_holds, so the
-- reservations table must be published independently.
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'reservations'
  ) then
    alter publication supabase_realtime add table public.reservations;
    raise notice 'PARKOS: added public.reservations to supabase_realtime';
  else
    raise notice 'PARKOS: public.reservations already in supabase_realtime';
  end if;
end $$;
