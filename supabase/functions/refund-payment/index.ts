import {
  AuthenticationError,
  ConfigurationError,
  errorResponse,
  isUuid,
  jsonResponse,
  optionsResponse,
  readJsonObject,
  readString,
} from '../_shared/http.ts'
import { getStripeClient } from '../_shared/stripe.ts'
import { invoicePaymentIntentId } from '../_shared/stripe-payload.ts'
import { getAdminClient, getAuthenticatedClients } from '../_shared/supabase.ts'

type RefundablePayment = {
  id: string
  org_id: string
  reservation_id: string
  status: string
  stripe_payment_intent_id: string | null
}

type RefundablePermitPayment = {
  id: string
  org_id: string
  permit_id: string
  status: string
  stripe_invoice_id: string
  stripe_payment_intent_id: string | null
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return optionsResponse()
  if (request.method !== 'POST')
    return errorResponse('Use POST for this endpoint.', 405)

  try {
    const body = await readJsonObject(request)
    if (!body) return errorResponse('Send a valid JSON request.', 400)

    const paymentId = readString(body.p_payment_id)
    const permitPaymentId = readString(body.p_permit_payment_id)

    // Exactly one. Both would be ambiguous about which money to move, and the
    // two paths refund different Stripe objects.
    if (paymentId !== null && permitPaymentId !== null)
      return errorResponse(
        'Refund a reservation payment or a permit payment, not both.',
        400,
      )
    if (paymentId === null && permitPaymentId === null)
      return errorResponse('Choose a payment to refund.', 400)

    const { userClient } = await getAuthenticatedClients(request)

    if (permitPaymentId !== null)
      return await refundPermitPayment(userClient, permitPaymentId)

    if (!isUuid(paymentId)) return errorResponse('Choose a valid payment.', 400)

    const { data: paymentData, error: paymentError } = await userClient
      .from('payments')
      .select('id, org_id, reservation_id, status, stripe_payment_intent_id')
      .eq('id', paymentId)
      .maybeSingle()

    if (paymentError) {
      console.error('Refund payment lookup failed.')
      return errorResponse('We could not verify this payment right now.', 500)
    }
    if (!paymentData)
      return errorResponse('Payment not found or unavailable.', 404)

    const payment = paymentData as RefundablePayment
    const allowed = await hasRefundRole(userClient, payment.org_id)
    if (allowed === null)
      return errorResponse(
        'We could not verify refund permissions right now.',
        500,
      )
    if (!allowed) {
      return errorResponse(
        'An administrator or manager is required to refund a payment.',
        403,
      )
    }
    if (payment.status !== 'succeeded') {
      return errorResponse(
        'Only a succeeded payment can be refunded here.',
        409,
      )
    }
    if (!payment.stripe_payment_intent_id) {
      return errorResponse('This payment is not ready for a refund.', 409)
    }

    const stripe = getStripeClient()
    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: payment.stripe_payment_intent_id,
          metadata: {
            payment_id: payment.id,
            reservation_id: payment.reservation_id,
            org_id: payment.org_id,
          },
        },
        { idempotencyKey: `parkos-refund:${payment.id}` },
      )

      return jsonResponse(
        {
          requested: true,
          refund_id: refund.id,
          message: 'Refund requested. Waiting for Stripe confirmation.',
        },
        202,
      )
    } catch {
      console.error('Stripe refund request failed.')
      return errorResponse(
        'Stripe could not accept the refund request. Please try again.',
        502,
      )
    }
  } catch (error) {
    if (error instanceof AuthenticationError)
      return errorResponse(error.message, 401)
    if (error instanceof ConfigurationError)
      return errorResponse(error.message, 503)
    console.error('Unexpected refund endpoint failure.')
    return errorResponse(
      'The refund could not be requested. Please try again.',
      500,
    )
  }
})

// admin/manager. Deliberately NOT attendant, which record_booth_payment does
// accept: whoever takes money must not be able to reverse it alone.
async function hasRefundRole(
  userClient: ReturnType<typeof getAdminClient>,
  orgId: string,
) {
  const { data, error } = await userClient.rpc('has_any_role', {
    check_org_id: orgId,
    allowed_roles: ['admin', 'manager'],
  })
  if (error) {
    console.error('Refund role verification failed.')
    return null
  }
  return data === true
}

