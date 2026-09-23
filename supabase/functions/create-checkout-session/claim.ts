// Reserve in Postgres BEFORE exposing an independently payable Checkout.
// An ambiguous network failure is not evidence that Stripe created nothing.
export type CheckoutClaim = {
  reserve(): Promise<void>
  create(): Promise<{ id: string; url: string | null }>
  attach(id: string): Promise<void>
  expire(id: string): Promise<boolean>
  release(): Promise<void>
}

export async function createClaimedCheckout(claim: CheckoutClaim) {
  await claim.reserve()
  let session: { id: string; url: string | null }
  try {
    session = await claim.create()
  } catch (error) {
    // Stripe rejected the parameters before creating a Session. Transport and
    // server errors can have succeeded remotely; retain those claims for a
    // terminal webhook or authoritative reconciliation.
    if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      error.type === 'StripeInvalidRequestError'
    )
      await claim.release()
    throw error
  }
  try {
    if (!session.url) throw new Error('Checkout did not return a URL')
    await claim.attach(session.id)
    return session.url
  } catch (error) {
    if (await claim.expire(session.id)) await claim.release()
    throw error
  }
}
