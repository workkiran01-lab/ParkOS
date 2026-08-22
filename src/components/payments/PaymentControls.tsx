import { useState } from 'react'
import { CreditCard, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { edgeFunctionError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import {
  paymentStatusLabel,
  type PaymentStatus,
  type PaymentSummary,
} from '@/lib/payments'
import { supabase } from '@/lib/supabase'

export function PaymentStatusBadge({
  status,
}: {
  status: PaymentStatus | null
}) {
  if (!status) return <Badge variant="outline">Not paid</Badge>

  const variant =
    status === 'succeeded'
      ? 'default'
      : status === 'pending'
        ? 'secondary'
        : status === 'failed'
          ? 'destructive'
          : 'outline'

  return <Badge variant={variant}>{paymentStatusLabel(status)}</Badge>
}

export function PayNowButton({ reservationId }: { reservationId: string }) {
  const [busy, setBusy] = useState(false)

  async function openCheckout() {
    setBusy(true)
    const { data, error } = await supabase.functions.invoke<{ url?: string }>(
      'create-checkout-session',
      {
        body: {
          reservation_id: reservationId,
          return_origin: window.location.origin,
        },
      },
    )

    if (error) {
      toast.error(
        await edgeFunctionError(
          error,
          'Checkout could not open. Please try again.',
        ),
      )
      setBusy(false)
      return
    }

    if (!data?.url) {
      toast.error('Checkout could not open. Please try again.')
      setBusy(false)
      return
    }

    window.location.assign(data.url)
  }

  return (
    <Button size="sm" disabled={busy} onClick={openCheckout}>
      <CreditCard data-icon="inline-start" />
      {busy ? 'Opening checkout…' : 'Pay now'}
    </Button>
  )
}

export function RefundPaymentButton({
  payment,
  onDone,
}: {
  payment: PaymentSummary
  onDone: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [requested, setRequested] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (payment.status !== 'succeeded') return null

  async function refund() {
    setBusy(true)
    setError(null)
    const { error: refundError } = await supabase.functions.invoke('refund-payment', {
      body: { p_payment_id: payment.id },
    })
    setBusy(false)

    if (refundError) {
      setError(
        await edgeFunctionError(
          refundError,
          'The refund could not be started. Please try again.',
        ),
      )
      return
    }

    setRequested(true)
    setOpen(false)
    toast.success('Refund requested. Waiting for Stripe confirmation.')
    await onDone()
    window.setTimeout(() => void onDone(), 2_000)
    window.setTimeout(() => void onDone(), 5_000)
  }

  return (
    <>
      <Button
        size="sm"
        variant={requested ? 'outline' : 'destructive'}
        disabled={requested}
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        <RotateCcw data-icon="inline-start" />
        {requested ? 'Refund pending' : 'Refund'}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refund payment</DialogTitle>
            <DialogDescription>
              Refund {dollars(payment.amount_cents)} {payment.currency} through
              Stripe? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Keep payment
            </Button>
            <Button variant="destructive" disabled={busy} onClick={refund}>
              {busy ? 'Refunding…' : 'Refund payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
