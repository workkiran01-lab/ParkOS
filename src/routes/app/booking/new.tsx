/**
 * New Booking — staff-facing creation of a SCHEDULED reservation.
 *
 * The gap this fills: book/$facilityId is customer-facing, and the attendant
 * walk-in flow creates AND immediately checks in, so neither can book ahead.
 *
 * Everything atomic happens in public.create_reservation(space, customer,
 * vehicle, start, end) — it prices the window, inserts the reservation, and
 * inserts the exclusion-protected space_hold in ONE transaction. A direct
 * insert into `reservations` would skip the hold and let the space be
 * double-booked, so this never writes that table directly.
 *
 * WHY VEHICLE IS REQUIRED HERE even though reservations.vehicle_id is nullable:
 * `reservations` has ZERO RLS UPDATE policies, so no client can ever change a
 * reservation row after it exists — a client UPDATE silently affects 0 rows
 * rather than erroring, because table-level UPDATE is granted to authenticated
 * while RLS denies every row. A reservation created without a vehicle would
 * therefore never be able to get one. See docs/roadmap.md.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import type { QuoteBreakdown } from '@/components/facility/PricingSection'
import { PageHeader, SectionCard } from '@/components/layout/PagePrimitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PageSpinner } from '@/components/ui/Spinner'
import { useFacility } from '@/hooks/useFacility'
import { useRole } from '@/hooks/useRole'
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

/** find_available_spaces returns SETOF spaces — the whole row. */
type SpaceRow = {
  id: string
  zone_id: string
  space_number: string
  space_type: string
}
type ZoneRow = { id: string; name: string }
type CustomerOption = {
  id: string
  full_name: string
  email: string | null
  phone: string | null
}
type VehicleOption = {
  id: string
  license_plate: string
  make: string | null
  model: string | null
}

export const Route = createFileRoute('/app/booking/new')({
  component: NewBooking,
})