// A permit refund moves money on the invoice's PaymentIntent and NOTHING else.
// It deliberately does not call invoices.voidInvoice or subscriptions.cancel:
// voiding rewrites history Stripe has already settled, and cancelling would end
// the customer's parking because one month was returned. The permit keeps
// billing; only this period's money goes back.
async function refundPermitPayment(
  userClient: ReturnType<typeof getAdminClient>,
  permitPaymentId: string,
) {
  if (!isUuid(permitPaymentId))
    return errorResponse('Choose a valid permit payment.', 400)

  const { data: rowData, error: rowError } = await userClient
    .from('permit_payments')
    .select(
      'id, org_id, permit_id, status, stripe_invoice_id, stripe_payment_intent_id',
    )
    .eq('id', permitPaymentId)
    .maybeSingle()

  if (rowError) {
    console.error('Refund permit payment lookup failed.')
    return errorResponse('We could not verify this payment right now.', 500)
  }
  if (!rowData)
    return errorResponse('Permit payment not found or unavailable.', 404)

  const payment = rowData as RefundablePermitPayment
  const allowed = await hasRefundRole(userClient, payment.org_id)
  if (allowed === null)
    return errorResponse(
      'We could not verify refund permissions right now.',
      500,
    )
  if (!allowed)
    return errorResponse(
      'An administrator or manager is required to refund a payment.',
      403,
    )
  if (payment.status !== 'succeeded')
    return errorResponse('Only a succeeded payment can be refunded here.', 409)

  const stripe = getStripeClient()

  // Expect the stored intent to be NULL and plan for it. Since Basil the
  // PaymentIntent lives in the invoice's `payments` list, which Stripe never
  // auto-expands in an event body ("Objects sent in events are always in their
  // minimal form"), so record_permit_payment usually had nothing to store. A
  // retrieve WITH the expansion is the only way to get it.
  let paymentIntentId = payment.stripe_payment_intent_id
  if (!paymentIntentId) {
    try {
      const invoice = await stripe.invoices.retrieve(
        payment.stripe_invoice_id,
        { expand: ['payments'] },
      )
      paymentIntentId = invoicePaymentIntentId(
        invoice as unknown as Record<string, unknown>,
      )
    } catch {
      console.error('Stripe invoice retrieve failed during a permit refund.')
      return errorResponse(
        'Stripe could not be reached for this invoice. Please try again.',
        502,
      )
    }
  }

  if (!paymentIntentId)
    return errorResponse('This payment is not ready for a refund.', 409)

  // Persist what was recovered BEFORE asking Stripe to refund. charge.refunded
  // carries the charge's metadata, not the refund's, so the webhook can only
  // resolve this row by PaymentIntent id -- if the refund succeeded and this
  // write had not happened yet, the confirmation would arrive unresolvable.
  if (!payment.stripe_payment_intent_id) {
    const { error: linkError } = await getAdminClient()
      .from('permit_payments')
      .update({ stripe_payment_intent_id: paymentIntentId })
      .eq('id', payment.id)
      .is('stripe_payment_intent_id', null)
    if (linkError) {
      console.error('Linking the recovered PaymentIntent failed.')
      return errorResponse(
        'The refund could not be prepared. Please try again.',
        500,
      )
    }
  }

  try {
    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        metadata: {
          permit_payment_id: payment.id,
          permit_id: payment.permit_id,
          org_id: payment.org_id,
        },
      },
      { idempotencyKey: `parkos-permit-refund:${payment.id}` },
    )

    return jsonResponse(
      {
        requested: true,
        refund_id: refund.id,
        message: 'Refund requested. Waiting for Stripe confirmation.',
      },
      202,
    )
  } catch {
    console.error('Stripe permit refund request failed.')
    return errorResponse(
      'Stripe could not accept the refund request. Please try again.',
      502,
    )
  }
}
