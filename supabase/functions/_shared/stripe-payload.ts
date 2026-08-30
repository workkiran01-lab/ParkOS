// Pure readers for Stripe webhook payloads: raw event JSON -> the exact scalars
// ParkOS stores. Kept free of the Stripe SDK and of Deno APIs (its only import
// is the regex in http.ts) so it runs under any TS runner and the
// "we pluck the right fields off a real payload" invariant has a real test --
// the same reasoning receipt-content.ts records. stripe-webhook/index.ts holds
// the Deno.serve entry point and the RPC calls; everything it needs to READ out
// of a payload lives here.
//
// Everything takes `unknown` or a plain bag rather than Stripe.Invoice on
// purpose: the fields ParkOS depends on have moved between Stripe API versions,
// and a webhook payload is rendered at whatever version the ENDPOINT is pinned
// to -- not at the SDK's version. The SDK types describe one version; these
// readers have to survive both.

import { isUuid } from './http.ts'

export type NormalizedInvoice = {
  permitId: string | null
  subscriptionId: string | null
  invoiceId: string | null
  amountPaidCents: number | null
  currency: string | null
  paymentIntentId: string | null
  paid: boolean
}

export function stripeObjectId(value: unknown) {
  if (typeof value === 'string' && value) return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = value.id
    return typeof id === 'string' && id ? id : null
  }
  return null
}

export function metadataUuid(value: string | undefined) {
  return isUuid(value ?? null) ? value : null
}

export function integerOrNull(value: number | null | undefined) {
  return Number.isInteger(value) ? (value as number) : null
}

export function currencyOrNull(value: string | null | undefined) {
  return value && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null
}

export function unixTimestamp(value: number | null | undefined) {
  return Number.isInteger(value)
    ? new Date((value as number) * 1_000).toISOString()
    : null
}

export function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

// One reading of an invoice payload, shared by the payment_failed path (which
// needs only the permit identity) and the payment_succeeded path (which also
// needs the money).
export function normalizeInvoice(
  invoice: Record<string, unknown>,
): NormalizedInvoice {
  const parent = objectOrNull(invoice.parent)
  const details = objectOrNull(parent?.subscription_details)
  const metadata = objectOrNull(details?.metadata)

  return {
    permitId: metadataUuid(
      typeof metadata?.permit_id === 'string' ? metadata.permit_id : undefined,
    ),
    subscriptionId: stripeObjectId(
      details?.subscription ?? invoice.subscription,
    ),
    invoiceId: stripeObjectId(invoice.id),
    // amount_paid, not amount_due or total: the ledger records what Stripe
    // actually collected, which a discount or credit balance can make smaller.
    amountPaidCents: integerOrNull(
      typeof invoice.amount_paid === 'number' ? invoice.amount_paid : null,
    ),
    currency: currencyOrNull(
      typeof invoice.currency === 'string' ? invoice.currency : null,
    ),
    paymentIntentId: invoicePaymentIntentId(invoice),
    paid: invoicePaid(invoice),
  }
}

// Stripe removed the top-level boolean `paid` from Invoice in API version
// 2025-03-31.basil ("Removed the payment_intent, charge, paid, and
// paid_out_of_band fields from the Invoice object"). From Basil on, a settled
// invoice is `status: "paid"` instead. A webhook body is rendered at the API
// version pinned on the ENDPOINT -- never the SDK's -- so both spellings have to
// be accepted. Reading only the old one makes every Basil-rendered invoice look
// unpaid, which record_permit_payment rejects as INVOICE_NOT_PAID.
export function invoicePaid(invoice: Record<string, unknown>) {
  return invoice.paid === true || invoice.status === 'paid'
}

// The same Basil change moved the PaymentIntent id from a top-level
// `invoice.payment_intent` to an entry in the `payments` list, so read the new
// shape first and fall back to the old one. The two never coexist in one
// payload.
//
// Not `data[0]`: since Basil an invoice can carry several payments, only
// `payment_intent`-type ones have a PaymentIntent at all, and a cancelled or
// still-open attempt can sit ahead of the real one. Prefer the default payment
// Stripe creates at finalization -- the one that settles a single-price
// subscription invoice.
//
// Expect null often, and treat it as normal: `payments` is an EXPANDABLE field,
// and Stripe does not auto-expand anything in event bodies ("Objects sent in
// events are always in their minimal form"), so a Basil-rendered webhook can
// legitimately arrive with `data: []`. A null only costs refund/reconciliation
// linkage -- the column is nullable and idempotency keys off the invoice id.
export function invoicePaymentIntentId(invoice: Record<string, unknown>) {
  const data = objectOrNull(invoice.payments)?.data
  const entries = Array.isArray(data) ? data.map(objectOrNull) : []
  const candidates = entries.filter(
    (entry) => objectOrNull(entry?.payment)?.type === 'payment_intent',
  )
  const chosen =
    candidates.find((entry) => entry?.is_default === true) ??
    candidates.find((entry) => entry?.status === 'paid') ??
    candidates[0]

  const payment = objectOrNull(chosen?.payment)
  return stripeObjectId(payment?.payment_intent ?? invoice.payment_intent)
}
