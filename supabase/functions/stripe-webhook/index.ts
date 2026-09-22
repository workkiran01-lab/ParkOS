import {
  getStripeClient,
  getStripeWebhookSecret,
  Stripe,
} from '../_shared/stripe.ts'
import { getAdminClient } from '../_shared/supabase.ts'
import { issueReceiptForPayment } from '../_shared/receipt.ts'
import { createStripeWebhookHandler } from './handler.ts'

const cryptoProvider = Stripe.createSubtleCryptoProvider()

Deno.serve(
  createStripeWebhookHandler({
    verifyEvent: (body, signature) =>
      getStripeClient().webhooks.constructEventAsync(
        body,
        signature,
        getStripeWebhookSecret(),
        undefined,
        cryptoProvider,
      ),
    rpc: (name, args) => getAdminClient().rpc(name, args),
    issueReceipt: (paymentId, reservationId) =>
      issueReceiptForPayment(getAdminClient(), { paymentId, reservationId }),
  }),
)
