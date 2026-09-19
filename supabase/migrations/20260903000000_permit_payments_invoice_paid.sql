-- ParkOS: the permit ledger now also books invoices paid OUT OF BAND.
--
-- 20260829000000 recorded that permit_payments "is written from
-- invoice.payment_succeeded alone". That is no longer true, and the difference
-- is money. Stripe documents the split as:
--
--   "Successful invoice payments trigger both an invoice.paid and
--    invoice.payment_succeeded event. [...] The difference is that
--    invoice.payment_succeeded events are sent for successful invoice payments,
--    but aren't sent when you mark an invoice as paid_out_of_band. invoice.paid
--    events, however, are triggered for both successful payments and out of
--    band payments."
--     -- https://docs.stripe.com/invoicing/integration
--
-- So an invoice settled outside Stripe -- a wire, a cheque, cash handed over --
-- fired NO event ParkOS subscribed to. The money was collected and the ledger
-- recorded nothing, with no error raised anywhere: the same silent shape as the
-- Basil `paid` field removal.
--
-- The webhook now subscribes to invoice.paid as well and routes it to the same
-- record_permit_payment. NOTHING IN THIS MIGRATION CHANGES THAT FUNCTION -- it
-- already accepted such a payload unchanged. This file only corrects the
-- schema's own description of where its rows come from.
--
-- WHY BOTH EVENTS, when Stripe recommends listening to invoice.paid instead of
-- invoice.payment_succeeded: nothing in this repository can see which events
-- the Dashboard endpoint subscribes to, so dropping payment_succeeded could
-- silently stop all permit revenue. Subscribing to both is the failure-safe
-- direction, and it is safe to double-deliver because a normal payment arrives
-- on BOTH events under DIFFERENT event ids -- which processed_stripe_events
-- does not collapse -- and unique permit_payments.stripe_invoice_id does. The
-- second delivery returns duplicate_invoice and writes no row and no audit
-- entry. Concurrent delivery serializes on the permit's FOR UPDATE lock, which
-- record_permit_payment takes before any write.

comment on column public.permit_payments.status is
  'Only succeeded rows exist: this table is written from settled invoices alone (invoice.payment_succeeded and invoice.paid, which also covers payments made out of band). A failed invoice suspends the permit (process_stripe_subscription_event) and records no money.';

comment on column public.permit_payments.stripe_payment_intent_id is
  'The PaymentIntent that settled the invoice, when there was one. NULL is normal and not an error: an invoice paid out of band makes no charge at all, and Stripe does not expand the payments list in event bodies. Idempotency keys off stripe_invoice_id, never this column.';
