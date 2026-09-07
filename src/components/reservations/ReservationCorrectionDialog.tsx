import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  normalizePlate,
  validateNewCustomer,
  validatePlate,
} from '@/lib/booking-validation'
import { friendlyError } from '@/lib/errors'
import {
  FacilityTimeError,
  instantToFacilityInput,
  parseFacilityWindow,
} from '@/lib/facility-time'
import { dollars } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type SpaceOption = {
  id: string
  space_number: string
  zone_id: string
}

/** Another reservation that shares this one's customer or vehicle record. */
type AffectedReservation = {
  reservation_id: string
  booking_code: string
  shared: 'customer' | 'vehicle' | 'customer+vehicle'
}

export type CorrectionDetails = {
  facilityId: string
  facilityTimezone: string
  customerName: string
  customerEmail: string | null
  customerPhone: string | null
  licensePlate: string | null
}

type Props = {
  reservationId: string
  currentSpaceId: string
  startIso: string
  endIso: string
  details: CorrectionDetails
  onDone: () => void | Promise<void>
}

export function ReservationCorrectionDialog({
  reservationId,
  currentSpaceId,
  startIso,
  endIso,
  details,
  onDone,
}: Props) {
  const [open, setOpen] = useState(false)
  const [spaces, setSpaces] = useState<SpaceOption[]>([])
  const [zoneNames, setZoneNames] = useState(new Map<string, string>())
  const [spaceId, setSpaceId] = useState(currentSpaceId)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [customerName, setCustomerName] = useState(details.customerName)
  const [customerEmail, setCustomerEmail] = useState(
    details.customerEmail ?? '',
  )
  const [customerPhone, setCustomerPhone] = useState(
    details.customerPhone ?? '',
  )
  const [licensePlate, setLicensePlate] = useState(details.licensePlate ?? '')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Customer and vehicle records are shared per org, so editing contact details
  // here also rewrites them for these reservations. Staff see this before
  // confirming, never as an after-the-fact notification.
  const [affected, setAffected] = useState<AffectedReservation[]>([])
  const [scopeUnknown, setScopeUnknown] = useState(false)

  async function show() {
    setOpen(true)
    setLoading(true)
    setError(null)
    setSpaceId(currentSpaceId)
    setCustomerName(details.customerName)
    setCustomerEmail(details.customerEmail ?? '')
    setCustomerPhone(details.customerPhone ?? '')
    setLicensePlate(details.licensePlate ?? '')
    setReason('')
    setAffected([])
    setScopeUnknown(false)

    const scopeResult = await supabase.rpc('reservation_correction_scope', {
      p_reservation_id: reservationId,
    })
    if (scopeResult.error) {
      // Never claim "only this reservation" when we could not check.
      setScopeUnknown(true)
    } else {
      const scope = (
        scopeResult.data as
          { affected_reservations: AffectedReservation[] | null }[] | null
      )?.[0]
      setAffected(scope?.affected_reservations ?? [])
    }

    try {
      setStart(instantToFacilityInput(startIso, details.facilityTimezone))
      setEnd(instantToFacilityInput(endIso, details.facilityTimezone))
    } catch (caught) {
      setError(
        caught instanceof FacilityTimeError
          ? caught.message
          : 'The reservation window could not be loaded.',
      )
    }

    const zonesResult = await supabase
      .from('zones')
      .select('id, name')
      .eq('facility_id', details.facilityId)
      .is('archived_at', null)
      .order('name')
    if (zonesResult.error) {
      setLoading(false)
      setError(
        friendlyError(zonesResult.error, 'Could not load facility zones.'),
      )
      return
    }
    const zones = zonesResult.data ?? []
    const ids = zones.map((zone) => zone.id)
    const spacesResult = ids.length
      ? await supabase
          .from('spaces')
          .select('id, space_number, zone_id')
          .in('zone_id', ids)
          .is('archived_at', null)
          .order('space_number')
      : { data: [], error: null }
    setLoading(false)
    if (spacesResult.error) {
      setError(
        friendlyError(spacesResult.error, 'Could not load facility spaces.'),
      )
      return
    }
    setZoneNames(new Map(zones.map((zone) => [zone.id, zone.name])))
    setSpaces((spacesResult.data ?? []) as SpaceOption[])
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    const customerError = validateNewCustomer({
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
    })
    if (customerError) {
      setError(customerError)
      return
    }
    if (details.licensePlate !== null) {
      const plateError = validatePlate(licensePlate)
      if (plateError) {
        setError(plateError)
        return
      }
    }
    if (!spaceId) {
      setError('Choose an assigned space.')
      return
    }
    if (!reason.trim()) {
      setError('Enter a reason for the audit log.')
      return
    }
    let window
    try {
      window = parseFacilityWindow(start, end, details.facilityTimezone)
    } catch (caught) {
      setError(
        caught instanceof FacilityTimeError
          ? caught.message
          : 'Enter a valid arrival and departure.',
      )
      return
    }

    setBusy(true)
    setError(null)
    const { data, error: updateError } = await supabase.rpc(
      'correct_reservation',
      {
        p_reservation_id: reservationId,
        p_space_id: spaceId,
        p_start: window.startIso,
        p_end: window.endIso,
        p_customer_name: customerName.trim(),
        p_customer_email: customerEmail.trim(),
        p_customer_phone: customerPhone.trim(),
        p_license_plate:
          details.licensePlate === null ? '' : normalizePlate(licensePlate),
        p_reason: reason.trim(),
      },
    )
    setBusy(false)
    if (updateError) {
      const message =
        updateError.message === 'SPACE_UNAVAILABLE'
          ? 'That space is already held during the corrected window.'
          : updateError.message === 'OUTSIDE_OPERATING_HOURS'
            ? 'The corrected window is outside facility operating hours.'
            : friendlyError(
                updateError,
                'The reservation could not be corrected.',
              )
      setError(message)
      return
    }
    const result = (
      data as
        | {
            booking_code: string
            total_cents: number
            affected_reservations: AffectedReservation[] | null
          }[]
        | null
    )?.[0]
    const alsoChanged = result?.affected_reservations?.length ?? 0
    if (!result?.booking_code) {
      setError(
        'The correction completed, but its booking code was not returned.',
      )
      return
    }
    setOpen(false)
    toast.success(
      `${result.booking_code} corrected — ${dollars(result.total_cents)} total` +
        (alsoChanged > 0
          ? ` · shared contact details also updated on ${alsoChanged} other ${
              alsoChanged === 1 ? 'reservation' : 'reservations'
            }`
          : ''),
    )
    await onDone()
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={show}>
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Correct reservation</DialogTitle>
            <DialogDescription>
              Times use {details.facilityTimezone}. Saving reprices the complete
              window and records the before/after values.
            </DialogDescription>
          </DialogHeader>
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Loading facility spaces…
            </p>
          ) : (
            <form onSubmit={save} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Arrival">
                  <Input
                    required
                    type="datetime-local"
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </Field>
                <Field label="Departure">
                  <Input
                    required
                    type="datetime-local"
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </Field>
              </div>
              <Field label="Assigned space">
                <Select value={spaceId} onValueChange={setSpaceId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a space" />
                  </SelectTrigger>
                  <SelectContent>
                    {spaces.map((space) => (
                      <SelectItem key={space.id} value={space.id}>
                        {zoneNames.get(space.zone_id) ?? 'Zone'} ·{' '}
                        {space.space_number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {scopeUnknown ? (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                  Could not check which other reservations share this
                  customer&rsquo;s record. Contact and plate edits are shared,
                  so other reservations may also change.
                </p>
              ) : affected.length > 0 ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                  <p className="font-medium">
                    Contact and plate changes also apply to {affected.length}{' '}
                    other{' '}
                    {affected.length === 1 ? 'reservation' : 'reservations'}.
                  </p>
                  <p className="mt-1">
                    This customer&rsquo;s record is shared across their
                    bookings. Saving a name, email, phone, or plate here also
                    changes{' '}
                    <span className="font-medium tabular-nums">
                      {affected.map((row) => row.booking_code).join(', ')}
                    </span>
                    . The time, space, and price change only on this
                    reservation.
                  </p>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Customer name">
                  <Input
                    required
                    value={customerName}
                    onChange={(event) => setCustomerName(event.target.value)}
                  />
                </Field>
                <Field label="License plate">
                  <Input
                    required={details.licensePlate !== null}
                    disabled={details.licensePlate === null}
                    value={licensePlate}
                    onChange={(event) => setLicensePlate(event.target.value)}
                    className="uppercase tabular-nums"
                    placeholder={
                      details.licensePlate === null ? 'No vehicle assigned' : ''
                    }
                  />
                </Field>
                <Field label="Email (optional)">
                  <Input
                    type="email"
                    value={customerEmail}
                    onChange={(event) => setCustomerEmail(event.target.value)}
                  />
                </Field>
                <Field label="Phone (optional)">
                  <Input
                    type="tel"
                    value={customerPhone}
                    onChange={(event) => setCustomerPhone(event.target.value)}
                  />
                </Field>
              </div>
              <Field label="Correction reason">
                <Input
                  required
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. customer called with corrected arrival"
                />
              </Field>
              {spaces.length === 0 && !error && (
                <p className="text-sm text-muted-foreground">
                  No active spaces are configured for this facility.
                </p>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || spaces.length === 0}>
                  {busy ? 'Saving…' : 'Save correction'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
