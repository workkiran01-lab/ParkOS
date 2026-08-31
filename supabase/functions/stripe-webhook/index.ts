import type Stripe from 'npm:stripe@22.6.0'
import {
  ConfigurationError,
  errorResponse,
  jsonResponse,
} from '../_shared/http.ts'
import {
  getStripeClient,
  getStripeWebhookSecret,
  Stripe as StripeRuntime,
} from '../_shared/stripe.ts'
// Payload reading lives in a Stripe-SDK-free module so it can be unit-tested
// under node; see stripe-payload.test.ts.
import {
  currencyOrNull,
  integerOrNull,
  metadataUuid,
  normalizeInvoice,
  stripeObjectId,
  unixTimestamp,
} from '../_shared/stripe-payload.ts'
import { getAdminClient } from '../_shared/supabase.ts'
import { issueReceiptForPayment } from '../_shared/receipt.ts'

type NormalizedStripeEvent = {
  eventType: string
  paymentId: string | null
  reservationId: string | null
  checkoutSessionId: string | null
  paymentIntentId: string | null
  amountCents: number | null
  currency: string | null
  amountRefundedCents: number | null
}

const handledEventTypes = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.payment_failed',
  'charge.failed',
  'charge.refunded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
  // The superset of payment_succeeded: it ALSO fires when an invoice is marked
  // paid out-of-band, which payment_succeeded never reports. Without it, money
  // collected outside Stripe was booked nowhere and raised no error.
  'invoice.paid',
])

const cryptoProvider = StripeRuntime.createSubtleCryptoProvider()

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return errorResponse('Use POST for this endpoint.', 405, false)
  }

  try {
    const signature = request.headers.get('Stripe-Signature')
    if (!signature)
      return errorResponse('Missing Stripe signature.', 400, false)

    // Signature verification must receive Stripe's untouched UTF-8 payload.
    const rawBody = await request.text()
    let event: Stripe.Event
    try {
      event = await getStripeClient().webhooks.constructEventAsync(
        rawBody,
        signature,
        getStripeWebhookSecret(),
        undefined,
        cryptoProvider,
      )
    } catch {
      console.warn('Stripe webhook signature verification failed.')
      return errorResponse('Invalid Stripe signature.', 400, false)
    }

    if (!handledEventTypes.has(event.type)) {
      return jsonResponse({ received: true, ignored: true }, 200, false)
    }

    // A settled subscription invoice is the only event that books permit money,
    // so it goes to its own recorder rather than the permit STATE processor.
    //
    // BOTH events route here, and a normal payment therefore arrives TWICE --
    // Stripe sends invoice.paid and invoice.payment_succeeded for every
    // successful payment, carrying identical invoice data under DIFFERENT event
    // ids. The processed_stripe_events claim does not collapse them; unique
    // permit_payments.stripe_invoice_id does, so the second delivery returns
    // duplicate_invoice and writes neither a payment row nor an audit row.
    //
    // Stripe recommends listening to invoice.paid INSTEAD of
    // payment_succeeded. Deliberately not done: nothing in this repository can
    // see which events the Dashboard endpoint actually subscribes to, and
    // dropping payment_succeeded against an endpoint that does not send
    // invoice.paid would silently stop all permit revenue -- the same failure
    // shape being fixed here. Subscribing to both degrades safely instead.
    if (
      event.type === 'invoice.payment_succeeded' ||
      event.type === 'invoice.paid'
    ) {
      return await processPaidInvoice(event)
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted' ||
      event.type === 'invoice.payment_failed'
    ) {
      return await processSubscriptionEvent(event)
    }

    const normalized = normalizeEvent(event)
    if (!normalized) {
      console.error('A supported Stripe event had an unexpected payload shape.')
      return errorResponse('Unsupported Stripe event payload.', 400, false)
    }

    const { data, error } = await getAdminClient().rpc('process_stripe_event', {
      p_event_id: event.id,
      p_event_type: normalized.eventType,
      p_payment_id: normalized.paymentId,
      p_reservation_id: normalized.reservationId,
      p_checkout_session_id: normalized.checkoutSessionId,
      p_payment_intent_id: normalized.paymentIntentId,
      p_amount_cents: normalized.amountCents,
      p_currency: normalized.currency,
      p_amount_refunded_cents: normalized.amountRefundedCents,
    })

    if (error) {
      console.error(
        'Atomic Stripe event processing failed; Stripe should retry.',
      )
      return errorResponse(
        'Payment event processing is temporarily unavailable.',
        500,
        false,
      )
    }

    const result = data && typeof data === 'object' ? data : null

    // A newly-succeeded reservation payment gets an itemized receipt. Best-effort
    // and after the payment is committed: a receipt failure must not 500 (Stripe
    // would retry the already-settled payment). issueReceiptForPayment is
    // idempotent on payment_id, so this fires at most once per payment.
    if (
      normalized.eventType === 'checkout.session.completed' &&
      result &&
      (result as Record<string, unknown>).processed === true &&
      (result as Record<string, unknown>).payment_status === 'succeeded'
    ) {
      const paymentId = (result as Record<string, unknown>).payment_id
      const reservationId = (result as Record<string, unknown>).reservation_id
      if (typeof paymentId === 'string' && typeof reservationId === 'string') {
        try {
          await issueReceiptForPayment(getAdminClient(), {
            paymentId,
            reservationId,
          })
        } catch {
          console.error('Receipt generation failed after a succeeded payment.')
        }
      }
    }

    return jsonResponse(
      {
        received: true,
        processed:
          result && 'processed' in result ? result.processed === true : true,
      },
      200,
      false,
    )
  } catch (error) {
    if (error instanceof ConfigurationError)
      return errorResponse(error.message, 503, false)
    console.error('Unexpected Stripe webhook failure; Stripe should retry.')
    return errorResponse(
      'Payment event processing is temporarily unavailable.',
      500,
      false,
    )
  }
})

