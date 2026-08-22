import { useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { PhotoCapture } from '@/components/attendant/PhotoCapture'
import { WalkIn } from '@/components/attendant/WalkIn'
import {
  loadFacilityReservations,
  type AttendantReservation,
} from '@/lib/attendant'
import { friendlyError } from '@/lib/errors'
import { formatRange } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { bigButton, bigInput, useAttendant } from '@/lib/attendant-ui'

export const Route = createFileRoute('/attendant/')({
  component: AttendantSearch,
})

function AttendantSearch() {
  const { orgId, facility } = useAttendant()
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<AttendantReservation[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [checkedIn, setCheckedIn] = useState<AttendantReservation | null>(null)

  async function search(event: FormEvent) {
    event.preventDefault()
    if (!facility) return
    setSearching(true)
    setError(null)
    setResults(null)
    setCheckedIn(null)
    try {
      const all = await loadFacilityReservations(facility.id, ['pending', 'confirmed'])
      const q = term.trim().toLowerCase()
      const matched = q
        ? all.filter(
            (r) =>
              r.id.toLowerCase().startsWith(q) ||
              (r.license_plate ?? '').toLowerCase().includes(q) ||
              r.customer_name.toLowerCase().includes(q) ||
              r.space_number.toLowerCase().includes(q),
          )
        : all
      setResults(matched)
    } catch (err) {
      setError(friendlyError(err, 'Search failed. Please try again.'))
    }
    setSearching(false)
  }

  async function checkIn(reservation: AttendantReservation) {
    setBusyId(reservation.id)
    const { error: ciError } = await supabase.rpc('check_in_reservation', {
      p_reservation_id: reservation.id,
    })
    setBusyId(null)
    if (ciError) {
      toast.error(friendlyError(ciError, 'Check-in failed. Please try again.'))
      return
    }
    toast.success('Checked in')
    setCheckedIn(reservation)
    setResults((prev) => (prev ?? []).filter((r) => r.id !== reservation.id))
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Check in</h1>

      <form onSubmit={search} className="space-y-3">
        <input
          autoFocus
          className={bigInput}
          placeholder="License plate or reservation ID"
          value={term}
          autoCapitalize="characters"
          onChange={(event) => setTerm(event.target.value)}
        />
        <button type="submit" disabled={searching} className={bigButton}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error && <p className="text-base text-destructive">{error}</p>}

      {checkedIn && (
        <div className="space-y-4 rounded-xl border bg-background p-4">
          <div>
            <p className="text-lg font-semibold">Checked in ✓</p>
            <p className="text-base text-muted-foreground">
              {checkedIn.customer_name} — space {checkedIn.space_number}
            </p>
          </div>
          <PhotoCapture orgId={orgId} reservationId={checkedIn.id} />
        </div>
      )}

      {results !== null && (
        <div className="space-y-4">
          {results.map((r) => (
            <div key={r.id} className="space-y-3 rounded-xl border bg-background p-4">
              <div className="space-y-1">
                <p className="text-xl font-semibold">{r.customer_name}</p>
                <p className="text-base">
                  Space <span className="font-medium">{r.space_number}</span>
                  {r.zone_name ? ` · ${r.zone_name}` : ''}
                </p>
                <p className="text-base text-muted-foreground">
                  {r.license_plate ? `Plate ${r.license_plate} · ` : ''}
                  {formatRange(r.during)}
                </p>
                <p className="text-sm text-muted-foreground capitalize">{r.status}</p>
              </div>
              <button
                type="button"
                disabled={busyId === r.id}
                onClick={() => checkIn(r)}
                className={bigButton}
              >
                {busyId === r.id ? 'Checking in…' : 'Check In'}
              </button>
            </div>
          ))}

          {results.length === 0 && facility && (
            <WalkIn
              orgId={orgId}
              facilityId={facility.id}
              initialPlate={term}
              onCheckedIn={() => {
                setResults(null)
                setTerm('')
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