function NewBooking() {
  const navigate = useNavigate()
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const { facilities, facilityId, loading: facilitiesLoading } = useFacility()

  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  const [spaces, setSpaces] = useState<SpaceRow[] | null>(null)
  const [zones, setZones] = useState<ZoneRow[]>([])
  const [spaceId, setSpaceId] = useState('')
  const [searching, setSearching] = useState(false)

  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [customerId, setCustomerId] = useState('')
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [addingCustomer, setAddingCustomer] = useState(false)

  const [vehicles, setVehicles] = useState<VehicleOption[]>([])
  const [vehicleId, setVehicleId] = useState('')
  const [newPlate, setNewPlate] = useState('')
  const [newMakeModel, setNewMakeModel] = useState('')
  const [newColor, setNewColor] = useState('')
  const [addingVehicle, setAddingVehicle] = useState(false)

  const [quote, setQuote] = useState<QuoteBreakdown | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{
    bookingCode: string
    totalCents: number
  } | null>(null)

  const allowed = role === 'admin' || role === 'manager' || role === 'attendant'
  const facility = facilities.find((option) => option.id === facilityId)

  useEffect(() => {
    if (!facility?.timezone) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return
      setError(null)
      try {
        setStart(
          instantToFacilityInput(
            new Date(Date.now() + 3_600_000),
            facility.timezone,
          ),
        )
        setEnd(
          instantToFacilityInput(
            new Date(Date.now() + 10_800_000),
            facility.timezone,
          ),
        )
      } catch (caught) {
        setStart('')
        setEnd('')
        setError(
          caught instanceof FacilityTimeError
            ? caught.message
            : 'The facility timezone could not be loaded.',
        )
      }
      setSpaces(null)
      setSpaceId('')
      setQuote(null)
    })
    return () => {
      cancelled = true
    }
  }, [facility?.id, facility?.timezone])

  // --- Customer picker -----------------------------------------------------
  // NOTE: this dropdown + inline-add pattern is DUPLICATED from IssuePermit in
  // src/routes/app/permits.tsx (loadCustomers / addCustomer). Copied rather
  // than extracted to keep permits.tsx out of this change. If you consolidate
  // these into a shared CustomerPicker, both call sites need updating.
  const loadCustomers = useCallback(async () => {
    if (!orgId) return
    const { data, error: loadError } = await supabase
      .from('customers')
      .select('id, full_name, email, phone')
      .eq('org_id', orgId)
      .is('archived_at', null)
      .order('full_name')
    if (loadError) {
      setError(friendlyError(loadError, 'Could not load customers.'))
      return
    }
    setCustomers((data ?? []) as CustomerOption[])
  }, [orgId])

  useEffect(() => {
    if (!roleLoading) void Promise.resolve().then(loadCustomers)
  }, [loadCustomers, roleLoading])

  // Vehicles are scoped to the SELECTED customer: create_reservation rejects a
  // vehicle whose customer_id or org_id does not match (VEHICLE_NOT_FOUND).
  const loadVehicles = useCallback(async () => {
    if (!customerId) {
      setVehicles([])
      return
    }
    const { data, error: loadError } = await supabase
      .from('vehicles')
      .select('id, license_plate, make, model')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .order('license_plate')
    if (loadError) {
      setError(
        friendlyError(loadError, 'Could not load the customer’s vehicles.'),
      )
      return
    }
    setVehicles((data ?? []) as VehicleOption[])
  }, [customerId])

  useEffect(() => {
    void Promise.resolve().then(loadVehicles)
  }, [loadVehicles])

  function pickCustomer(value: string) {
    setCustomerId(value)
    // Reset the vehicle whenever the customer changes — a stale vehicle_id
    // from the previous customer would fail create_reservation's ownership
    // check, and silently picking one for them would be worse.
    setVehicleId('')
    setNewPlate('')
    setNewMakeModel('')
    setNewColor('')
    setError(null)
  }

  async function addCustomer() {
    if (!orgId) return
    const validationError = validateNewCustomer({
      name: newName,
      email: newEmail,
      phone: newPhone,
    })
    if (validationError) {
      setError(validationError)
      return
    }
    setAddingCustomer(true)
    setError(null)
    const { data, error: insertError } = await supabase
      .from('customers')
      .insert({
        org_id: orgId,
        full_name: newName.trim(),
        email: newEmail.trim() || null,
        phone: newPhone.trim() || null,
      })
      .select('id, full_name, email, phone')
      .single()
    setAddingCustomer(false)
    if (insertError || !data) {
      setError(friendlyError(insertError, 'Could not create the customer.'))
      return
    }
    setCustomers((current) => [...current, data as CustomerOption])
    pickCustomer(data.id)
    setNewName('')
    setNewEmail('')
    setNewPhone('')
    toast.success('Customer added')
  }

  async function addVehicle() {
    if (!customerId || !orgId) return
    const validationError = validatePlate(newPlate)
    if (validationError) {
      setError(validationError)
      return
    }
    setAddingVehicle(true)
    setError(null)
    const [make, ...model] = newMakeModel.trim().split(' ')
    const { data, error: insertError } = await supabase
      .from('vehicles')
      .insert({
        org_id: orgId,
        customer_id: customerId,
        license_plate: normalizePlate(newPlate),
        make: make || null,
        model: model.join(' ') || null,
        color: newColor.trim() || null,
      })
      .select('id, license_plate, make, model')
      .single()
    setAddingVehicle(false)
    if (insertError || !data) {
      setError(friendlyError(insertError, 'Could not save the vehicle.'))
      return
    }
    setVehicles((current) => [...current, data as VehicleOption])
    setVehicleId(data.id)
    setNewPlate('')
    setNewMakeModel('')
    setNewColor('')
    toast.success('Vehicle added')
  }

  // --- Space search --------------------------------------------------------
  async function findSpaces() {
    if (!facilityId || !facility) {
      setError('Choose a facility before searching for a space.')
      return
    }
    let window
    try {
      window = parseFacilityWindow(start, end, facility.timezone)
    } catch (caught) {
      setError(
        caught instanceof FacilityTimeError
          ? caught.message
          : 'Enter a valid arrival and departure.',
      )
      return
    }
    setSearching(true)
    setError(null)
    setSpaces(null)
    setSpaceId('')
    setQuote(null)

    const [spacesResult, zonesResult] = await Promise.all([
      supabase.rpc('find_available_spaces', {
        p_facility_id: facilityId,
        p_start: window.startIso,
        p_end: window.endIso,
      }),
      supabase.from('zones').select('id, name').eq('facility_id', facilityId),
    ])
    setSearching(false)
    if (spacesResult.error) {
      setError(
        friendlyError(spacesResult.error, 'Could not load available spaces.'),
      )
      return
    }
    if (zonesResult.error) {
      setError(
        friendlyError(zonesResult.error, 'Could not load facility zones.'),
      )
      return
    }
    setZones((zonesResult.data ?? []) as ZoneRow[])
    setSpaces((spacesResult.data ?? []) as SpaceRow[])
  }

  async function priceSpace(id: string) {
    if (!facility) return
    let window
    try {
      window = parseFacilityWindow(start, end, facility.timezone)
    } catch (caught) {
      setError(
        caught instanceof FacilityTimeError
          ? caught.message
          : 'Enter a valid arrival and departure.',
      )
      return
    }
    setSpaceId(id)
    setQuote(null)
    setQuoting(true)
    setError(null)
    const { data, error: quoteError } = await supabase.rpc(
      'quote_reservation',
      {
        p_space_id: id,
        p_start: window.startIso,
        p_end: window.endIso,
      },
    )
    setQuoting(false)
    if (quoteError) {
      setError(friendlyError(quoteError, 'Could not price that space.'))
      return
    }
    setQuote(data as QuoteBreakdown)
  }

  // --- Create --------------------------------------------------------------
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!facilityId || !facility) {
      setError('Choose a facility first.')
      return
    }
    if (!spaceId || !customerId || !vehicleId || !quote) {
      setError('Pick and price a space, a customer, and a vehicle first.')
      return
    }
    let window
    try {
      window = parseFacilityWindow(start, end, facility.timezone)
    } catch (caught) {
      setError(
        caught instanceof FacilityTimeError
          ? caught.message
          : 'Enter a valid arrival and departure.',
      )
      return
    }
    setSubmitting(true)
    setError(null)
    const { data, error: createError } = await supabase.rpc(
      'create_reservation',
      {
        p_space_id: spaceId,
        p_customer_id: customerId,
        p_vehicle_id: vehicleId,
        p_start: window.startIso,
        p_end: window.endIso,
      },
    )
    if (createError) {
      setSubmitting(false)
      setError(
        createError.message === 'SPACE_UNAVAILABLE'
          ? 'That space was just taken for this window. Search again and pick another.'
          : createError.message === 'OUTSIDE_OPERATING_HOURS'
            ? 'That window is outside this facility’s operating hours.'
            : friendlyError(
                createError,
                'The reservation could not be created.',
              ),
      )
      return
    }
    const row = (data as { reservation_id: string; total_cents: number }[])[0]
    if (!row) {
      setSubmitting(false)
      setError(
        'The server did not return the created reservation. Check Reservations before retrying.',
      )
      return
    }
    const { data: reservation, error: codeError } = await supabase
      .from('reservations')
      .select('booking_code')
      .eq('id', row.reservation_id)
      .single()
    setSubmitting(false)
    if (codeError || !reservation?.booking_code) {
      setError(
        'The reservation was created, but its booking code could not be loaded. Open Reservations to retrieve it; do not create a duplicate.',
      )
      return
    }
    setCreated({
      bookingCode: reservation.booking_code,
      totalCents: row.total_cents,
    })
    toast.success('Reservation created')
  }

  if (roleLoading || facilitiesLoading) return <PageSpinner />
  if (!allowed)
    return (
      <p className="text-sm text-muted-foreground">
        You do not have access to create bookings.
      </p>
    )

  if (created) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Booking"
          title="Reservation created"
          description="The space is held and the reservation is pending."
        />
        <SectionCard
          title="Booking code"
          description="Give this code to the customer for check-in."
        >
          <div className="space-y-4 px-4 py-5 sm:px-5">
            <p className="font-mono text-3xl font-semibold tracking-wider">
              {created.bookingCode}
            </p>
            <p className="text-sm text-muted-foreground">
              {dollars(created.totalCents)} pending
            </p>
            <Button onClick={() => navigate({ to: '/app/reservations' })}>
              Open reservations
            </Button>
          </div>
        </SectionCard>
      </div>
    )
  }

  const zoneName = new Map(zones.map((z) => [z.id, z.name]))
  const grouped = groupByZone(spaces ?? [], zoneName)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Booking"
        title="New booking"
        description={`Schedule a reservation at ${facility?.name ?? 'the selected facility'}. It is created as pending — collect payment or confirm it from Reservations.`}
      />

      <form onSubmit={submit} className="space-y-6">
        <SectionCard
          title="Window"
          description={`Times use ${facility?.timezone ?? 'the facility timezone'}. Pick the reserved period, then search for free spaces.`}
        >
          <div className="flex flex-wrap items-end gap-3 px-4 py-4 sm:px-5">
            <Field label="Start">
              <Input
                type="datetime-local"
                value={start}
                onChange={(event) => {
                  setStart(event.target.value)
                  setSpaces(null)
                  setSpaceId('')
                  setQuote(null)
                }}
              />
            </Field>
            <Field label="End">
              <Input
                type="datetime-local"
                value={end}
                onChange={(event) => {
                  setEnd(event.target.value)
                  setSpaces(null)
                  setSpaceId('')
                  setQuote(null)
                }}
              />
            </Field>
            <Button
              type="button"
              variant="outline"
              disabled={searching || !facilityId}
              onClick={findSpaces}
            >
              {searching ? 'Searching…' : 'Find available spaces'}
            </Button>
          </div>
        </SectionCard>

        {spaces && (
          <SectionCard
            title="Space"
            description={
              spaces.length === 0
                ? 'Nothing is free for that window.'
                : `${spaces.length} available. Selecting one prices it.`
            }
          >
            <div className="space-y-4 px-4 py-4 sm:px-5">
              {grouped.map(([zone, rows]) => (
                <div key={zone}>
                  <p className="signage-label mb-1.5 text-muted-foreground">
                    {zone}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {rows.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => priceSpace(s.id)}
                        className={`rounded-md border px-3 py-2 text-sm font-medium tabular-nums ${
                          spaceId === s.id
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'bg-background hover:bg-muted'
                        }`}
                      >
                        {s.space_number}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {quoting && (
                <p className="text-sm text-muted-foreground">Pricing…</p>
              )}
              {quote && (
                <p className="flex justify-between border-t pt-3 text-sm">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-medium tabular-nums">
                    {dollars(quote.total_cents)} {quote.currency}
                  </span>
                </p>
              )}
            </div>
          </SectionCard>
        )}

        <SectionCard
          title="Customer"
          description="Choose an existing customer or add one."
        >
          <div className="space-y-4 px-4 py-4 sm:px-5">
            <Field label="Customer">
              <Select value={customerId} onValueChange={pickCustomer}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.full_name}
                      {c.email ? ` · ${c.email}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-4">
              <Field label="New customer name">
                <Input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Jane Doe"
                />
              </Field>
              <Field label="Email (optional)">
                <Input
                  type="email"
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                />
              </Field>
              <Field label="Phone (optional)">
                <Input
                  type="tel"
                  value={newPhone}
                  onChange={(event) => setNewPhone(event.target.value)}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={addingCustomer || !newName.trim()}
                  onClick={addCustomer}
                >
                  {addingCustomer ? 'Adding…' : 'Add customer'}
                </Button>
              </div>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Vehicle"
          description="Required — a reservation cannot be given a vehicle after it is created."
        >
          <div className="space-y-4 px-4 py-4 sm:px-5">
            {!customerId ? (
              <p className="text-sm text-muted-foreground">
                Choose a customer first.
              </p>
            ) : (
              <>
                <Field label="Vehicle">
                  <Select value={vehicleId} onValueChange={setVehicleId}>
                    <SelectTrigger className="w-full">
                      <SelectValue
                        placeholder={
                          vehicles.length
                            ? 'Choose vehicle'
                            : 'No vehicles on file — add one below'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {vehicles.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.license_plate}
                          {v.make
                            ? ` · ${[v.make, v.model].filter(Boolean).join(' ')}`
                            : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-4">
                  <Field label="Plate">
                    <Input
                      value={newPlate}
                      onChange={(event) => setNewPlate(event.target.value)}
                      placeholder="7ABC123"
                      className="uppercase tabular-nums"
                    />
                  </Field>
                  <Field label="Make and model (optional)">
                    <Input
                      value={newMakeModel}
                      onChange={(event) => setNewMakeModel(event.target.value)}
                      placeholder="Toyota Corolla"
                    />
                  </Field>
                  <Field label="Color (optional)">
                    <Input
                      value={newColor}
                      onChange={(event) => setNewColor(event.target.value)}
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={addingVehicle || !newPlate.trim()}
                      onClick={addVehicle}
                    >
                      {addingVehicle ? 'Adding…' : 'Add vehicle'}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </SectionCard>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={
              submitting || !quote || !spaceId || !customerId || !vehicleId
            }
          >
            {submitting ? 'Creating…' : 'Create booking'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Creates a pending reservation and holds the space.
          </p>
        </div>
      </form>
    </div>
  )
}

/** Group available spaces by zone name, using zone_id from SETOF spaces. */
function groupByZone(rows: SpaceRow[], zoneName: Map<string, string>) {
  const byZone = new Map<string, SpaceRow[]>()
  for (const row of rows) {
    const name = zoneName.get(row.zone_id) ?? 'Unzoned'
    const list = byZone.get(name)
    if (list) list.push(row)
    else byZone.set(name, [row])
  }
  return [...byZone.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}
