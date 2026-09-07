import assert from 'node:assert/strict'
import {
  normalizePlate,
  validateNewCustomer,
  validatePlate,
} from './booking-validation.ts'

assert.equal(normalizePlate('  7abc  123 '), '7ABC 123')
assert.equal(validatePlate('7ABC123'), null)
assert.match(validatePlate('!') ?? '', /2–15/)

assert.equal(
  validateNewCustomer({ name: 'Jane Doe', email: '', phone: '' }),
  null,
)
assert.equal(
  validateNewCustomer({ name: '', email: '', phone: '' }),
  'Enter the customer’s full name.',
)
assert.equal(
  validateNewCustomer({ name: 'Jane', email: 'not-an-email', phone: '' }),
  'Enter a valid email address.',
)
assert.equal(
  validateNewCustomer({ name: 'Jane', email: '', phone: '+1 (562) 555-0100' }),
  null,
)

console.log('booking-validation: all assertions passed')
