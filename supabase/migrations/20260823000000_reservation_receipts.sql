-- ParkOS Week 13: itemized PDF receipts for reservation payments.
--
-- A receipt is a derived artifact of a *succeeded* reservation payment. The PDF
-- is generated once by the stripe-webhook (service role) from the reservation's
-- stored price_breakdown, uploaded to a private bucket, and recorded here. No
-- hard deletes; authenticated clients are read-only, exactly like payments.

-- Human-friendly, globally-unique receipt numbers. A single sequence is fine:
-- receipt numbers must be unique and identifiable, not gapless-per-org.
create sequence public.receipts_number_seq;

create table public.receipts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id),
  reservation_id uuid not null,
  payment_id     uuid not null references public.payments(id),
  storage_path   text not null,
  receipt_number text not null unique
    default 'RCPT-' || lpad(nextval('public.receipts_number_seq')::text, 6, '0'),
  created_at     timestamptz not null default now(),
  -- One receipt per successful payment. The webhook relies on this for idempotency.
  constraint receipts_payment_id_key unique (payment_id),
  constraint receipts_org_id_reservation_id_fkey
    foreign key (org_id, reservation_id)
    references public.reservations (org_id, id)
);

create index receipts_org_idx on public.receipts (org_id);
create index receipts_reservation_idx on public.receipts (reservation_id);

comment on table public.receipts is
  'Read-only for authenticated clients. Rows are written only by the Stripe webhook (service role) after a payment succeeds; download is via a short-lived signed URL from the receipt-download function.';

-- Explicit grants: authenticated clients read only. Service role writes.
revoke all on public.receipts from anon, authenticated;
grant select on public.receipts to authenticated;
grant select, insert, update, delete on public.receipts to service_role;

alter table public.receipts enable row level security;

-- Same access shape as payments: org members see their org's receipts; a
-- customer sees receipts for their own reservations.
create policy receipts_select_members on public.receipts
  for select
  to authenticated
  using (public.get_user_role(org_id) is not null);

create policy receipts_select_own on public.receipts
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.reservations r
       where r.id = receipts.reservation_id
         and r.org_id = receipts.org_id
         and public.is_own_customer(r.customer_id)
    )
  );

-- Private bucket, org_id/ path prefix — same pattern as vehicle-photos (Week 10).
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Objects are written only by the service role (which bypasses RLS) and read
-- via service-role signed URLs, so no write policy is needed. A read policy for
-- org members mirrors vehicle-photos and lets staff tooling read directly.
-- Customers (not org members) download through the receipt-download function.
create policy "receipts_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and public.get_user_role(((storage.foldername(name))[1])::uuid) is not null
  );
