import assert from 'node:assert/strict'
import test from 'node:test'
import { createClaimedCheckout, type CheckoutClaim } from './claim.ts'

function fixture(overrides: Partial<CheckoutClaim> = {}) {
  const calls: string[] = []
  const claim: CheckoutClaim = {
    reserve: async () => {
      calls.push('reserve')
    },
    create: async () => {
      calls.push('create')
      return { id: 'cs_local', url: 'https://checkout.example.test/local' }
    },
    attach: async () => {
      calls.push('attach')
    },
    expire: async () => {
      calls.push('expire')
      return true
    },
    release: async () => {
      calls.push('release')
    },
    ...overrides,
  }
  return { calls, claim }
}
test('checkout is only created after the database reserves its amount', async () => {
  const { calls, claim } = fixture()
  assert.equal(
    await createClaimedCheckout(claim),
    'https://checkout.example.test/local',
  )
  assert.deepEqual(calls, ['reserve', 'create', 'attach'])
  const blocked = fixture({
    reserve: async () => {
      throw new Error('AMOUNT_EXCEEDS_BALANCE')
    },
  })
  await assert.rejects(
    createClaimedCheckout(blocked.claim),
    /AMOUNT_EXCEEDS_BALANCE/,
  )
  assert.deepEqual(blocked.calls, [])
})
test('definitive creation failure releases funds; ambiguous failure does not', async () => {
  const rejected = fixture({
    create: async () => {
      throw { type: 'StripeInvalidRequestError' }
    },
  })
  await assert.rejects(createClaimedCheckout(rejected.claim))
  assert.deepEqual(rejected.calls, ['reserve', 'release'])
  const timeout = fixture({
    create: async () => {
      throw new Error('timeout after request sent')
    },
  })
  await assert.rejects(createClaimedCheckout(timeout.claim), /timeout/)
  assert.deepEqual(timeout.calls, ['reserve'])
})
test('failed attachment releases funds only after confirmed session expiry', async () => {
  const closed = fixture({
    attach: async () => {
      throw new Error('database unavailable')
    },
  })
  await assert.rejects(
    createClaimedCheckout(closed.claim),
    /database unavailable/,
  )
  assert.deepEqual(closed.calls, ['reserve', 'create', 'expire', 'release'])
  const unknown = fixture({
    attach: async () => {
      throw new Error('database unavailable')
    },
    expire: async () => false,
  })
  await assert.rejects(createClaimedCheckout(unknown.claim))
  assert.deepEqual(unknown.calls, ['reserve', 'create'])
})
