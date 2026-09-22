/** One dispatch decision shared by the handler and its SDK-free routing tests. */
export function stripeEventRoute(type: string) {
  switch (type) {
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return 'paid_invoice'
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'invoice.payment_failed':
      return 'subscription'
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
    case 'payment_intent.payment_failed':
    case 'charge.failed':
    case 'charge.refunded':
      return 'reservation'
    default:
      return 'ignored'
  }
}
