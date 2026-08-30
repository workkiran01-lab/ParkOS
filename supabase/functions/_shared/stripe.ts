import Stripe from 'npm:stripe@^22'
import { ConfigurationError } from './http.ts'

let cachedStripe: Stripe | null = null

export function getStripeClient() {
  if (!cachedStripe) {
    const secretKey = Deno.env.get('STRIPE_SECRET_KEY')?.trim()
    if (!secretKey)
      throw new ConfigurationError('Payments are not configured yet.')
    cachedStripe = new Stripe(secretKey, { maxNetworkRetries: 2 })
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
