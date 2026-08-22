import type Stripe from 'npm:stripe@^22'
import {
  ConfigurationError,
  errorResponse,
  isUuid,
  jsonResponse,
} from '../_shared/http.ts'
import {
  getStripeClient,
  getStripeWebhookSecret,
  stripeObjectId,
  Stripe as StripeRuntime,
} from '../_shared/stripe.ts'
import { getAdminClient } from '../_shared/supabase.ts'

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

function metadataUuid(value: string | undefined) {
  return isUuid(value ?? null) ? value : null
}

function integerOrNull(value: number | null | undefined) {
  return Number.isInteger(value) ? (value as number) : null
}

function currencyOrNull(value: string | null | undefined) {
  return value && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null
}
