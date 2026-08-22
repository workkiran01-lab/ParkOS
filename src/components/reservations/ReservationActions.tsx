import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import type { QuoteBreakdown } from '@/components/facility/PricingSection'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { friendlyError } from '@/lib/errors'
import { dollars, isoToLocalInput } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type Props = {
  reservationId: string
  status: string
  spaceId: string
  startIso: string
  endIso: string
  /** Staff see a Confirm action and use the staff quote function; customers
   * use the elevated public wrapper. */
  isStaff: boolean
  /** Once Checkout starts, changing the priced window would invalidate it. */
  allowExtend?: boolean
  onDone: () => void | Promise<void>
}

const ACTIVE = new Set(['pending', 'confirmed'])

export function ReservationActions({
  reservationId,
  status,
  spaceId,
  startIso,
  endIso,
  isStaff,
  allowExtend = true,
  onDone,
}: Props) {
  const [cancelOpen, setCancelOpen] = useState(false)
  const [extendOpen, setExtendOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [newEnd, setNewEnd] = useState(() => isoToLocalInput(endIso))
  const [preview, setPreview] = useState<QuoteBreakdown | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!ACTIVE.has(status)) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  async function cancel(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const { error: cancelError } = await supabase.rpc('cancel_reservation', {
      p_reservation_id: reservationId,
      p_reason: reason.trim() || null,
    })
    setBusy(false)
    if (cancelError) {
      setError(
        friendlyError(
          cancelError,
          'The reservation could not be cancelled. Please try again.',
        ),
      )
      return
    }
    setCancelOpen(false)
    setReason('')
    toast.success('Reservation cancelled')
    await onDone()
  }

  async function previewExtend() {
    setError(null)
    setPreview(null)
    const end = new Date(newEnd)
    if (Number.isNaN(end.getTime()) || end <= new Date(endIso)) {
      setError('Pick a new end later than the current end.')
      return
    }
    setBusy(true)
    const fn = isStaff ? 'quote_reservation' : 'public_quote_reservation'
    const { data, error: quoteError } = await supabase.rpc(fn, {
      p_space_id: spaceId,
      p_start: startIso,
      p_end: end.toISOString(),
    })
    setBusy(false)
    if (quoteError) {
      setError(
        friendlyError(
          quoteError,
          'The updated price could not be calculated. Please try again.',
        ),
      )
      return
    }
    setPreview(data as QuoteBreakdown)
  }

  async function commitExtend() {
    const end = new Date(newEnd)
    if (Number.isNaN(end.getTime()) || end <= new Date(endIso)) {
      setError('Pick a new end later than the current end.')
      return
    }
    setBusy(true)
    setError(null)
    const { error: extendError } = await supabase.rpc('extend_reservation', {
      p_reservation_id: reservationId,
      p_new_end: end.toISOString(),
    })
    setBusy(false)
    if (extendError) {
      setError(friendlyError(extendError, 'The reservation could not be extended.'))
      return
    }
    setExtendOpen(false)
    setPreview(null)
    toast.success('Reservation extended')
    await onDone()
  }

  return (
    <div className="flex flex-wrap gap-2">
      {allowExtend && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setNewEnd(isoToLocalInput(endIso))
            setPreview(null)
            setError(null)
            setExtendOpen(true)
          }}
        >
          Extend
        </Button>
      )}
      <Button
        size="sm"
        variant="destructive"
        onClick={() => {
          setReason('')
          setError(null)
          setCancelOpen(true)
        }}
      >
        Cancel
      </Button>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel reservation</DialogTitle>
            <DialogDescription>
              This releases the space immediately and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={cancel} className="space-y-4">
            <Field label={isStaff ? 'Reason' : 'Reason (optional)'}>
              <Input
                required={isStaff}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. customer request, double-booking"
              />
            </Field>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCancelOpen(false)}
              >
                Keep it
              </Button>
              <Button type="submit" variant="destructive" disabled={busy}>
                {busy ? 'Cancelling…' : 'Cancel reservation'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={extendOpen} onOpenChange={setExtendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Extend reservation</DialogTitle>
            <DialogDescription>
              Pick a later end time, preview the new total, then confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="New end">
              <Input
                type="datetime-local"
                value={newEnd}
                onChange={(event) => {
                  setNewEnd(event.target.value)
                  setPreview(null)
                }}
              />
            </Field>
            {preview && (
              <div className="rounded-lg border p-3 text-sm">
                <p className="flex justify-between">
                  <span className="text-muted-foreground">New total</span>
                  <span className="font-medium">
                    {dollars(preview.total_cents)} {preview.currency}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Recalculated for the full window (original start → new end).
                </p>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              {preview ? (
                <Button disabled={busy} onClick={commitExtend}>
                  {busy ? 'Extending…' : 'Confirm extend'}
                </Button>
              ) : (
                <Button variant="outline" disabled={busy} onClick={previewExtend}>
                  {busy ? 'Pricing…' : 'Preview new total'}
                </Button>
              )}
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