async function processSubscriptionEvent(event: Stripe.Event) {
  let permitId: string | null
  let subscriptionId: string | null
  let stripeStatus: string | null = null
  let periodStart: string | null = null
  let periodEnd: string | null = null
  let reason: string | null = null

  if (event.type.startsWith('customer.subscription.')) {
    const subscription = event.data.object as Stripe.Subscription
    const item = subscription.items.data[0]
    permitId = metadataUuid(subscription.metadata.permit_id)
    subscriptionId = subscription.id
    stripeStatus = subscription.status
    periodStart = unixTimestamp(item?.current_period_start)
    periodEnd = unixTimestamp(item?.current_period_end)
    reason = subscription.cancellation_details?.comment ?? null
  } else {
    const invoice = normalizeInvoice(
      event.data.object as unknown as Record<string, unknown>,
    )
    subscriptionId = invoice.subscriptionId
    permitId = invoice.permitId
  }

  if (!permitId && !subscriptionId) {
    console.error('A subscription event had no ParkOS permit identifier.')
    return errorResponse('Unsupported Stripe subscription payload.', 400, false)
  }

  const { data, error } = await getAdminClient().rpc(
    'process_stripe_subscription_event',
    {
      p_event_id: event.id,
      p_event_type: event.type,
      p_permit_id: permitId,
      p_stripe_subscription_id: subscriptionId,
      p_stripe_status: stripeStatus,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_reason: reason,
    },
  )
  if (error) {
    console.error(
      'Atomic Stripe subscription processing failed; Stripe should retry.',
    )
    return errorResponse(
      'Subscription event processing is temporarily unavailable.',
      500,
      false,
    )
  }
  const result = data && typeof data === 'object' ? data : null
  return jsonResponse(
    {
      received: true,
      processed:
        result && 'processed' in result ? result.processed === true : true,
    },
    200,
    false,
  )
}

async function processPaidInvoice(event: Stripe.Event) {
  const invoice = normalizeInvoice(
    event.data.object as unknown as Record<string, unknown>,
  )

  // Deliberately NOT the 400 its sibling returns for a missing identifier. This
  // endpoint receives every paid invoice on the Stripe account, and an invoice
  // with no ParkOS subscription behind it is not a malformed payload -- it is
  // simply not ours. A 400 here would make Stripe retry, and then alert, on
  // somebody else's invoice.
  if (!invoice.permitId && !invoice.subscriptionId) {
    return jsonResponse({ received: true, ignored: true }, 200, false)
  }
  if (!invoice.invoiceId) {
    console.error('A paid Stripe invoice arrived with no invoice id.')
    return errorResponse('Unsupported Stripe invoice payload.', 400, false)
  }

  const { data, error } = await getAdminClient().rpc('record_permit_payment', {
    p_event_id: event.id,
    p_permit_id: invoice.permitId,
    p_stripe_subscription_id: invoice.subscriptionId,
    p_stripe_invoice_id: invoice.invoiceId,
    p_amount_cents: invoice.amountPaidCents,
    p_currency: invoice.currency,
    p_stripe_payment_intent_id: invoice.paymentIntentId,
    p_paid: invoice.paid,
  })

  if (error) {
    console.error('Permit payment recording failed; Stripe should retry.')
    return errorResponse(
      'Payment event processing is temporarily unavailable.',
      500,
      false,
    )
  }
  const result = data && typeof data === 'object' ? data : null
  return jsonResponse(
    {
      received: true,
      processed:
        result && 'processed' in result ? result.processed === true : true,
    },
    200,
    false,
  )
}

function normalizeEvent(event: Stripe.Event): NormalizedStripeEvent | null {
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_failed' ||
    event.type === 'checkout.session.expired'
  ) {
    const session = event.data.object as Stripe.Checkout.Session
    return {
      eventType: event.type,
      paymentId: metadataUuid(session.metadata?.payment_id),
      reservationId: metadataUuid(session.metadata?.reservation_id),
      checkoutSessionId: session.id,
      paymentIntentId: stripeObjectId(session.payment_intent),
      amountCents: integerOrNull(session.amount_total),
      currency: currencyOrNull(session.currency),
      amountRefundedCents: null,
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object as Stripe.PaymentIntent
    return {
      eventType: event.type,
      paymentId: metadataUuid(intent.metadata.payment_id),
      reservationId: metadataUuid(intent.metadata.reservation_id),
      checkoutSessionId: null,
      paymentIntentId: intent.id,
      amountCents: integerOrNull(intent.amount),
      currency: currencyOrNull(intent.currency),
      amountRefundedCents: null,
    }
  }

  if (event.type === 'charge.failed' || event.type === 'charge.refunded') {
    const charge = event.data.object as Stripe.Charge
    return {
      eventType: event.type,
      paymentId: metadataUuid(charge.metadata.payment_id),
      reservationId: metadataUuid(charge.metadata.reservation_id),
      checkoutSessionId: null,
      paymentIntentId: stripeObjectId(charge.payment_intent),
      amountCents: integerOrNull(charge.amount),
      currency: currencyOrNull(charge.currency),
      amountRefundedCents:
        event.type === 'charge.refunded'
          ? integerOrNull(charge.amount_refunded)
          : null,
    }
  }

  return null
}
