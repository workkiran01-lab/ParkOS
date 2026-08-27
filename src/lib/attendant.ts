import { checkinState, type CheckinState } from '@/lib/checkin'
import { supabase } from '@/lib/supabase'

export type AttendantReservation = {
  id: string
  booking_code: string
  space_id: string
  customer_id: string
  vehicle_id: string | null
  during: string
  status: string
  total_cents: number
  currency: string
  checked_in_at: string | null
  space_number: string
  zone_name: string
  customer_name: string
  license_plate: string | null
}

/** The columns every reservation lookup selects before decoration. */
export const RESERVATION_COLUMNS =
  'id, booking_code, space_id, customer_id, vehicle_id, during, status, total_cents, currency, checked_in_at'

export type ReservationLabels = {
  space_number: string
  zone_name: string
  customer_name: string
  license_plate: string | null
}

type Labelled = {
  space_id: string
  customer_id: string
  vehicle_id: string | null
}

/**
 * Resolve the space, zone, customer, and vehicle labels for a set of
 * reservation rows. Staff RLS scopes every table to the caller's org. Labels
 * are resolved with explicit `in()` lookups rather than PostgREST embedding,
 * which is unreliable across the composite tenant FKs.
 */
export async function decorateReservations<Row extends Labelled>(
  rows: Row[],
): Promise<(Row & ReservationLabels)[]> {
  if (rows.length === 0) return []

  const spaceIds = [...new Set(rows.map((r) => r.space_id))]
  const customerIds = [...new Set(rows.map((r) => r.customer_id))]
  const vehicleIds = [
    ...new Set(rows.map((r) => r.vehicle_id).filter(Boolean)),
  ] as string[]

  const [spaces, customers, vehicles] = await Promise.all([
    supabase
      .from('spaces')
      .select('id, space_number, zone_id')
      .in('id', spaceIds),
    supabase.from('customers').select('id, full_name').in('id', customerIds),
    vehicleIds.length
      ? supabase
          .from('vehicles')
          .select('id, license_plate')
          .in('id', vehicleIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (spaces.error) throw spaces.error
  if (customers.error) throw customers.error
  if (vehicles.error) throw vehicles.error

  const zoneIds = [
    ...new Set((spaces.data ?? []).map((s) => s.zone_id as string)),
  ]
  const zones = zoneIds.length
    ? await supabase.from('zones').select('id, name').in('id', zoneIds)
    : { data: [], error: null }
  if (zones.error) throw zones.error

  const zoneName = new Map(
    (zones.data ?? []).map((z) => [z.id as string, z.name as string]),
  )
  const spaceInfo = new Map(
    (spaces.data ?? []).map((s) => [
      s.id as string,
      {
        number: s.space_number as string,
        zone: zoneName.get(s.zone_id as string) ?? '',
      },
    ]),
  )
  const customerName = new Map(
    (customers.data ?? []).map((c) => [c.id as string, c.full_name as string]),
  )
  const plate = new Map(
    (vehicles.data ?? []).map((v) => [
      v.id as string,
      (v.license_plate as string | null) ?? null,
    ]),
  )

  return rows.map((r) => ({
    ...r,
    space_number: spaceInfo.get(r.space_id)?.number ?? '—',
    zone_name: spaceInfo.get(r.space_id)?.zone ?? '',
    customer_name: customerName.get(r.customer_id) ?? 'Customer',
    license_plate: r.vehicle_id ? (plate.get(r.vehicle_id) ?? null) : null,
  }))
}

/** Reservations for one facility filtered by status, with their labels. */
export async function loadFacilityReservations(
  facilityId: string,
  statuses: string[],
): Promise<AttendantReservation[]> {
  const { data, error } = await supabase
    .from('reservations')
    .select(RESERVATION_COLUMNS)
    .eq('facility_id', facilityId)
    .in('status', statuses)
    .order('during', { ascending: true })
  if (error) throw error

  return decorateReservations((data ?? []) as unknown as AttendantReservation[])
}

export type CheckinFacility = { id: string; name: string; timezone: string }

export type CheckinReservation = AttendantReservation & {
  checked_out_at: string | null
  archived_at: string | null
  facility_id: string
}

export type CheckinLookup =
  | { state: 'unknown'; code: string }
  | {
      state: Exclude<CheckinState, 'unknown'>
      code: string
      reservation: CheckinReservation
      facility: CheckinFacility
      /** Cents still owed: reservation total minus booth cash and settled Stripe. */
      balanceCents: number
    }

/**
 * Find a reservation by the code printed on the receipt QR.
 *
 * Tenant scoping is RLS's job, not a filter here: a ticket from another
 * operator's lot is simply not visible, and correctly reads as `unknown`
 * rather than as someone else's booking.
 */
export async function loadReservationByCode(
  code: string,
): Promise<CheckinLookup> {
  const bookingCode = code.trim().toUpperCase()

  const { data, error } = await supabase
    .from('reservations')
    .select(`${RESERVATION_COLUMNS}, checked_out_at, archived_at, facility_id`)
    .eq('booking_code', bookingCode)
    .maybeSingle()
  if (error) throw error
  if (!data) return { state: 'unknown', code: bookingCode }

  const row = data as unknown as CheckinReservation
  const [[reservation], facility, balanceCents] = await Promise.all([
    decorateReservations([row]),
    loadCheckinFacility(row.facility_id),
    reservationBalance(row.id),
  ])

  return {
    state: checkinState(row),
    code: bookingCode,
    reservation,
    facility,
    balanceCents,
  }
}

async function loadCheckinFacility(
  facilityId: string,
): Promise<CheckinFacility> {
  const { data, error } = await supabase
    .from('facilities')
    .select('id, name, timezone')
    .eq('id', facilityId)
    .single()
  if (error) throw error
  return data as CheckinFacility
}

/** Amount still owed, from the one server-side definition of "balance". */
export async function reservationBalance(
  reservationId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('reservation_balance_cents', {
    p_reservation_id: reservationId,
  })
  if (error) throw error
  return (data as number | null) ?? 0
}

/** Server-priced overstay for a departure at this instant. */
export async function overstayAt(
  reservationId: string,
  departureAt: Date,
): Promise<number> {
  const { data, error } = await supabase.rpc('calculate_overstay', {
    p_reservation_id: reservationId,
    p_departure_at: departureAt.toISOString(),
  })
  if (error) throw error
  return (data as { overstay_cents: number }[] | null)?.[0]?.overstay_cents ?? 0
}

export type PlateMatch = {
  customer_id: string
  customer_name: string
  vehicle_id: string
  license_plate: string
  description: string
}

/** Look up an existing customer+vehicle in this org by license plate. */
export async function lookupByPlate(
  orgId: string,
  plate: string,
): Promise<PlateMatch[]> {
  const normalized = plate.trim().toUpperCase()
  if (!normalized) return []
  const { data, error } = await supabase
    .from('vehicles')
    .select('id, license_plate, customer_id, make, model, color')
    .eq('org_id', orgId)
    .is('archived_at', null)
    .ilike('license_plate', normalized)
  if (error) throw error

  const vehicles = data ?? []
  if (vehicles.length === 0) return []

  const customerIds = [...new Set(vehicles.map((v) => v.customer_id as string))]
  const { data: customers, error: cErr } = await supabase
    .from('customers')
    .select('id, full_name')
    .in('id', customerIds)
  if (cErr) throw cErr
  const names = new Map(
    (customers ?? []).map((c) => [c.id as string, c.full_name as string]),
  )

  return vehicles.map((v) => ({
    customer_id: v.customer_id as string,
    customer_name: names.get(v.customer_id as string) ?? 'Customer',
    vehicle_id: v.id as string,
    license_plate: (v.license_plate as string | null) ?? normalized,
    description: [v.color, v.make, v.model].filter(Boolean).join(' '),
  }))
}
