-- ParkOS Week 13: human-readable booking codes for reservations.
--
-- The reservation PK stays a UUID (Architecture Decision #4). This is a short
-- customer-facing reference alongside it — the parking equivalent of an airline
-- PNR: something a customer can read over the phone and an attendant can type.
-- Reservations only; permits carry their own Stripe invoice numbers and are a
-- deliberately separate code path.

alter table public.reservations add column booking_code text;

-- Unique from the start. Nulls are permitted while the backfill below runs, and
-- this index is what turns a collision into an error instead of a duplicate code.
create unique index reservations_booking_code_key
  on public.reservations (booking_code);

-- SECURITY DEFINER is load-bearing: the collision probe must see every
-- reservation, not just the rows the *inserting* user's RLS exposes. A customer
-- booking a space can read only their own handful of reservations, which would
-- make the probe near-useless for them. The function returns nothing but a
-- freshly generated, unused code, so it leaks no reservation data.
create or replace function public.generate_booking_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Survives being read aloud and copied off a printout: no 0/O, no 1/I/L.
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_bytes bytea;
  v_code text;
begin
  -- 31^6 = 887,503,681 codes, drawn from a CSPRNG. The probe keeps collisions
  -- from reaching the unique index as the table fills; the index is the backstop.
  for _attempt in 1..10 loop
    v_bytes := extensions.gen_random_bytes(6);
    v_code := 'PKS-';
    for i in 0..5 loop
      v_code := v_code || pg_catalog.substr(
        v_alphabet,
        1 + (pg_catalog.get_byte(v_bytes, i) % pg_catalog.length(v_alphabet)),
        1
      );
    end loop;

    if not exists (
      select 1 from public.reservations r where r.booking_code = v_code
    ) then
      return v_code;
    end if;
  end loop;

  raise exception using errcode = 'P0001', message = 'BOOKING_CODE_UNAVAILABLE';
end;
$$;

-- Existing reservations get codes before the column goes NOT NULL.
update public.reservations
   set booking_code = public.generate_booking_code()
 where booking_code is null;

-- A column default, not per-function logic. Every creation path funnels through
-- the single insert in create_reservation — public_create_reservation and
-- check_in_walk_in both `return query select * from create_reservation(...)`
-- rather than inserting themselves — and that insert names its columns
-- explicitly. One default therefore covers all three paths, and any insert path
-- added later inherits it instead of silently producing a code-less row.
alter table public.reservations
  alter column booking_code set default public.generate_booking_code(),
  alter column booking_code set not null;

-- Cheap guard against a hand-written insert inventing its own format.
alter table public.reservations
  add constraint reservations_booking_code_format
  check (booking_code ~ '^PKS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$');

revoke all on function public.generate_booking_code() from public;
grant execute on function public.generate_booking_code() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- get_my_reservations gains booking_code so /my/reservations can show it.
-- Adding a column to the result changes the return type, which CREATE OR
-- REPLACE cannot do — drop and recreate, then restore the grants.
-- ---------------------------------------------------------------------------

drop function public.get_my_reservations();

create function public.get_my_reservations()
returns table (
  reservation_id uuid,
  booking_code text,
  facility_id uuid,
  facility_name text,
  space_id uuid,
  space_number text,
  zone_name text,
  during tstzrange,
  status public.reservation_status,
  total_cents integer,
  currency text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.booking_code, z.facility_id, f.name, s.id, s.space_number, z.name,
         r.during, r.status, r.total_cents, r.currency, r.created_at
    from public.reservations r
    join public.spaces s on s.id = r.space_id
    join public.zones z on z.id = s.zone_id
    join public.facilities f on f.id = z.facility_id
   where public.is_own_customer(r.customer_id)
   order by r.created_at desc;
$$;

revoke all on function public.get_my_reservations() from public;
grant execute on function public.get_my_reservations() to authenticated;
