import assert from 'node:assert/strict'
import test from 'node:test'
import Stripe from 'stripe'
import { ConfigurationError } from '../_shared/http.ts'
import { createStripeWebhookHandler } from './handler.ts'

const stripe = new Stripe('sk_test_local_signature_only')
const secret = 'whsec_local_signature_only'
const permitId = '11111111-1111-4111-8111-111111111111'
const paymentId = '22222222-2222-4222-8222-222222222222'
const reservationId = '33333333-3333-4333-8333-333333333333'
const invoice = {
  id: 'in_test',
  status: 'paid',
  amount_paid: 15000,
  currency: 'usd',
  parent: {
    subscription_details: {
      subscription: 'sub_test',
      metadata: { permit_id: permitId },
    },
  },
  payments: {
    data: [
      {
        is_default: true,
        status: 'paid',
        payment: { type: 'payment_intent', payment_intent: 'pi_test' },
      },
    ],
  },
}
const subscription = {
  id: 'sub_test',
  status: 'active',
  metadata: { permit_id: permitId },
  items: {
    data: [
      { current_period_start: 1787529600, current_period_end: 1790208000 },
    ],
  },
}
const payment = {
  id: 'cs_test',
  amount_total: 15000,
  amount: 15000,
  amount_refunded: 15000,
  currency: 'usd',
  payment_intent: 'pi_test',
  metadata: { payment_id: paymentId, reservation_id: reservationId },
}

function event(type: string, payload: unknown) {
  return { id: 'evt_local', type, data: { object: payload } }
}

function harness(
  results: unknown[] = [{ processed: true, outcome: 'applied' }],
) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const receipts: string[][] = []
  const handler = createStripeWebhookHandler({
    verifyEvent: (body, signature) =>
      stripe.webhooks.constructEventAsync(body, signature, secret),
    rpc: async (name, args) => {
      calls.push({ name, args })
      return { data: results.shift(), error: null }
    },
    issueReceipt: async (...ids) => {
      receipts.push(ids)
    },
  })
  async function send(value: unknown, tamper = false) {
    const body = JSON.stringify(value)
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret,
    })
    return handler(
      new Request('http://localhost/stripe-webhook', {
        method: 'POST',
        headers: { 'Stripe-Signature': signature },
        body: tamper ? body + ' ' : body,
      }),
    )
  }
  return { send, handler, calls, receipts }
}

test('Basil paid invoice events reach the money recorder with independently specified scalars', async () => {
  assert.equal('paid' in invoice, false)
  for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
    const h = harness()
    const response = await h.send(event(type, invoice))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { received: true, processed: true })
    assert.deepEqual(h.calls, [
      {
        name: 'record_permit_payment',
        args: {
          p_event_id: 'evt_local',
          p_permit_id: permitId,
          p_stripe_subscription_id: 'sub_test',
          p_stripe_invoice_id: 'in_test',
          p_amount_cents: 15000,
          p_currency: 'USD',
          p_stripe_payment_intent_id: 'pi_test',
          p_paid: true,
        },
      },
    ])
    console.log(
      `${type}: record_permit_payment, 15000 USD, paid=true; no legacy paid property`,
    )
  }
})

test('all four subscription event routes reach the state processor', async () => {
  for (const type of [
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_failed',
  ]) {
    const failed = type === 'invoice.payment_failed'
    const h = harness()
    assert.equal(
      (await h.send(event(type, failed ? invoice : subscription))).status,
      200,
    )
    assert.deepEqual(h.calls, [
      {
        name: 'process_stripe_subscription_event',
        args: {
          p_event_id: 'evt_local',
          p_event_type: type,
          p_permit_id: permitId,
          p_stripe_subscription_id: 'sub_test',
          p_stripe_status: failed ? null : 'active',
          p_period_start: failed ? null : '2026-08-24T00:00:00.000Z',
          p_period_end: failed ? null : '2026-09-24T00:00:00.000Z',
          p_reason: null,
        },
      },
    ])
  }
})

test('all six reservation event routes reach the reservation processor', async () => {
  for (const type of [
    'checkout.session.completed',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
    'payment_intent.payment_failed',
    'charge.failed',
    'charge.refunded',
  ]) {
    const checkout = type.startsWith('checkout.')
    const intent = type.startsWith('payment_intent.')
    const h = harness()
    assert.equal(
      (
        await h.send(
          event(type, {
            ...payment,
            id: checkout ? 'cs_test' : intent ? 'pi_test' : 'ch_test',
          }),
        )
      ).status,
      200,
    )
    assert.deepEqual(h.calls, [
      {
        name: 'process_stripe_event',
        args: {
          p_event_id: 'evt_local',
          p_event_type: type,
          p_payment_id: paymentId,
          p_reservation_id: reservationId,
          p_checkout_session_id: checkout ? 'cs_test' : null,
          p_payment_intent_id: 'pi_test',
          p_amount_cents: 15000,
          p_currency: 'USD',
          p_amount_refunded_cents: type === 'charge.refunded' ? 15000 : null,
        },
      },
    ])
  }
})

