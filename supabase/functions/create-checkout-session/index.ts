import type Stripe from 'npm:stripe@22.6.0'
import { createClaimedCheckout } from './claim.ts'
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

    async function releasePayment(id: string) {
      const { error } = await adminClient
        .from('payments')
        .update({ status: 'failed' })
        .eq('id', id)
        .eq('status', 'pending')
      if (error) throw error
    }

    const existing = await findExistingCheckout(
      stripe,
      (pendingData ?? []) as PendingPayment[],
      reservation,
      successUrl,
      cancelUrl,
      releasePayment,
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
        'A payment attempt is still pending or needs reconciliation before another payment can start.',
        409,
      )
    }

    const { data: collectable, error: balanceError } = await userClient.rpc(
      'reservation_balance_cents',
      { p_reservation_id: reservation.id },
    )
    if (balanceError || !Number.isInteger(collectable) || collectable <= 0) {
      return errorResponse(
        'No collectable balance is available. A payment may be pending or need reconciliation.',
        409,
      )
    }
    const paymentId = crypto.randomUUID()
    const metadata = {
      payment_id: paymentId,
      reservation_id: reservation.id,
      org_id: reservation.org_id,
    }

    try {
      const url = await createClaimedCheckout({
        reserve: async () => {
          const { error } = await adminClient.from('payments').insert({
            id: paymentId,
            org_id: reservation.org_id,
            reservation_id: reservation.id,
            stripe_checkout_session_id: 'parkos_pending:' + paymentId,
            amount_cents: collectable,
            currency: reservation.currency.toUpperCase(),
            status: 'pending',
          })
          if (error) throw error
        },
        create: () =>
          stripe.checkout.sessions.create(
            {
              mode: 'payment',
              payment_method_types: ['card'],
              client_reference_id: reservation.id,
              line_items: [
                {
                  quantity: 1,
                  price_data: {
                    currency: reservation.currency.toLowerCase(),
                    unit_amount: collectable,
                    product_data: { name: 'ParkOS parking reservation' },
                  },
                },
              ],
              metadata,
              payment_intent_data: { metadata },
              success_url: successUrl,
              cancel_url: cancelUrl,
            },
            {
              idempotencyKey:
                'parkos-checkout:' + reservation.id + ':' + paymentId,
            },
          ),
        attach: async (id) => {
          const { error } = await adminClient
            .from('payments')
            .update({ stripe_checkout_session_id: id })
            .eq('id', paymentId)
          if (error) throw error
        },
        expire: (id) => expireSessionQuietly(stripe, id),
        release: () => releasePayment(paymentId),
      })
      return jsonResponse({ url, payment_id: paymentId, reused: false })
    } catch {
      console.error('Checkout reservation or creation failed.')
      return errorResponse(
        'Checkout could not open. Any unconfirmed payment attempt must finish or be reconciled before collecting again.',
        502,
      )
    }
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
  releasePayment: (id: string) => Promise<void>,
): Promise<ExistingCheckout> {
  for (const payment of pendingPayments) {
    if (
      !payment.stripe_checkout_session_id ||
      payment.stripe_checkout_session_id.startsWith('parkos_pending:')
    )
      return { kind: 'confirming' }

    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.retrieve(
        payment.stripe_checkout_session_id,
      )
    } catch {
      console.warn('A pending Checkout Session could not be inspected.')
      return { kind: 'confirming' }
    }

    const safeToReuse =
      payment.currency.toUpperCase() === reservation.currency.toUpperCase() &&
      session.mode === 'payment' &&
      session.amount_total === payment.amount_cents &&
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
    if (
      session.status === 'expired' ||
      (session.status === 'open' &&
        (await expireSessionQuietly(stripe, session.id)))
    ) {
      await releasePayment(payment.id)
    } else {
      return { kind: 'confirming' }
    }
  }

  return null
}

async function expireSessionQuietly(stripe: Stripe, sessionId: string) {
  try {
    const session = await stripe.checkout.sessions.expire(sessionId)
    return session.status === 'expired'
  } catch {
    console.warn('A Checkout Session could not be expired during cleanup.')
    return false
  }
}
