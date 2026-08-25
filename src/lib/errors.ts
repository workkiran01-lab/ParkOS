const ERROR_MESSAGES: Record<string, string> = {
  '23505': 'That record already exists.',
  '23P01': 'That space is no longer available for the selected time.',
  AUTH_REQUIRED: 'Your session has expired. Please sign in again.',
  NOT_AUTHORIZED: 'You do not have permission to do that.',
  ROLE_NOT_ALLOWED: 'Your role does not allow that action.',
  RESERVATION_NOT_FOUND: 'That reservation could not be found.',
  RESERVATION_NOT_PENDING: 'Only pending reservations can be paid.',
  PAYMENT_NOT_FOUND: 'That payment could not be found.',
  PAYMENT_NOT_REFUNDABLE: 'Only a succeeded payment can be refunded.',
  PAYMENT_ALREADY_SUCCEEDED: 'This reservation has already been paid.',
  PAYMENT_CONFIRMING: 'Payment was received and is still being confirmed.',
  PAYMENT_AMOUNT_INVALID: 'This reservation does not have a payable balance.',
  INVALID_REQUEST: 'The payment request was incomplete. Please try again.',
  INVALID_RETURN_ORIGIN: 'Checkout could not open from this page.',
  CHECKOUT_UNAVAILABLE:
    'Checkout is temporarily unavailable. Please try again.',
  REFUND_UNAVAILABLE: 'The refund could not be started. Please try again.',
  STRIPE_NOT_CONFIGURED: 'Payments are not configured yet.',
  SPACE_UNAVAILABLE: 'That space is no longer available for the selected time.',
  PERMIT_SUBSCRIPTION_ACTIVE:
    'You have an active permit subscription. Please cancel it before deactivating your account.',
}

type ErrorLike = {
  code?: unknown
  message?: unknown
}

function errorToken(error: unknown) {
  if (!error || typeof error !== 'object') return null
  const { code, message } = error as ErrorLike

  if (typeof code === 'string' && ERROR_MESSAGES[code]) return code
  if (typeof message !== 'string') return null

  return Object.keys(ERROR_MESSAGES).find(
    (candidate) => message === candidate || message.includes(candidate),
  )
}

/** Translate database and RPC failures without leaking raw backend messages. */
export function friendlyError(error: unknown, fallback: string) {
  const token = errorToken(error)
  return token ? ERROR_MESSAGES[token] : fallback
}

/** Edge Function failures carry their safe, user-facing payload on the response. */
export async function edgeFunctionError(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const payload = (await context.clone().json()) as ErrorLike
        const translated = friendlyError(payload, '')
        if (translated) return translated
        if (typeof payload.message === 'string' && payload.message.trim()) {
          return payload.message
        }
      } catch {
        // A malformed/non-JSON response is intentionally replaced by fallback.
      }
    }
  }

  return friendlyError(error, fallback)
}
