-- ParkOS Week 6: pricing administration + staff availability search.

-- Same gap and same fix as Week 5's space_holds: Week 3 defined SELECT and
-- INSERT policies only, so under default-deny RLS price rules could be created
-- but never edited or archived through the API. Admin/manager may update rules
-- in their org.
create policy price_rules_update on public.price_rules
  for update using (public.has_any_role(org_id, array['admin','manager']))
             with check (public.has_any_role(org_id, array['admin','manager']));

-- ---------------------------------------------------------------------------
-- Availability search
-- ---------------------------------------------------------------------------

-- Unlike Week 4/5's SECURITY DEFINER functions — which had to bypass RLS to
-- bootstrap rows a not-yet-member caller could never insert (org creation,
-- invite acceptance) or to make a multi-table write atomic under one privilege
-- check (facility onboarding) — this function only READS rows the caller's own
-- RLS SELECT policies already govern. It therefore runs as the caller
-- (security invoker, the default): RLS filters spaces/zones/space_holds to the
-- caller's org automatically, and there is no reason to elevate privileges.
create or replace function public.find_available_spaces(
  p_facility_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_space_type public.space_type default null
)
returns setof public.spaces
language sql
stable
set search_path = ''
as $$
  select s.*
    from public.spaces s
    join public.zones z on z.id = s.zone_id and z.org_id = s.org_id
   where z.facility_id = p_facility_id
     and s.archived_at is null
     and z.archived_at is null
     and (p_space_type is null or s.space_type = p_space_type)
     and p_start is not null
     and p_end > p_start
     and not exists (
       -- The exclusion constraint's partial GiST index on (space_id, during)
       -- where released_at is null serves exactly this probe.
       select 1
         from public.space_holds h
        where h.space_id = s.id
          and h.released_at is null
          and h.during && tstzrange(p_start, p_end, '[)')
     )
   order by s.space_number;
$$;

revoke all on function public.find_available_spaces(uuid, timestamptz, timestamptz, public.space_type) from public;
grant execute on function public.find_available_spaces(uuid, timestamptz, timestamptz, public.space_type) to authenticated;
