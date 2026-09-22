import {
  ConfigurationError,
  errorResponse,
  jsonResponse,
} from '../_shared/http.ts'
import { normalizeInvoice, stripeObjectId } from '../_shared/stripe-payload.ts'
import { stripeEventRoute } from './route.ts'

type Row = Record<string, unknown>
type Dependencies = {
  verifyEvent: (body: string, signature: string) => Promise<unknown>
  rpc: (
    name: string,
    args: Row,
  ) => PromiseLike<{ data: unknown; error: unknown }>
  issueReceipt: (paymentId: string, reservationId: string) => Promise<unknown>
}

function object(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : null
}

function string(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function metadataId(value: unknown) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : null
}

function cents(value: unknown) {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2147483647
    ? value
    : null
}

function currency(value: unknown) {
  return typeof value === 'string' && /^[a-z]{3}$/i.test(value)
    ? value.toUpperCase()
    : null
}

function timestamp(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const malformed = () =>
  errorResponse('Unsupported Stripe event payload.', 400, false)
const ignored = () =>
  jsonResponse({ received: true, ignored: true }, 200, false)

// The same handler runs in Deno and in Node tests. Only signature verification,
// database I/O and receipt delivery are injected; routing and payload handling
// remain the production code under test.
export function createStripeWebhookHandler(deps: Dependencies) {
  async function call(name: string, args: Row): Promise<Row> {
    const { data, error } = await deps.rpc(name, args)
    const result = object(data)
    if (
      error ||
      !result ||
      typeof result.processed !== 'boolean' ||
      !string(result.outcome) ||
      result.outcome === 'ignored_event_type'
    ) {
      throw new Error('Stripe processing did not return a valid result.')
    }
    return result
  }

  const acknowledge = (result: Row) =>
    jsonResponse({ received: true, processed: result.processed }, 200, false)

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST')
      return errorResponse('Use POST for this endpoint.', 405, false)
    try {
      const signature = request.headers.get('Stripe-Signature')
      if (!signature)
        return errorResponse('Missing Stripe signature.', 400, false)
      const rawBody = await request.text()
      let verified: unknown
      try {
        verified = await deps.verifyEvent(rawBody, signature)
      } catch (error) {
        if (error instanceof ConfigurationError) throw error
        return errorResponse('Invalid Stripe signature.', 400, false)
      }
      const event = object(verified)
      const id = string(event?.id)
      const type = string(event?.type)
      if (!id || !type) return malformed()
      const route = stripeEventRoute(type)
      if (route === 'ignored') return ignored()
      const payload = object(object(event?.data)?.object)
      if (!payload || !string(payload.id)) return malformed()

      if (route === 'paid_invoice') {
        const invoice = normalizeInvoice(payload)
        // Account-wide invoice webhooks can legitimately concern another app.
        if (!invoice.permitId && !invoice.subscriptionId) return ignored()
        if (
          !invoice.paid ||
          cents(invoice.amountPaidCents) === null ||
          !invoice.currency
        )
          return malformed()
        return acknowledge(
          await call('record_permit_payment', {
            p_event_id: id,
            p_permit_id: invoice.permitId,
            p_stripe_subscription_id: invoice.subscriptionId,
            p_stripe_invoice_id: invoice.invoiceId,
            p_amount_cents: invoice.amountPaidCents,
            p_currency: invoice.currency,
            p_stripe_payment_intent_id: invoice.paymentIntentId,
            p_paid: invoice.paid,
          }),
        )
      }

      if (route === 'subscription') {
        let permitId: string | null
        let subscriptionId: string | null
        let status: string | null = null
        let start: string | null = null
        let end: string | null = null
        let reason: string | null = null
        if (type.startsWith('customer.subscription.')) {
          permitId = metadataId(object(payload.metadata)?.permit_id)
          subscriptionId = string(payload.id)
          status = string(payload.status)
          const items = object(payload.items)?.data
          if (!status || !Array.isArray(items) || !object(items[0]))
            return malformed()
          const item = object(items[0])!
          start = timestamp(item.current_period_start)
          end = timestamp(item.current_period_end)
          if (!start || !end || end <= start) return malformed()
          reason = string(object(payload.cancellation_details)?.comment)
        } else {
          const invoice = normalizeInvoice(payload)
          permitId = invoice.permitId
          subscriptionId = invoice.subscriptionId
        }
        if (!permitId && !subscriptionId) return malformed()
        return acknowledge(
          await call('process_stripe_subscription_event', {
            p_event_id: id,
            p_event_type: type,
            p_permit_id: permitId,
            p_stripe_subscription_id: subscriptionId,
            p_stripe_status: status,
            p_period_start: start,
            p_period_end: end,
            p_reason: reason,
          }),
        )
      }

      const checkout = type.startsWith('checkout.session.')
      const metadata = object(payload.metadata)
      const amount = cents(checkout ? payload.amount_total : payload.amount)
      const code = currency(payload.currency)
      const refunded =
        type === 'charge.refunded' ? cents(payload.amount_refunded) : null
      if (
        amount === null ||
        !code ||
        (type === 'charge.refunded' && refunded === null)
      )
        return malformed()
      const intent =
        type === 'payment_intent.payment_failed'
          ? string(payload.id)
          : stripeObjectId(payload.payment_intent)
      let result = await call('process_stripe_event', {
        p_event_id: id,
        p_event_type: type,
        p_payment_id: metadataId(metadata?.payment_id),
        p_reservation_id: metadataId(metadata?.reservation_id),
        p_checkout_session_id: checkout ? payload.id : null,
        p_payment_intent_id: intent,
        p_amount_cents: amount,
        p_currency: code,
        p_amount_refunded_cents: refunded,
      })
      if (result.outcome === 'payment_not_found') {
        if (type === 'charge.refunded') {
          result = await call('record_permit_refund', {
            p_event_id: id,
            p_stripe_payment_intent_id: intent,
            p_amount_cents: amount,
            p_amount_refunded_cents: refunded,
          })
        }
        if (result.processed === false && result.outcome !== 'duplicate_event')
          console.warn(`Stripe ${type}: ${result.outcome}`)
      }
      if (
        type === 'checkout.session.completed' &&
        result.processed === true &&
        result.payment_status === 'succeeded'
      ) {
        const paymentId = string(result.payment_id)
        const reservationId = string(result.reservation_id)
        if (paymentId && reservationId) {
          try {
            await deps.issueReceipt(paymentId, reservationId)
          } catch {
            console.error(
              'Receipt generation failed after a succeeded payment.',
            )
          }
        }
      }
      return acknowledge(result)
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
  }
}
