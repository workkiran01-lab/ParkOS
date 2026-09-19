import Stripe from 'npm:stripe@22.6.0'
import { ConfigurationError } from './http.ts'

let cachedStripe: Stripe | null = null

export function getStripeClient() {
  if (!cachedStripe) {
    const secretKey = Deno.env.get('STRIPE_SECRET_KEY')?.trim()
    if (!secretKey)
      throw new ConfigurationError('Payments are not configured yet.')
    // Pinned deliberately, and to the same version the pinned SDK already
    // sends by default -- stripe-node uses its own baked-in ApiVersion when the
    // option is omitted, it does not fall back to the account default. Stating
    // it here changes nothing today; it stops an SDK bump from silently moving
    // the wire version, which is what `npm:stripe@^22` allowed. See
    // ARCHITECTURE.md, "Stripe API version pinning".
    cachedStripe = new Stripe(secretKey, {
      apiVersion: '2026-08-26.dahlia',
      maxNetworkRetries: 2,
    })
  }

  return cachedStripe
}

export function getStripeWebhookSecret() {
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')?.trim()
  if (!webhookSecret)
    throw new ConfigurationError('Payment webhooks are not configured yet.')
  return webhookSecret
}

// stripeObjectId moved to ./stripe-payload.ts: it reads a payload rather than
// talking to Stripe, and this module cannot be imported by a node test because
// of the npm:stripe import above.

export { Stripe }
