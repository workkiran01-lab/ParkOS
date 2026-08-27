import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { PageSpinner } from '@/components/ui/Spinner'
import {
  loadFacilityReservations,
  overstayAt,
  type AttendantReservation,
} from '@/lib/attendant'
import { friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { bigButton, bigButtonOutline, useAttendant } from '@/lib/attendant-ui'

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
  // Server-priced, not typed in: the database owns what an overstay costs.
  const [overstayCents, setOverstayCents] = useState<number | null>(null)
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

  async function openCheckout(r: AttendantReservation) {
    setOpenId(r.id)
    setOverstayCents(null)
    try {
      setOverstayCents(await overstayAt(r.id, new Date()))
    } catch (err) {
      toast.error(friendlyError(err, 'Could not price the overstay.'))
      setOpenId(null)
    }
  }

  async function checkOut(r: AttendantReservation) {
    setBusy(true)
    const { data, error: coError } = await supabase.rpc(
      'check_out_reservation',
      {
        p_reservation_id: r.id,
        p_departure_at: new Date().toISOString(),
      },
    )
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
            <div
              key={r.id}
              className="space-y-3 rounded-xl border bg-background p-4"
            >
              <div className="space-y-1">
                <p className="text-xl font-semibold">{r.customer_name}</p>
                <p className="text-base">
                  Space <span className="font-medium">{r.space_number}</span>
                  {r.license_plate ? ` · ${r.license_plate}` : ''}
                </p>
                <p className="text-base text-muted-foreground">
                  Parked {elapsedSince(r.checked_in_at)} ·{' '}
                  {dollars(r.total_cents)} so far
                </p>
              </div>

              {openId === r.id ? (
                <div className="space-y-3 border-t pt-3">
                  <p className="text-base">
                    {overstayCents === null
                      ? 'Pricing overstay…'
                      : overstayCents > 0
                        ? `Overstay ${dollars(overstayCents)}, added at check-out.`
                        : 'Inside the reserved window — no overstay.'}
                  </p>
                  {/* Collection lives on the ticket screen, where the stub
                      prints. This tab closes the session. */}
                  <Link
                    to="/checkin/$bookingCode"
                    params={{ bookingCode: r.booking_code }}
                    className={bigButtonOutline}
                  >
                    Open ticket to collect
                  </Link>
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
                      disabled={busy || overstayCents === null}
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
                  onClick={() => void openCheckout(r)}
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
