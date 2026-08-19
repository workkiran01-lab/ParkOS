-- ParkOS Week 5: facility, zone, and space administration.

-- Active spaces must have unique numbers within a zone; archiving a space
-- frees its number for reuse. The partial predicate is what allows the reuse.
create unique index spaces_zone_id_space_number_active_key
  on public.spaces (zone_id, space_number)
  where archived_at is null;

-- Week 3 gave space_holds SELECT and INSERT policies only, which made holds
-- immutable through the API: "release early" (set released_at = now()) is an
-- UPDATE and default-deny RLS blocked it for every role. Admin/manager may
-- update holds in their org. The exclusion constraint still guarantees no
-- overlapping active holds regardless of what an update writes.
create policy space_holds_update on public.space_holds
  for update using (public.has_any_role(org_id, array['admin','manager']))
             with check (public.has_any_role(org_id, array['admin','manager']));
