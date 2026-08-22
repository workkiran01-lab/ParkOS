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
import { getAuthenticatedClients } from '../_shared/supabase.ts'

type RefundablePayment = {
  id: string
  org_id: string
  reservation_id: string
  status: string
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
    if (!isUuid(paymentId)) return errorResponse('Choose a valid payment.', 400)

    const { userClient } = await getAuthenticatedClients(request)
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
    const { data: roleAllowed, error: roleError } = await userClient.rpc(
      'has_any_role',
      {
        check_org_id: payment.org_id,
        allowed_roles: ['admin', 'manager'],
      },
    )

    if (roleError) {
      console.error('Refund role verification failed.')
      return errorResponse(
        'We could not verify refund permissions right now.',
        500,
      )
    }
    if (roleAllowed !== true) {
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
