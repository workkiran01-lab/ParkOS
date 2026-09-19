-- ParkOS: record the money a Stripe subscription actually collects for a permit.
--
-- Stripe bills a monthly permit and settles an invoice every period, but nothing
-- in ParkOS recorded it: `invoice.payment_succeeded` was not in the webhook's
-- handled set, so a paid permit produced no payment row anywhere. Permit revenue
-- was invisible to the database that is supposed to be its ledger.
--
-- WHY A THIRD PAYMENT TABLE, AND NOT `payments`
--   `payments.reservation_id` is NOT NULL and `payments.stripe_checkout_session_id`
--   is NOT NULL UNIQUE. A subscription invoice has neither: there is no
--   reservation, and no Checkout Session -- Stripe raises the invoice itself on
--   the billing cycle. Relaxing either column would weaken the guarantee for the
--   Checkout rows that genuinely do have both, which is the same reasoning that
--   gave booth_payments its own table in 20260825010000. Permit money gets its
--   own table with its own NOT NULLs: permit_id and stripe_invoice_id.
--
-- WHY THE WRITE PATH IS A FUNCTION, NOT A GRANT
--   Same as both sibling tables: browser clients hold no INSERT/UPDATE/DELETE on
--   any payment table. This row originates from a signature-verified webhook, so
--   record_permit_payment is service-role-only -- narrower than
--   record_booth_payment, which authenticated staff must be able to call because
--   a human hands over the cash. No authenticated caller has any business
--   asserting that Stripe collected money.
--
-- Deliberately NOT given `archived_at`, for the reason recorded in
-- 20260825010000: payment records are financial history that nothing archives.

-- ---------------------------------------------------------------------------
-- permit_payments
-- ---------------------------------------------------------------------------

create table public.permit_payments (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations(id),
  permit_id                uuid not null,
  -- The idempotency key. An invoice is paid once; a webhook re-delivery, a
  -- Stripe replay, or a manual resend must all collapse onto this row.
  stripe_invoice_id        text not null unique check (length(stripe_invoice_id) > 0),
  stripe_payment_intent_id text,
  -- >= 0 rather than > 0: a fully-discounted or trial invoice legitimately
  -- settles at zero, and refusing to record it would make Stripe retry forever.
  amount_cents             integer not null check (amount_cents >= 0),
  currency                 text not null check (char_length(currency) = 3),
  status                   text not null default 'succeeded'
    check (status in ('succeeded')),
  created_at               timestamptz not null default now(),
  -- The composite tenant FK, same as payments/booth_payments: a permit payment
  -- cannot reference a permit belonging to a different org.
  constraint permit_payments_org_id_permit_id_fkey
    foreign key (org_id, permit_id)
    references public.permits (org_id, id)
);

create index permit_payments_org_id_idx on public.permit_payments (org_id);
create index permit_payments_permit_id_idx on public.permit_payments (permit_id);

comment on table public.permit_payments is
  'Subscription invoices Stripe has actually collected for a monthly permit. Clients are read-only; rows are written only by record_permit_payment from the signed webhook. Financial history: never archived or deleted.';
comment on column public.permit_payments.stripe_invoice_id is
  'Stripe-assigned invoice identity, unique. This is what makes a webhook re-delivery idempotent at the data level rather than only at the event level.';
comment on column public.permit_payments.status is
  'Only succeeded rows exist: this table is written from invoice.payment_succeeded alone. A failed invoice suspends the permit (process_stripe_subscription_event) and records no money.';

-- Supabase default privileges hand anon full DML on new tables in public
-- (recorded as an open gap in 20260826040000). Revoke before granting, exactly
-- as booth_payments does, so the table is never left anon-writable.
revoke all on public.permit_payments from anon, authenticated;
grant select on public.permit_payments to authenticated;
grant select, insert, update, delete on public.permit_payments to service_role;

alter table public.permit_payments enable row level security;

create policy permit_payments_select_members on public.permit_payments
  for select
  to authenticated
  using (public.get_user_role(org_id) is not null);

create policy permit_payments_select_own on public.permit_payments
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.permits p
       where p.id = permit_payments.permit_id
         and p.org_id = permit_payments.org_id
         and public.is_own_customer(p.customer_id)
    )
  );

-- ---------------------------------------------------------------------------
-- record_permit_payment -- the single write path for subscription money
-- ---------------------------------------------------------------------------