test('unknown events and unrelated invoices are ignored without database calls', async () => {
  for (const value of [
    event('product.created', {}),
    event('invoice.paid', { id: 'in_other', status: 'paid' }),
  ]) {
    const h = harness()
    const response = await h.send(value)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { received: true, ignored: true })
    assert.deepEqual(h.calls, [])
  }
})

test('malformed supported payloads return 400 before any database call', async () => {
  const malformed = [
    null,
    {},
    { id: 'evt_local', type: 'invoice.paid' },
    event('invoice.paid', null),
    event('invoice.paid', []),
    event('invoice.paid', {}),
    event('invoice.paid', { ...invoice, amount_paid: '15000' }),
    event('invoice.paid', { ...invoice, status: 'open' }),
    event('customer.subscription.updated', { ...subscription, items: null }),
    event('customer.subscription.updated', {
      ...subscription,
      items: { data: [null] },
    }),
    event('customer.subscription.updated', {
      ...subscription,
      items: {
        data: [{ current_period_start: 1e15, current_period_end: 1e16 }],
      },
    }),
    event('charge.refunded', { ...payment, amount_refunded: '15000' }),
    event('payment_intent.payment_failed', { id: 'pi_test' }),
  ]
  for (const value of malformed) {
    const h = harness()
    assert.equal((await h.send(value)).status, 400, JSON.stringify(value))
    assert.deepEqual(h.calls, [])
  }
  console.log(
    `MALFORMED: ${malformed.length} signed payloads rejected with 400 and zero writes`,
  )
})

test('missing metadata does not crash a valid reservation event', async () => {
  const h = harness()
  assert.equal(
    (await h.send(event('charge.failed', { ...payment, metadata: undefined })))
      .status,
    200,
  )
  assert.equal(h.calls[0].args.p_payment_id, null)
})

test('invalid signatures and non-POST requests cannot call the database', async () => {
  const h = harness()
  assert.equal((await h.send(event('invoice.paid', invoice), true)).status, 400)
  assert.equal(
    (await h.handler(new Request('http://localhost', { method: 'POST' })))
      .status,
    400,
  )
  assert.equal((await h.handler(new Request('http://localhost'))).status, 405)
  assert.deepEqual(h.calls, [])
})

test('empty, malformed and ignored RPC results never acknowledge successful processing', async () => {
  for (const value of [
    event('invoice.paid', invoice),
    event('customer.subscription.updated', subscription),
    event('checkout.session.completed', payment),
  ]) {
    for (const result of [
      null,
      {},
      [],
      { processed: true },
      { processed: true, outcome: 'ignored_event_type' },
    ]) {
      const h = harness([result])
      assert.equal((await h.send(value)).status, 500)
    }
  }
})

test('configuration and database failures remain retryable', async () => {
  for (const stage of ['configuration', 'database']) {
    const handler = createStripeWebhookHandler({
      verifyEvent: async () => {
        if (stage === 'configuration')
          throw new ConfigurationError('Missing local test configuration')
        return event('invoice.paid', invoice)
      },
      rpc: async () => ({ data: null, error: { message: 'unavailable' } }),
      issueReceipt: async () => {},
    })
    const response = await handler(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Stripe-Signature': 'local' },
        body: '{}',
      }),
    )
    assert.equal(response.status, stage === 'configuration' ? 503 : 500)
  }
})

test('unresolved refunds hand off to the permit ledger with the same event ID', async () => {
  const h = harness([
    { processed: false, outcome: 'payment_not_found' },
    { processed: true, outcome: 'permit_payment_refunded' },
  ])
  assert.equal((await h.send(event('charge.refunded', payment))).status, 200)
  assert.deepEqual(h.calls[1], {
    name: 'record_permit_refund',
    args: {
      p_event_id: 'evt_local',
      p_stripe_payment_intent_id: 'pi_test',
      p_amount_cents: 15000,
      p_amount_refunded_cents: 15000,
    },
  })
})

test('a newly settled reservation issues its receipt after processing', async () => {
  const h = harness([
    {
      processed: true,
      outcome: 'payment_succeeded',
      payment_status: 'succeeded',
      payment_id: paymentId,
      reservation_id: reservationId,
    },
  ])
  assert.equal(
    (await h.send(event('checkout.session.completed', payment))).status,
    200,
  )
  assert.deepEqual(h.receipts, [[paymentId, reservationId]])
})
