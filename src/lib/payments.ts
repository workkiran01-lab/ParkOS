export type PaymentStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'

export type PaymentSummary = {
  id: string
  reservation_id: string
  stripe_checkout_session_id: string
  amount_cents: number
  currency: string
  status: PaymentStatus
  created_at: string
}

const PAYMENT_PRIORITY: Record<PaymentStatus, number> = {
  refunded: 4,
  partially_refunded: 4,
  succeeded: 4,
  pending: 2,
  failed: 1,
}

/**
 * Rows arrive newest-first. Prefer a settled charge over a later incomplete
 * attempt so the UI never hides money that was actually collected.
 */
export function paymentsByReservation(rows: PaymentSummary[]) {
  const result = new Map<string, PaymentSummary>()

  for (const payment of rows) {
    const current = result.get(payment.reservation_id)
    if (
      !current ||
      PAYMENT_PRIORITY[payment.status] > PAYMENT_PRIORITY[current.status]
    ) {
      result.set(payment.reservation_id, payment)
    }
  }

  return result
}

export function paymentStatusLabel(status: PaymentStatus) {
  switch (status) {
    case 'pending':
      return 'Payment pending'
    case 'succeeded':
      return 'Paid'
    case 'failed':
      return 'Payment failed'
    case 'refunded':
      return 'Refunded'
    case 'partially_refunded':
      return 'Partially refunded'
  }
}