-- Mirrors process_stripe_subscription_event's contract: same service-role gate,
-- same processed_stripe_events claim, same jsonb {processed, outcome} shape the
-- webhook already reads. Resolves the permit by whichever identifier the invoice
-- carried, because a subscription invoice may arrive with subscription metadata,
-- with only the subscription id, or with both.
create or replace function public.record_permit_payment(
  p_event_id text,
  p_permit_id uuid default null,
  p_stripe_subscription_id text default null,
  p_stripe_invoice_id text default null,
  p_amount_cents integer default null,
  p_currency text default null,
  p_stripe_payment_intent_id text default null,
  p_paid boolean default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_permit public.permits%rowtype;
  v_claimed text;
  v_payment_id uuid;
  v_currency text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = 'P0001', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_event_id is null or length(trim(p_event_id)) = 0 then
    raise exception using errcode = '22023', message = 'STRIPE_EVENT_ID_REQUIRED';
  end if;
  if p_stripe_invoice_id is null or length(trim(p_stripe_invoice_id)) = 0 then
    raise exception using errcode = '22023', message = 'STRIPE_INVOICE_ID_REQUIRED';
  end if;
  -- The event name says the invoice was paid; the payload has to agree. If it
  -- ever does not, that is a payload we do not understand, not money to book.
  if p_paid is distinct from true then
    raise exception using errcode = '22023', message = 'INVOICE_NOT_PAID';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_AMOUNT';
  end if;
  if p_currency is null or p_currency !~ '^[A-Za-z]{3}$' then
    raise exception using errcode = '22023', message = 'INVALID_CURRENCY';
  end if;
  v_currency := upper(p_currency);

  -- FOR UPDATE, like every other permit lifecycle write: a payment landing while
  -- a cancellation is applying must serialize behind it rather than interleave.
  if p_permit_id is not null then
    select p.* into v_permit from public.permits p
     where p.id = p_permit_id for update;
  elsif p_stripe_subscription_id is not null then
    select p.* into v_permit from public.permits p
     where p.stripe_subscription_id = p_stripe_subscription_id for update;
  else
    raise exception using errcode = '22023', message = 'PERMIT_IDENTIFIER_REQUIRED';
  end if;
  if not found then
    raise exception using errcode = 'P0002', message = 'PERMIT_NOT_FOUND';
  end if;
  if p_stripe_subscription_id is not null
     and v_permit.stripe_subscription_id is not null
     and p_stripe_subscription_id <> v_permit.stripe_subscription_id then
    raise exception using errcode = 'P0001', message = 'PERMIT_IDENTIFIER_MISMATCH';
  end if;

  -- Deliberately NOT gated on permit status or archived_at. Stripe has already
  -- taken this money; refusing to write it down because the permit was since
  -- cancelled would lose the record AND make Stripe retry the delivery forever.
  -- The ledger records what happened, not what should have happened.

  -- First write: the event claim and the payment row commit or roll back
  -- together, same as process_stripe_subscription_event.
  insert into public.processed_stripe_events (event_id, org_id)
  values (p_event_id, v_permit.org_id)
  on conflict (event_id) do nothing
  returning event_id into v_claimed;
  if v_claimed is null then
    return jsonb_build_object('processed', false, 'outcome', 'duplicate_event');
  end if;

  -- Second line of defence, and the one that holds when Stripe re-delivers the
  -- same invoice under a NEW event id: unique on stripe_invoice_id.
  insert into public.permit_payments (
    org_id, permit_id, stripe_invoice_id, stripe_payment_intent_id,
    amount_cents, currency
  ) values (
    v_permit.org_id, v_permit.id, p_stripe_invoice_id, p_stripe_payment_intent_id,
    p_amount_cents, v_currency
  )
  on conflict (stripe_invoice_id) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    return jsonb_build_object('processed', false, 'outcome', 'duplicate_invoice');
  end if;

  insert into public.audit_log (
    org_id, actor_id, action, target_table, target_id, reason
  ) values (
    v_permit.org_id, null, 'record_permit_payment', 'permit_payments',
    v_payment_id, p_stripe_invoice_id || ' ' || p_amount_cents || ' cents'
  );

  return jsonb_build_object(
    'processed', true, 'outcome', 'permit_payment_recorded',
    'permit_id', v_permit.id, 'payment_id', v_payment_id
  );
end;
$$;

-- `revoke all ... from public` does NOT drop the direct grant Supabase default
-- privileges hand `authenticated` on a newly created function -- that is the
-- whole subject of 20260827000000. Revoke it by name, or every signed-in browser
-- can call this and assert that Stripe collected money.
revoke all on function public.record_permit_payment(
  text, uuid, text, text, integer, text, text, boolean
) from public, anon, authenticated;

grant execute on function public.record_permit_payment(
  text, uuid, text, text, integer, text, text, boolean
) to service_role;
