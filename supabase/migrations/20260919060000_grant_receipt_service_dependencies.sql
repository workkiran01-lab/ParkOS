-- Receipt generation reads reservation details through the service client.
-- Make its existing dependencies explicit instead of relying on hosted defaults.
grant select on public.reservations, public.facilities, public.spaces, public.zones
  to service_role;
grant usage on sequence public.receipts_number_seq to service_role;
