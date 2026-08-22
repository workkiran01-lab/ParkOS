import type Stripe from 'npm:stripe@^22'
import {
  AuthenticationError,
  ConfigurationError,
  errorResponse,
  isUuid,
  jsonResponse,
  optionsResponse,
  readJsonObject,
  readString,
  validateReturnOrigin,
} from '../_shared/http.ts'
import { getStripeClient } from '../_shared/stripe.ts'
import { getAuthenticatedClients } from '../_shared/supabase.ts'

type Reservation = {
  id: string
  org_id: string
  status: string
  total_cents: number
  currency: string
}

type PendingPayment = {
  id: string
  stripe_checkout_session_id: string
  amount_cents: number
  currency: string
}

type ExistingCheckout =
  | { kind: 'reusable'; url: string; paymentId: string }
  | { kind: 'confirming' }
  | null

const MAX_PENDING_ATTEMPTS_TO_INSPECT = 5

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return optionsResponse()
  if (request.method !== 'POST')
    return errorResponse('Use POST for this endpoint.', 405)

  try {
    const body = await readJsonObject(request)
    if (!body) return errorResponse('Send a valid JSON request.', 400)

    const reservationId = readString(body.reservation_id)
    if (!isUuid(reservationId))
      return errorResponse('Choose a valid reservation.', 400)

    const returnOrigin = validateReturnOrigin(
      body.return_origin,
      request.headers.get('Origin'),
    )
    if (!returnOrigin) {
      return errorResponse('The checkout return address is not allowed.', 400)
    }

    const { userClient, adminClient } = await getAuthenticatedClients(request)
    const { data: reservationData, error: reservationError } = await userClient
      .from('reservations')
      .select('id, org_id, status, total_cents, currency')
      .eq('id', reservationId)
      .maybeSingle()

    if (reservationError) {
      console.error('Checkout authorization query failed.')
      return errorResponse(
        'We could not verify this reservation right now.',
        500,
      )
    }
    if (!reservationData) {
      return errorResponse(
        'Reservation not found or unavailable to this account.',
        404,
      )
    }

    const reservation = reservationData as Reservation
    if (reservation.status !== 'pending') {
      return errorResponse('Only pending reservations can be paid.', 409)
    }
    if (
      !Number.isInteger(reservation.total_cents) ||
      reservation.total_cents <= 0
    ) {
      return errorResponse(
        'This reservation does not have a payable total.',
        422,
      )
    }
    if (!/^[A-Za-z]{3}$/.test(reservation.currency)) {
      return errorResponse('This reservation has an unsupported currency.', 422)
    }

    const successUrl =
      `${returnOrigin}/my/reservations?checkout=success` +
      `&reservation_id=${encodeURIComponent(reservation.id)}` +
      '&session_id={CHECKOUT_SESSION_ID}'
    const cancelUrl =
      `${returnOrigin}/my/reservations?checkout=cancelled` +
      `&reservation_id=${encodeURIComponent(reservation.id)}`
    const stripe = getStripeClient()

    const { data: pendingData, error: pendingError } = await userClient
      .from('payments')
      .select('id, stripe_checkout_session_id, amount_cents, currency')
      .eq('reservation_id', reservation.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(MAX_PENDING_ATTEMPTS_TO_INSPECT)

    if (pendingError) {
      console.error('Pending checkout lookup failed.')
      return errorResponse(
        'We could not check the current payment attempt.',
        500,
      )
    }

    const existing = await findExistingCheckout(
      stripe,
      (pendingData ?? []) as PendingPayment[],
      reservation,
      successUrl,
      cancelUrl,
    )
    if (existing?.kind === 'reusable') {
      return jsonResponse({
        url: existing.url,
        payment_id: existing.paymentId,
        reused: true,
      })
    }
    if (existing?.kind === 'confirming') {
      return errorResponse(
        'Payment was received and is still being confirmed.',
        409,
      )
    }

    const paymentId = crypto.randomUUID()
    const metadata = {
      payment_id: paymentId,
      reservation_id: reservation.id,
      org_id: reservation.org_id,
    }

    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          payment_method_types: ['card'],
          client_reference_id: reservation.id,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: reservation.currency.toLowerCase(),
                unit_amount: reservation.total_cents,
                product_data: { name: 'ParkOS parking reservation' },
              },
            },
          ],
          metadata,
          payment_intent_data: { metadata },
          success_url: successUrl,
          cancel_url: cancelUrl,
        },
        { idempotencyKey: `parkos-checkout:${reservation.id}:${paymentId}` },
      )
    } catch {
      console.error('Stripe Checkout Session creation failed.')
      return errorResponse(
        'Secure checkout is temporarily unavailable. Please try again.',
        502,
      )
    }

    if (!session.url) {
      await expireSessionQuietly(stripe, session.id)
      return errorResponse(
        'Secure checkout did not return a redirect address.',
        502,
      )
    }

    const { error: insertError } = await adminClient.from('payments').insert({
      id: paymentId,
      org_id: reservation.org_id,
      reservation_id: reservation.id,
      stripe_checkout_session_id: session.id,
      amount_cents: reservation.total_cents,
      currency: reservation.currency.toUpperCase(),
      status: 'pending',
    })

    if (insertError) {
      console.error(
        'Pending payment insert failed; expiring its Checkout Session.',
      )
      await expireSessionQuietly(stripe, session.id)
      return errorResponse(
        'Checkout could not be saved. Please try again.',
        500,
      )
    }

    return jsonResponse({
      url: session.url,
      payment_id: paymentId,
      reused: false,
    })
  } catch (error) {
    if (error instanceof AuthenticationError)
      return errorResponse(error.message, 401)
    if (error instanceof ConfigurationError)
      return errorResponse(error.message, 503)
    console.error('Unexpected checkout endpoint failure.')
    return errorResponse(
      'Checkout could not be started. Please try again.',
      500,
    )
  }
})

async function findExistingCheckout(
  stripe: Stripe,
  pendingPayments: PendingPayment[],
  reservation: Reservation,
  successUrl: string,
  cancelUrl: string,
): Promise<ExistingCheckout> {
  for (const payment of pendingPayments) {
    if (!payment.stripe_checkout_session_id) continue

    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.retrieve(
        payment.stripe_checkout_session_id,
      )
    } catch {
      console.warn('A pending Checkout Session could not be inspected.')
      continue
    }

    const safeToReuse =
      payment.amount_cents === reservation.total_cents &&
      payment.currency.toUpperCase() === reservation.currency.toUpperCase() &&
      session.mode === 'payment' &&
      session.amount_total === reservation.total_cents &&
      session.currency?.toUpperCase() === reservation.currency.toUpperCase() &&
      session.client_reference_id === reservation.id &&
      session.metadata?.payment_id === payment.id &&
      session.metadata?.reservation_id === reservation.id &&
      session.metadata?.org_id === reservation.org_id &&
      session.success_url === successUrl &&
      session.cancel_url === cancelUrl

    if (safeToReuse && session.status === 'open' && session.url) {
      return { kind: 'reusable', url: session.url, paymentId: payment.id }
    }
    if (safeToReuse && session.status === 'complete')
      return { kind: 'confirming' }
    if (session.status === 'open')
      await expireSessionQuietly(stripe, session.id)
  }

  return null
}

async function expireSessionQuietly(stripe: Stripe, sessionId: string) {
  try {
    await stripe.checkout.sessions.expire(sessionId)
  } catch {
    console.warn('A Checkout Session could not be expired during cleanup.')
  }
}
