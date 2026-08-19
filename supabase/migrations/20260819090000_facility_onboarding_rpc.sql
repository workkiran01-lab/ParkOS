-- ParkOS Week 4 follow-up: atomic facility onboarding.
-- The onboarding wizard previously issued three sequential client inserts
-- (facility -> zones -> spaces); a mid-flight failure left a partial facility.
-- This RPC performs the whole bootstrap in one transaction: all rows commit
-- together or none do.

-- SECURITY DEFINER is used for atomicity, not to bypass authorization: the
-- function derives org_id from the caller's own profile and re-checks the same
-- admin/manager requirement the RLS insert policies on facilities/zones/spaces
-- enforce, so it grants nothing RLS would not.
create or replace function public.create_facility_with_zones_and_spaces(
  p_name text,
  p_address text,
  p_timezone text,
  p_operating_hours jsonb,
  p_zones jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_facility_id uuid;
  v_zone jsonb;
  v_zone_id uuid;
  v_zone_name text;
  v_batches jsonb;
  v_batch jsonb;
  v_prefix text;
  v_start int;
  v_count int;
  v_width int;
  v_total_spaces int := 0;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select p.org_id into v_org_id
    from public.profiles p
   where p.id = v_user_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'PROFILE_NOT_FOUND';
  end if;

  if not public.has_any_role(v_org_id, array['admin', 'manager']) then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ALLOWED';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception using errcode = 'P0001', message = 'FACILITY_NAME_REQUIRED';
  end if;

  if p_timezone is null or length(trim(p_timezone)) = 0 then
    raise exception using errcode = 'P0001', message = 'TIMEZONE_REQUIRED';
  end if;

  if p_zones is null
     or jsonb_typeof(p_zones) <> 'array'
     or jsonb_array_length(p_zones) = 0 then
    raise exception using errcode = 'P0001', message = 'ZONES_REQUIRED';
  end if;

  insert into public.facilities (org_id, name, address, timezone, operating_hours)
  values (
    v_org_id,
    trim(p_name),
    nullif(trim(coalesce(p_address, '')), ''),
    trim(p_timezone),
    p_operating_hours
  )
  returning id into v_facility_id;

  for v_zone in select * from jsonb_array_elements(p_zones) loop
    v_zone_name := trim(coalesce(v_zone ->> 'zone_name', ''));
    if length(v_zone_name) = 0 then
      raise exception using errcode = 'P0001', message = 'ZONE_NAME_REQUIRED';
    end if;

    insert into public.zones (org_id, facility_id, name, level)
    values (v_org_id, v_facility_id, v_zone_name, (v_zone ->> 'level')::int)
    returning id into v_zone_id;

    v_batches := v_zone -> 'space_batches';
    if v_batches is null
       or jsonb_typeof(v_batches) <> 'array'
       or jsonb_array_length(v_batches) = 0 then
      raise exception using errcode = 'P0001', message = 'SPACE_BATCHES_REQUIRED';
    end if;

    for v_batch in select * from jsonb_array_elements(v_batches) loop
      v_prefix := coalesce(v_batch ->> 'prefix', '');
      v_start := coalesce((v_batch ->> 'starting_number')::int, 1);
      v_count := (v_batch ->> 'count')::int;

      if v_count is null or v_count < 1 or v_count > 1000 then
        raise exception using errcode = 'P0001', message = 'INVALID_SPACE_COUNT';
      end if;
      if v_start < 0 then
        raise exception using errcode = 'P0001', message = 'INVALID_STARTING_NUMBER';
      end if;

      v_total_spaces := v_total_spaces + v_count;
      if v_total_spaces > 10000 then
        raise exception using errcode = 'P0001', message = 'TOO_MANY_SPACES';
      end if;

      -- Match the wizard's original numbering: pad to at least 3 digits, wider
      -- if the batch's highest number needs it (e.g. L1-0001 for 4-digit runs).
      v_width := greatest(3, length((v_start + v_count - 1)::text));

      insert into public.spaces (org_id, zone_id, space_number, space_type)
      select
        v_org_id,
        v_zone_id,
        v_prefix || lpad(n::text, v_width, '0'),
        coalesce(nullif(v_batch ->> 'space_type', ''), 'standard')::public.space_type
      from pg_catalog.generate_series(v_start, v_start + v_count - 1) as n;
    end loop;
  end loop;

  return v_facility_id;
end;
$$;

revoke all on function public.create_facility_with_zones_and_spaces(text, text, text, jsonb, jsonb) from public;
grant execute on function public.create_facility_with_zones_and_spaces(text, text, text, jsonb, jsonb) to authenticated;
