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

type RawReservation = {
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
}

/**
 * Reservations for one facility filtered by status, joined to their space,
 * zone, customer, and vehicle labels. Staff RLS scopes every table to the
 * caller's org. Labels are resolved with explicit `in()` lookups rather than
 * PostgREST embedding, which is unreliable across the composite tenant FKs.
 */
export async function loadFacilityReservations(
  facilityId: string,
  statuses: string[],
): Promise<AttendantReservation[]> {
  const { data, error } = await supabase
    .from('reservations')
    .select(
      'id, booking_code, space_id, customer_id, vehicle_id, during, status, total_cents, currency, checked_in_at',
    )
    .eq('facility_id', facilityId)
    .in('status', statuses)
    .order('during', { ascending: true })
  if (error) throw error

  const rows = (data ?? []) as RawReservation[]
  if (rows.length === 0) return []

  const spaceIds = [...new Set(rows.map((r) => r.space_id))]
  const customerIds = [...new Set(rows.map((r) => r.customer_id))]
  const vehicleIds = [...new Set(rows.map((r) => r.vehicle_id).filter(Boolean))] as string[]

  const [spaces, customers, vehicles] = await Promise.all([
    supabase.from('spaces').select('id, space_number, zone_id').in('id', spaceIds),
    supabase.from('customers').select('id, full_name').in('id', customerIds),
    vehicleIds.length
      ? supabase.from('vehicles').select('id, license_plate').in('id', vehicleIds)
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
