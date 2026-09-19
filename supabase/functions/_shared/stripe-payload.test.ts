// Runnable check for the Stripe payload-reading invariant:
//   the fields ParkOS books money from are plucked correctly off a REAL
//   invoice.payment_succeeded body — in both API-version shapes.
// Run: node --test supabase/functions/_shared/stripe-payload.test.ts
//
// Why both shapes: a webhook body is rendered at the API version pinned on the
// ENDPOINT (or the account default), never at the SDK's version, and the payload
// is frozen at event creation. So a single deployment can receive either shape,
// and a replayed old event keeps its old shape forever.
//
// Field shapes below are taken from stripe@22.6.0's generated type definitions
// (cjs/resources/Invoices.d.ts, cjs/resources/InvoicePayments.d.ts) and Stripe's
// published sample payloads — not inferred from adjacent code.
import assert from 'node:assert/strict'
import {
  invoicePaid,
  invoicePaymentIntentId,
  normalizeInvoice,
} from './stripe-payload.ts'

const PERMIT_ID = '3f7c1e0a-2b4d-4c9e-8a1f-5d6e7b8c9a0b'

// ---------------------------------------------------------------------------
// A Basil-rendered (2025-03-31.basil and later) invoice.payment_succeeded body.
// Note what is NOT here: no top-level `paid`, no top-level `payment_intent`, no
// top-level `subscription`. All three were removed from Invoice in Basil.
// ---------------------------------------------------------------------------
const basilInvoice = {
  id: 'in_1QbasilExample',
  object: 'invoice',
  amount_due: 15000,
  amount_paid: 15000,
  amount_remaining: 0,
  currency: 'usd',
  status: 'paid',
  parent: {
    type: 'subscription_details',
    subscription_details: {
      subscription: 'sub_1QbasilExample',
      metadata: { permit_id: PERMIT_ID },
    },
  },
  payments: {
    object: 'list',
    has_more: false,
    total_count: 1,
    url: '/v1/invoice_payments',
    data: [
      {
        id: 'inpay_1QbasilExample',
        object: 'invoice_payment',
        amount_paid: 15000,
        amount_requested: 15000,
        currency: 'usd',
        invoice: 'in_1QbasilExample',
        is_default: true,
        status: 'paid',
        payment: {
          type: 'payment_intent',
          payment_intent: 'pi_1QbasilExample',
        },
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// A pre-Basil invoice body, which older endpoints still receive.
// ---------------------------------------------------------------------------
const legacyInvoice = {
  id: 'in_1QlegacyExample',
  object: 'invoice',
  amount_paid: 15000,
  currency: 'usd',
  paid: true,
  status: 'paid',
  subscription: 'sub_1QlegacyExample',
  payment_intent: 'pi_1QlegacyExample',
  lines: {
    object: 'list',
    data: [{ metadata: { permit_id: PERMIT_ID } }],
  },
  // Pre-Basil carried subscription metadata in the same place ParkOS reads it
  // once the subscription_details parent exists; older payloads simply lack it.
  parent: {
    subscription_details: {
      subscription: 'sub_1QlegacyExample',
      metadata: { permit_id: PERMIT_ID },
    },
  },
}

// --- Basil happy path -------------------------------------------------------
{
  const n = normalizeInvoice(basilInvoice)
  assert.equal(n.invoiceId, 'in_1QbasilExample')
  assert.equal(n.subscriptionId, 'sub_1QbasilExample')
  assert.equal(n.permitId, PERMIT_ID)
  assert.equal(n.amountPaidCents, 15000)
  assert.equal(
    n.currency,
    'USD',
    'currency is upper-cased from Stripe lowercase',
  )
  assert.equal(n.paymentIntentId, 'pi_1QbasilExample')
  assert.equal(n.paid, true)
}

// --- REGRESSION: Basil removed the top-level `paid` boolean -----------------
// This is the case that made the feature a no-op: reading only `invoice.paid`
// evaluates undefined -> false on every Basil-rendered payload, so
// record_permit_payment raises INVOICE_NOT_PAID, the handler 500s, and Stripe
// retries forever without ever booking the invoice.
{
  assert.equal(
    'paid' in basilInvoice,
    false,
    'fixture guard: a Basil invoice must not carry a top-level `paid`',
  )
  assert.equal(
    invoicePaid(basilInvoice),
    true,
    'a Basil invoice with status "paid" must read as paid',
  )
  assert.equal(normalizeInvoice(basilInvoice).paid, true)

  // ...and the old spelling still counts, for endpoints pinned pre-Basil.
  assert.equal(invoicePaid({ paid: true }), true)
  assert.equal(invoicePaid({ status: 'paid' }), true)

  // A genuinely unsettled invoice must still read as unpaid.
  assert.equal(invoicePaid({ status: 'open' }), false)
  assert.equal(invoicePaid({ paid: false, status: 'open' }), false)
  assert.equal(invoicePaid({}), false)
  assert.equal(invoicePaid({ status: 'draft' }), false)
  assert.equal(invoicePaid({ status: 'void' }), false)
  assert.equal(invoicePaid({ status: 'uncollectible' }), false)
}

// --- Legacy (pre-Basil) happy path ------------------------------------------
{
  const n = normalizeInvoice(legacyInvoice)
  assert.equal(n.invoiceId, 'in_1QlegacyExample')
  assert.equal(n.subscriptionId, 'sub_1QlegacyExample')
  assert.equal(n.permitId, PERMIT_ID)
  assert.equal(n.amountPaidCents, 15000)
  assert.equal(n.currency, 'USD')
  assert.equal(
    n.paymentIntentId,
    'pi_1QlegacyExample',
    'legacy top-level field',
  )
  assert.equal(n.paid, true)
}

// --- The expected webhook case: payments present but NOT expanded -----------
// `payments` is an expandable field and Stripe never auto-expands in event
// bodies, so an empty data list is normal. This must degrade to null, not throw.
{
  const unexpanded = {
    ...basilInvoice,
    payments: {
      object: 'list',
      data: [],
      has_more: false,
      total_count: 0,
      url: '/v1/invoice_payments',
    },
  }
  const n = normalizeInvoice(unexpanded)
  assert.equal(n.paymentIntentId, null, 'no payment intent, but no crash')
  // Everything the ledger actually needs still survives.
  assert.equal(n.invoiceId, 'in_1QbasilExample')
  assert.equal(n.amountPaidCents, 15000)
  assert.equal(n.paid, true)
}

// --- payments absent entirely ------------------------------------------------
{
  const noPayments: Record<string, unknown> = { ...basilInvoice }
  delete noPayments.payments
  const n = normalizeInvoice(noPayments)
  assert.equal(n.paymentIntentId, null)
  assert.equal(n.paid, true)
  assert.equal(n.amountPaidCents, 15000)
}

// --- Multiple payments: pick the default, not data[0] -----------------------
// Since Basil an invoice can carry several payments. A cancelled attempt and a
// non-PaymentIntent payment sit ahead of the real one here.
{
  const multi = {
    ...basilInvoice,
    payments: {
      object: 'list',
      data: [
        {
          is_default: false,
          status: 'canceled',
          payment: { type: 'payment_intent', payment_intent: 'pi_cancelled' },
        },
        {
          is_default: false,
          status: 'paid',
          payment: { type: 'charge', charge: 'ch_notapi' },
        },
        {
          is_default: true,
          status: 'paid',
          payment: { type: 'payment_intent', payment_intent: 'pi_thedefault' },
        },
      ],
    },
  }
  assert.equal(
    invoicePaymentIntentId(multi),
    'pi_thedefault',
    'must prefer the default payment over array order',
  )
}

// --- No default flagged: fall back to a paid payment_intent entry -----------
{
  const noDefault = {
    payments: {
      data: [
        {
          status: 'canceled',
          payment: { type: 'payment_intent', payment_intent: 'pi_dead' },
        },
        {
          status: 'paid',
          payment: { type: 'payment_intent', payment_intent: 'pi_live' },
        },
      ],
    },
  }
  assert.equal(invoicePaymentIntentId(noDefault), 'pi_live')
}

// --- Out-of-band / non-PaymentIntent payments have no PaymentIntent ---------
{
  const outOfBand = {
    payments: {
      data: [
        {
          is_default: true,
          status: 'paid',
          payment: { type: 'payment_record' },
        },
      ],
    },
  }
  assert.equal(invoicePaymentIntentId(outOfBand), null, 'null is correct here')

  const chargeOnly = {
    payments: {
      data: [
        {
          is_default: true,
          status: 'paid',
          payment: { type: 'charge', charge: 'ch_1' },
        },
      ],
    },
  }
  assert.equal(invoicePaymentIntentId(chargeOnly), null)
}

// --- A full OUT-OF-BAND invoice body (invoice.paid only) --------------------
// Marking an invoice paid_out_of_band "will result in no charge being made"
// (Stripe, Pay an invoice), so there is no PaymentIntent to record and no
// invoice.payment_succeeded is sent at all -- only invoice.paid. These bodies
// must still normalize into a complete, bookable ledger row.
{
  // Basil shape: settled via `status`, and the payments list carries a
  // non-PaymentIntent entry.
  const basilOutOfBand = {
    id: 'in_1QoobBasil',
    object: 'invoice',
    amount_due: 15000,
    amount_paid: 15000,
    amount_remaining: 0,
    currency: 'usd',
    status: 'paid',
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_1QoobBasil',
        metadata: { permit_id: PERMIT_ID },
      },
    },
    payments: {
      object: 'list',
      has_more: false,
      total_count: 1,
      url: '/v1/invoice_payments',
      data: [
        {
          id: 'inpay_1QoobBasil',
          object: 'invoice_payment',
          amount_paid: 15000,
          currency: 'usd',
          invoice: 'in_1QoobBasil',
          is_default: true,
          status: 'paid',
          payment: { type: 'payment_record', payment_record: 'payrec_1Qoob' },
        },
      ],
    },
  }
  assert.deepEqual(normalizeInvoice(basilOutOfBand), {
    permitId: PERMIT_ID,
    subscriptionId: 'sub_1QoobBasil',
    invoiceId: 'in_1QoobBasil',
    amountPaidCents: 15000,
    currency: 'USD',
    // The whole point: no charge was made, so this column is null and the
    // ledger row is still complete without it.
    paymentIntentId: null,
    paid: true,
  })

  // Pre-Basil shape: the retired `paid_out_of_band` boolean, `paid: true`, and
  // a null top-level payment_intent.
  const legacyOutOfBand = {
    id: 'in_1QoobLegacy',
    object: 'invoice',
    amount_paid: 15000,
    currency: 'usd',
    paid: true,
    paid_out_of_band: true,
    status: 'paid',
    subscription: 'sub_1QoobLegacy',
    payment_intent: null,
    parent: {
      subscription_details: {
        subscription: 'sub_1QoobLegacy',
        metadata: { permit_id: PERMIT_ID },
      },
    },
  }
  assert.deepEqual(normalizeInvoice(legacyOutOfBand), {
    permitId: PERMIT_ID,
    subscriptionId: 'sub_1QoobLegacy',
    invoiceId: 'in_1QoobLegacy',
    amountPaidCents: 15000,
    currency: 'USD',
    paymentIntentId: null,
    paid: true,
  })

  // Both must clear record_permit_payment's p_paid gate, or the money is
  // rejected as INVOICE_NOT_PAID exactly as the Basil bug did.
  assert.equal(invoicePaid(basilOutOfBand), true)
  assert.equal(invoicePaid(legacyOutOfBand), true)
}

// --- An expanded PaymentIntent object, not a bare id ------------------------
{
  const expanded = {
    payments: {
      data: [
        {
          is_default: true,
          payment: {
            type: 'payment_intent',
            payment_intent: { id: 'pi_expanded', object: 'payment_intent' },
          },
        },
      ],
    },
  }
  assert.equal(invoicePaymentIntentId(expanded), 'pi_expanded')
}

// --- Malformed payloads must degrade to null, never throw -------------------
// A throw here would escape into the handler's catch and 500, making Stripe
// retry a payload that will never parse.
{
  for (const junk of [
    {},
    { payments: null },
    { payments: 'nonsense' },
    { payments: 42 },
    { payments: { data: null } },
    { payments: { data: 'nonsense' } },
    { payments: { data: [null] } },
    { payments: { data: [{ payment: null }] } },
    { payments: { data: [{ payment: 5 }] } },
    { payments: { data: [{ payment: { type: 'payment_intent' } }] } },
    {
      payments: {
        data: [{ payment: { type: 'payment_intent', payment_intent: 42 } }],
      },
    },
    {
      payments: {
        data: [{ payment: { type: 'payment_intent', payment_intent: {} } }],
      },
    },
  ]) {
    assert.equal(
      invoicePaymentIntentId(junk as Record<string, unknown>),
      null,
      `expected null for ${JSON.stringify(junk)}`,
    )
  }

  // And the whole normalizer survives a payload with nothing usable in it.
  const n = normalizeInvoice({})
  assert.deepEqual(n, {
    permitId: null,
    subscriptionId: null,
    invoiceId: null,
    amountPaidCents: null,
    currency: null,
    paymentIntentId: null,
    paid: false,
  })
}

// --- Scalar coercions on the money fields -----------------------------------
{
  // A fully-discounted or credit-covered invoice settles at zero. Zero is a real
  // amount and must survive as 0, not collapse to null.
  const zero = normalizeInvoice({ ...basilInvoice, amount_paid: 0 })
  assert.equal(zero.amountPaidCents, 0)

  // Non-integer or missing amounts are rejected rather than rounded.
  assert.equal(normalizeInvoice({ amount_paid: 1.5 }).amountPaidCents, null)
  assert.equal(normalizeInvoice({ amount_paid: '15000' }).amountPaidCents, null)
  assert.equal(normalizeInvoice({}).amountPaidCents, null)

  // Currency must be three letters, upper-cased.
  assert.equal(normalizeInvoice({ currency: 'eur' }).currency, 'EUR')
  assert.equal(normalizeInvoice({ currency: 'dollars' }).currency, null)
  assert.equal(normalizeInvoice({ currency: '' }).currency, null)

  // A permit_id that is not a UUID is not a permit id.
  const badMeta = {
    parent: { subscription_details: { metadata: { permit_id: 'not-a-uuid' } } },
  }
  assert.equal(normalizeInvoice(badMeta).permitId, null)

  // Subscription may arrive as an expanded object rather than an id string.
  const expandedSub = {
    parent: { subscription_details: { subscription: { id: 'sub_expanded' } } },
  }
  assert.equal(normalizeInvoice(expandedSub).subscriptionId, 'sub_expanded')
}

console.log('stripe-payload: all assertions passed')
