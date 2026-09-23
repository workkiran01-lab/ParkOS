import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bookingPayment,
  searchCustomers,
  type Customer,
  type CustomerVehicle,
  type CustomerPayment,
} from './customer-queries.ts'

const customers: Customer[] = [
  {
    id: 'a',
    org_id: 'org',
    full_name: 'Dana Rivera',
    email: 'dana@example.test',
    phone: '562-555-0101',
    created_at: '',
  },
  {
    id: 'b',
    org_id: 'org',
    full_name: 'Sam Cho',
    email: null,
    phone: null,
    created_at: '',
  },
]
const vehicles: CustomerVehicle[] = [
  {
    id: 'v',
    org_id: 'org',
    customer_id: 'a',
    license_plate: '8ABC123',
    make: null,
    model: null,
    color: null,
    year: null,
  },
]
test('directory searches name, email, formatted phone and normalized plate', () => {
  for (const term of ['rivera', 'DANA@EXAMPLE', '5625550101', '8 abc-123'])
    assert.deepEqual(
      searchCustomers(customers, vehicles, term).map((customer) => customer.id),
      ['a'],
    )
  assert.deepEqual(searchCustomers(customers, vehicles, 'no match'), [])
  assert.equal(searchCustomers(customers, vehicles, '').length, 2)
})
test('pending attempts reserve collectable funds without being marked paid', () => {
  const rows = [
    { amount_cents: 300, status: 'succeeded' },
    { amount_cents: 200, status: 'succeeded' },
    { amount_cents: 900, status: 'refunded' },
    { amount_cents: 800, status: 'pending' },
  ] as CustomerPayment[]
  assert.deepEqual(bookingPayment(1000, rows), {
    paid: 500,
    pending: 800,
    needsReconciliation: false,
    due: 0,
    refunded: true,
  })
  assert.equal(bookingPayment(100, rows).due, 0)
})

test('partial refunds retain the unrefunded money; failures release commitments', () => {
  const partial = [
    { amount_cents: 1000, status: 'partially_refunded', refunded_cents: 200 },
  ] as CustomerPayment[]
  assert.equal(bookingPayment(1000, partial).paid, 800)
  assert.equal(bookingPayment(1000, partial).due, 200)
  const pending = [
    { amount_cents: 1000, status: 'pending' },
  ] as CustomerPayment[]
  assert.equal(bookingPayment(1000, pending).due, 0)
  assert.equal(
    bookingPayment(1000, [{ ...pending[0], status: 'failed' }]).due,
    1000,
  )
  assert.equal(
    bookingPayment(1000, [
      { ...partial[0], status: 'refunded', refunded_cents: 1000 },
    ]).due,
    1000,
  )
})

test('mixed ledgers and unknown historical refunds never manufacture collectable money', () => {
  const rows = [
    { amount_cents: 500, status: 'partially_refunded', refunded_cents: 100 },
    { amount_cents: 200, status: 'succeeded' },
    { amount_cents: 300, status: 'pending' },
  ] as CustomerPayment[]
  assert.deepEqual(bookingPayment(1000, rows), {
    paid: 600,
    pending: 300,
    due: 100,
    refunded: true,
    needsReconciliation: false,
  })
  const unknown = bookingPayment(1000, [
    { amount_cents: 1000, status: 'partially_refunded', refunded_cents: null },
  ] as CustomerPayment[])
  assert.equal(unknown.due, 0)
  assert.equal(unknown.needsReconciliation, true)
})
