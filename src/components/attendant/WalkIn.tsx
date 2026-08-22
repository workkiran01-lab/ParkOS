import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { PhotoCapture } from '@/components/attendant/PhotoCapture'
import { lookupByPlate, type PlateMatch } from '@/lib/attendant'
import { friendlyError } from '@/lib/errors'
import { defaultLocalDatetime, dollars } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import {
  bigButton,
  bigButtonOutline,
  bigInput,
  tapTarget,
} from '@/lib/attendant-ui'

type Chosen = {
  customer_id: string
  vehicle_id: string
  label: string
}

type AvailableSpace = { id: string; space_number: string; space_type: string }

export function WalkIn({
  orgId,
  facilityId,
  initialPlate,
  onCheckedIn,
}: {
  orgId: string
  facilityId: string
  initialPlate: string
  onCheckedIn: () => void
}) {
  const [plate, setPlate] = useState(initialPlate.toUpperCase())
  const [matches, setMatches] = useState<PlateMatch[] | null>(null)
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // add-new fields
  const [fullName, setFullName] = useState('')
  const [makeModel, setMakeModel] = useState('')
  const [color, setColor] = useState('')

  // window + space
  const [start, setStart] = useState(() => defaultLocalDatetime())
  const [end, setEnd] = useState(() => defaultLocalDatetime(2 * 3600_000))
  const [spaces, setSpaces] = useState<AvailableSpace[] | null>(null)
  const [spaceId, setSpaceId] = useState<string | null>(null)

  const [doneReservationId, setDoneReservationId] = useState<string | null>(null)
  const [doneTotal, setDoneTotal] = useState<number | null>(null)

  async function findPlate(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setChosen(null)
    try {
      const found = await lookupByPlate(orgId, plate)
      setMatches(found)
      if (found.length === 0) setFullName('')
    } catch (err) {
      setError(friendlyError(err, 'Plate lookup failed. Please try again.'))
    }
    setBusy(false)
  }

  function pickMatch(m: PlateMatch) {
    setChosen({
      customer_id: m.customer_id,
      vehicle_id: m.vehicle_id,
      label: `${m.customer_name} · ${m.license_plate}`,
    })
  }

  async function addNew(event: FormEvent) {
    event.preventDefault()
    if (!fullName.trim() || !plate.trim()) return
    setBusy(true)
    setError(null)
    const [make, ...model] = makeModel.trim().split(' ')
    const { data: customer, error: cErr } = await supabase
      .from('customers')
      .insert({ org_id: orgId, full_name: fullName.trim() })
      .select('id, full_name')
      .single()
    if (cErr || !customer) {
      setBusy(false)
      setError(friendlyError(cErr, 'Could not create the customer.'))
      return
    }
    const { data: vehicle, error: vErr } = await supabase
      .from('vehicles')
      .insert({
        org_id: orgId,
        customer_id: customer.id,
        license_plate: plate.trim().toUpperCase(),
        make: make || null,
        model: model.join(' ') || null,
        color: color.trim() || null,
      })
      .select('id')
      .single()
    setBusy(false)
    if (vErr || !vehicle) {
      setError(friendlyError(vErr, 'Could not save the vehicle.'))
      return
    }
    setChosen({
      customer_id: customer.id,
      vehicle_id: vehicle.id,
      label: `${customer.full_name} · ${plate.trim().toUpperCase()}`,
    })
  }

  async function findSpaces() {
    setBusy(true)
    setError(null)
    setSpaces(null)
    setSpaceId(null)
    const { data, error: sErr } = await supabase.rpc('find_available_spaces', {
      p_facility_id: facilityId,
      p_start: new Date(start).toISOString(),
      p_end: new Date(end).toISOString(),
    })
    setBusy(false)
    if (sErr) {
      setError(friendlyError(sErr, 'Could not load available spaces.'))
      return
    }
    setSpaces((data ?? []) as AvailableSpace[])
  }

  async function checkIn() {
    if (!chosen || !spaceId) return
    setBusy(true)
    setError(null)
    const { data, error: ciErr } = await supabase.rpc('check_in_walk_in', {
      p_space_id: spaceId,
      p_customer_id: chosen.customer_id,
      p_vehicle_id: chosen.vehicle_id,
      p_start: new Date(start).toISOString(),
      p_end: new Date(end).toISOString(),
    })
    setBusy(false)
    if (ciErr) {
      setError(
        ciErr.message === 'SPACE_UNAVAILABLE'
          ? 'That space was just taken for this window. Pick another.'
          : friendlyError(ciErr, 'Walk-in check-in failed. Please try again.'),
      )
      return
    }
    const row = (data as { reservation_id: string; total_cents: number }[])[0]
    setDoneReservationId(row.reservation_id)
    setDoneTotal(row.total_cents)
    toast.success('Walk-in checked in')
    onCheckedIn()
  }

  if (doneReservationId) {
    return (
      <div className="space-y-4 rounded-xl border bg-background p-4">
        <div>
          <p className="text-lg font-semibold">Checked in ✓</p>
          <p className="text-base text-muted-foreground">
            {chosen?.label} — {dollars(doneTotal ?? 0)} estimated
          </p>
        </div>
        <PhotoCapture orgId={orgId} reservationId={doneReservationId} />
      </div>
    )
  }

  return (
    <div className="space-y-5 rounded-xl border bg-background p-4">
      <div>
        <p className="text-lg font-semibold">Walk-in check-in</p>
        <p className="text-base text-muted-foreground">
          No booking found. Check in a drive-up vehicle.
        </p>
      </div>

      {/* 1. Vehicle / customer */}
      {!chosen ? (
        <form onSubmit={findPlate} className="space-y-3">
          <label className="block text-base font-medium">
            License plate
            <input
              className={`mt-1 ${bigInput}`}
              value={plate}
              autoCapitalize="characters"
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
            />
          </label>
          <button type="submit" disabled={busy || !plate.trim()} className={bigButtonOutline}>
            {busy ? 'Searching…' : 'Find plate'}
          </button>

          {matches && matches.length > 0 && (
            <div className="space-y-2">
              <p className="text-base font-medium">Existing match — tap to use:</p>
              {matches.map((m) => (
                <button
                  key={m.vehicle_id}
                  type="button"
                  onClick={() => pickMatch(m)}
                  className={`flex w-full flex-col items-start rounded-lg border px-4 py-2 text-left ${tapTarget}`}
                >
                  <span className="text-base font-medium">{m.customer_name}</span>
                  <span className="text-sm text-muted-foreground">
                    {m.license_plate}
                    {m.description ? ` · ${m.description}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}

          {matches && matches.length === 0 && (
            <div className="space-y-3 border-t pt-3">
              <p className="text-base font-medium">No match — add new</p>
              <label className="block text-base font-medium">
                Customer name
                <input
                  className={`mt-1 ${bigInput}`}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </label>
              <label className="block text-base font-medium">
                Make & model
                <input
                  className={`mt-1 ${bigInput}`}
                  value={makeModel}
                  onChange={(e) => setMakeModel(e.target.value)}
                />
              </label>
              <label className="block text-base font-medium">
                Color
                <input
                  className={`mt-1 ${bigInput}`}
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={busy || !fullName.trim()}
                onClick={addNew}
                className={bigButtonOutline}
              >
                {busy ? 'Saving…' : 'Save new vehicle'}
              </button>
            </div>
          )}
        </form>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
          <span className="text-base font-medium">{chosen.label}</span>
          <button
            type="button"
            onClick={() => {
              setChosen(null)
              setMatches(null)
            }}
            className="min-h-11 text-base text-muted-foreground underline"
          >
            Change
          </button>
        </div>
      )}

      {/* 2. Window + 3. Space (only once a customer/vehicle is chosen) */}
      {chosen && (
        <div className="space-y-3 border-t pt-4">
          <div className="grid grid-cols-1 gap-3">
            <label className="block text-base font-medium">
              From
              <input
                type="datetime-local"
                className={`mt-1 ${bigInput}`}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="block text-base font-medium">
              Until
              <input
                type="datetime-local"
                className={`mt-1 ${bigInput}`}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <button type="button" disabled={busy} onClick={findSpaces} className={bigButtonOutline}>
            {busy ? 'Loading…' : 'Find available spaces'}
          </button>

          {spaces && spaces.length === 0 && (
            <p className="text-base text-muted-foreground">
              No spaces free for that window.
            </p>
          )}
          {spaces && spaces.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {spaces.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSpaceId(s.id)}
                  className={`rounded-lg border px-3 text-base font-medium ${tapTarget} ${
                    spaceId === s.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'bg-background'
                  }`}
                >
                  {s.space_number}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            disabled={busy || !spaceId}
            onClick={checkIn}
            className={bigButton}
          >
            {busy ? 'Checking in…' : 'Check in walk-in'}
          </button>
        </div>
      )}

      {error && <p className="text-base text-destructive">{error}</p>}
    </div>
  )
}
