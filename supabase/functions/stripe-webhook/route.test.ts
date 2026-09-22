import assert from 'node:assert/strict'
import test from 'node:test'
import { stripeEventRoute } from './route.ts'

test('every supported Stripe event has one explicit destination', () => {
  // Independent contract table: do not derive expectations from the dispatcher.
  const expected = {
    'invoice.paid': 'paid_invoice',
    'invoice.payment_succeeded': 'paid_invoice',
    'customer.subscription.created': 'subscription',
    'customer.subscription.updated': 'subscription',
    'customer.subscription.deleted': 'subscription',
    'invoice.payment_failed': 'subscription',
    'checkout.session.completed': 'reservation',
    'checkout.session.async_payment_failed': 'reservation',
    'checkout.session.expired': 'reservation',
    'payment_intent.payment_failed': 'reservation',
    'charge.failed': 'reservation',
    'charge.refunded': 'reservation',
  }
  for (const [type, route] of Object.entries(expected))
    assert.equal(stripeEventRoute(type), route, type)
  assert.equal(stripeEventRoute('product.created'), 'ignored')
  assert.equal(stripeEventRoute(''), 'ignored')
  console.log(
    'ROUTING: 12 explicit event destinations and 2 ignored types verified',
  )
})
