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

export function stripeObjectId(value: unknown) {
  if (typeof value === 'string' && value) return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = value.id
    return typeof id === 'string' && id ? id : null
  }
  return null
}

export { Stripe }
