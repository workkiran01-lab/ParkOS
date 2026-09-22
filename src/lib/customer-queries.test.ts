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
test('book payment includes both successful ledgers and excludes refunds and pending attempts', () => {
  const rows = [
    { amount_cents: 300, status: 'succeeded' },
    { amount_cents: 200, status: 'succeeded' },
    { amount_cents: 900, status: 'refunded' },
    { amount_cents: 800, status: 'pending' },
  ] as CustomerPayment[]
  assert.deepEqual(bookingPayment(1000, rows), {
    paid: 500,
    due: 500,
    refunded: true,
  })
  assert.equal(bookingPayment(100, rows).due, 0)
})
