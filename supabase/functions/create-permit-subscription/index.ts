import type Stripe from 'npm:stripe@^22'
import {
  AuthenticationError,
  ConfigurationError,
  errorResponse,
  isUuid,
  jsonResponse,
  optionsResponse,
  readJsonObject,
  readString,
} from '../_shared/http.ts'
import { getStripeClient } from '../_shared/stripe.ts'
import { getAuthenticatedClients } from '../_shared/supabase.ts'

type Permit = {
  id: string
  org_id: string
  customer_id: string
  monthly_rate_cents: number
  currency: string
  status: string
  stripe_subscription_id: string | null
}

type Customer = {
  id: string
  full_name: string
  email: string | null
  stripe_customer_id: string | null
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return optionsResponse()
  if (request.method !== 'POST')
    return errorResponse('Use POST for this endpoint.', 405)

  try {
    const body = await readJsonObject(request)
    const permitId = body ? readString(body.permit_id) : null
    const action = body ? readString(body.action) ?? 'create' : 'create'
    if (!isUuid(permitId)) return errorResponse('Choose a valid permit.', 400)

    const { userClient, adminClient } = await getAuthenticatedClients(request)
    const { data: permitData, error: permitError } = await userClient
      .from('permits')
      .select('id, org_id, customer_id, monthly_rate_cents, currency, status, stripe_subscription_id')
      .eq('id', permitId)
      .maybeSingle()

    if (permitError || !permitData)
      return errorResponse('Permit not found or unavailable.', permitError ? 500 : 404)

    const permit = permitData as Permit
    const { data: allowed, error: roleError } = await userClient.rpc('has_any_role', {
      check_org_id: permit.org_id,
      allowed_roles: ['admin', 'manager'],
    })
    if (roleError) return errorResponse('Permit permissions could not be verified.', 500)
    if (allowed !== true)
      return errorResponse('An administrator or manager is required.', 403)
    if (action === 'cancel') {
      if (!permit.stripe_subscription_id)
        return errorResponse('This permit has no Stripe subscription to cancel.', 409)
      await getStripeClient().subscriptions.cancel(permit.stripe_subscription_id, {
        cancellation_details: {
          comment: readString(body?.reason) ?? 'Cancelled by ParkOS staff',
        },
      })
      return jsonResponse({
        requested: true,
        message: 'Cancellation requested. Waiting for Stripe confirmation.',
      }, 202)
    }
    if (action !== 'create') return errorResponse('Unsupported permit action.', 400)
    if (permit.status === 'cancelled')
      return errorResponse('A cancelled permit cannot start billing.', 409)
    if (!Number.isInteger(permit.monthly_rate_cents) || permit.monthly_rate_cents <= 0)
      return errorResponse('The permit needs a positive monthly rate.', 422)
    if (!/^[A-Za-z]{3}$/.test(permit.currency))
      return errorResponse('The permit currency is invalid.', 422)

    const stripe = getStripeClient()
    if (permit.stripe_subscription_id) {
      const existing = await stripe.subscriptions.retrieve(
        permit.stripe_subscription_id,
        { expand: ['latest_invoice'] },
      )
      return subscriptionResponse(existing, true)
    }

    const { data: customerData, error: customerError } = await userClient
      .from('customers')
      .select('id, full_name, email, stripe_customer_id')
      .eq('id', permit.customer_id)
      .eq('org_id', permit.org_id)
      .maybeSingle()
    if (customerError || !customerData)
      return errorResponse('The permit customer could not be loaded.', customerError ? 500 : 404)

    const customer = customerData as Customer
    let stripeCustomerId = customer.stripe_customer_id
    if (!stripeCustomerId) {
      const stripeCustomer = await stripe.customers.create(
        {
          name: customer.full_name,
          email: customer.email ?? undefined,
          metadata: { customer_id: customer.id, org_id: permit.org_id },
        },
        { idempotencyKey: `parkos-customer:${customer.id}` },
      )
      stripeCustomerId = stripeCustomer.id
      const { error: customerUpdateError } = await adminClient
        .from('customers')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', customer.id)
        .is('stripe_customer_id', null)
      if (customerUpdateError) {
        console.error('Stripe customer identity could not be saved.')
        return errorResponse('Subscription setup could not be saved.', 500)
      }
    }

    const metadata = {
      permit_id: permit.id,
      customer_id: permit.customer_id,
      org_id: permit.org_id,
    }
    const product = await stripe.products.create(
      { name: `ParkOS monthly parking permit ${permit.id}`, metadata },
      { idempotencyKey: `parkos-permit-product:${permit.id}` },
    )
    const price = await stripe.prices.create(
      {
        product: product.id,
        currency: permit.currency.toLowerCase(),
        unit_amount: permit.monthly_rate_cents,
        recurring: { interval: 'month' },
        metadata,
      },
      {
        idempotencyKey:
          `parkos-permit-price:${permit.id}:${permit.monthly_rate_cents}:${permit.currency.toLowerCase()}`,
      },
    )
    const subscription = await stripe.subscriptions.create(
      {
        customer: stripeCustomerId,
        items: [{ price: price.id }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata,
        expand: ['latest_invoice.confirmation_secret'],
      },
      { idempotencyKey: `parkos-permit-subscription:${permit.id}` },
    )

    return subscriptionResponse(subscription, false)
  } catch (error) {
    if (error instanceof AuthenticationError)
      return errorResponse(error.message, 401)
    if (error instanceof ConfigurationError)
      return errorResponse(error.message, 503)
    console.error('Unexpected permit subscription setup failure.')
    return errorResponse('Subscription setup is temporarily unavailable.', 502)
  }
})

function subscriptionResponse(subscription: Stripe.Subscription, reused: boolean) {
  const invoice =
    subscription.latest_invoice && typeof subscription.latest_invoice === 'object'
      ? (subscription.latest_invoice as unknown as Record<string, unknown>)
      : null
  const confirmationSecret =
    invoice?.confirmation_secret && typeof invoice.confirmation_secret === 'object'
      ? (invoice.confirmation_secret as Record<string, unknown>)
      : null
  const paymentUrl =
    typeof invoice?.hosted_invoice_url === 'string'
      ? invoice.hosted_invoice_url
      : null
  const clientSecret =
    typeof confirmationSecret?.client_secret === 'string'
      ? confirmationSecret.client_secret
      : null

  if (!paymentUrl && !clientSecret) {
    return errorResponse('Stripe did not return a payment collection method.', 502)
  }
  return jsonResponse({
    subscription_id: subscription.id,
    payment_url: paymentUrl,
    client_secret: clientSecret,
    reused,
  })
}
