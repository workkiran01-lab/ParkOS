-- Fixes report_occupancy_by_day from 20260824000000.
--
-- Two defects in the original, both only visible with more than one facility in
-- scope (the All facilities case):
--
-- 1. The inner CTE grouped by (day, space_count) rather than (day, facility).
--    Two facilities with different space counts therefore produced two rows for
--    the same day, so the report emitted duplicate buckets and the final
--    aggregate multiplied space_hours by the number of distinct space counts.
--
-- 2. Facilities whose spaces had no holds at all vanished from the result
--    instead of reporting 0%, because the held-hours CTE could not contribute a
--    row for them.
--
-- Now: held hours are aggregated per (day, facility) over real holds only, then
-- LEFT JOINed back onto the day/facility grid so a facility with no holds
-- contributes 0 held hours while still counting toward space_hours. Exactly one
-- row per day comes out.
--
-- The joins to spaces and space_holds must stay INNER. GREATEST and LEAST in
-- Postgres ignore NULL arguments rather than propagating them, so a LEFT JOIN
-- row for a space with no hold silently evaluates to a full day held.

create or replace function public.report_occupancy_by_day(
  p_from date,
  p_to date,
  p_facility_id uuid default null
)
returns table (
  bucket date,
  held_hours numeric,
  space_hours numeric,
  occupancy_pct numeric
)
language sql
stable
set search_path = ''
as $$
  with fac as (
    select f.id,
           public.safe_timezone(f.timezone) as tz,
           (select pg_catalog.count(*)
              from public.spaces s
              join public.zones z on z.id = s.zone_id
             where z.facility_id = f.id
               and s.archived_at is null) as space_count
      from public.facilities f
     where f.archived_at is null
       and (p_facility_id is null or f.id = p_facility_id)
  ),
  days as (
    select d::date as day
      from pg_catalog.generate_series(p_from, p_to, interval '1 day') as d
  ),
  windows as (
    select days.day,
           fac.id as facility_id,
           fac.space_count,
           (days.day::timestamp at time zone fac.tz) as win_start,
           ((days.day + 1)::timestamp at time zone fac.tz) as win_end
      from days cross join fac
     where fac.space_count > 0
  ),
  held as (
    select w.day,
           w.facility_id,
           pg_catalog.sum(
             greatest(
               0,
               extract(epoch from (
                 least(
                   coalesce(upper(h.during), w.win_end),
                   coalesce(h.released_at, w.win_end),
                   w.win_end
                 )
                 - greatest(lower(h.during), w.win_start)
               )) / 3600.0
             )
           ) as held_hours
      from windows w
      join public.zones z on z.facility_id = w.facility_id
      join public.spaces s on s.zone_id = z.id and s.archived_at is null
      join public.space_holds h
        on h.space_id = s.id
       and h.during && tstzrange(w.win_start, w.win_end, '[)')
     group by w.day, w.facility_id
  )
  select w.day as bucket,
         pg_catalog.round(coalesce(pg_catalog.sum(h.held_hours), 0)::numeric, 2),
         pg_catalog.round(pg_catalog.sum(w.space_count * 24)::numeric, 2),
         case
           when pg_catalog.sum(w.space_count * 24) > 0
             then pg_catalog.round(
               (coalesce(pg_catalog.sum(h.held_hours), 0) * 100.0
                / pg_catalog.sum(w.space_count * 24))::numeric, 2)
           else 0
         end
    from windows w
    left join held h
      on h.day = w.day
     and h.facility_id = w.facility_id
   group by w.day
   order by w.day;
$$;
