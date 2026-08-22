import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { PageSpinner } from '@/components/ui/Spinner'
import {
  loadFacilityReservations,
  type AttendantReservation,
} from '@/lib/attendant'
import { friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import {
  bigButton,
  bigButtonOutline,
  bigInput,
  useAttendant,
} from '@/lib/attendant-ui'

export const Route = createFileRoute('/attendant/active')({
  component: ActiveSessions,
})

function elapsedSince(iso: string | null) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return '—'
  const mins = Math.floor(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function ActiveSessions() {
  const { facility } = useAttendant()
  const [rows, setRows] = useState<AttendantReservation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [overstay, setOverstay] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!facility) return
    setLoading(true)
    setError(null)
    try {
      const active = await loadFacilityReservations(facility.id, ['active'])
      setRows(active)
    } catch (err) {
      setError(friendlyError(err, 'Could not load active sessions.'))
    }
    setLoading(false)
  }, [facility])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  function openCheckout(id: string) {
    setOpenId(id)
    setOverstay('')
  }

  async function checkOut(r: AttendantReservation) {
    const overstayCents =
      overstay.trim() === '' ? 0 : Math.round(Number(overstay) * 100)
    if (!Number.isFinite(overstayCents) || overstayCents < 0) {
      toast.error('Enter a valid overstay amount, or leave it blank.')
      return
    }
    setBusy(true)
    const { data, error: coError } = await supabase.rpc('check_out_reservation', {
      p_reservation_id: r.id,
      p_overstay_cents: overstayCents,
    })
    setBusy(false)
    if (coError) {
      toast.error(friendlyError(coError, 'Check-out failed. Please try again.'))
      return
    }
    const final = (data as { final_total_cents: number }[])[0]
    toast.success(`Checked out · ${dollars(final.final_total_cents)}`)
    setOpenId(null)
    await load()
  }

  if (loading) return <PageSpinner />

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Active sessions</h1>
      {error && <p className="text-base text-destructive">{error}</p>}

      {rows.length === 0 ? (
        <p className="py-8 text-center text-base text-muted-foreground">
          No vehicles are currently checked in.
        </p>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <div key={r.id} className="space-y-3 rounded-xl border bg-background p-4">
              <div className="space-y-1">
                <p className="text-xl font-semibold">{r.customer_name}</p>
                <p className="text-base">
                  Space <span className="font-medium">{r.space_number}</span>
                  {r.license_plate ? ` · ${r.license_plate}` : ''}
                </p>
                <p className="text-base text-muted-foreground">
                  Parked {elapsedSince(r.checked_in_at)} · {dollars(r.total_cents)}{' '}
                  so far
                </p>
              </div>

              {openId === r.id ? (
                <div className="space-y-3 border-t pt-3">
                  <label className="block text-base font-medium">
                    Overstay charge ($, optional)
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      className={`mt-1 ${bigInput}`}
                      value={overstay}
                      onChange={(e) => setOverstay(e.target.value)}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setOpenId(null)}
                      className={bigButtonOutline}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => checkOut(r)}
                      className={bigButton}
                    >
                      {busy ? 'Saving…' : 'Confirm check-out'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => openCheckout(r.id)}
                  className={bigButton}
                >
                  Check Out
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
