import type { SupabaseClient } from '@supabase/supabase-js'

export type ReservationRecord = {
  id: string
  org_id: string
  booking_code: string
  facility_id: string
  space_id: string
  customer_id: string
  vehicle_id: string | null
  during: string
  status: string
  total_cents: number
  currency: string
  checked_in_at: string | null
  checked_out_at: string | null
}

/** Shared with the existing reservation ledger. Never rely on the UI's scope. */
export function reservationQuery(client: SupabaseClient, orgId: string) {
  if (!orgId) throw new Error('An organization is required.')
  return client
    .from('reservations')
    .select(
      'id, org_id, booking_code, facility_id, space_id, customer_id, vehicle_id, during, status, total_cents, currency, checked_in_at, checked_out_at',
    )
    .eq('org_id', orgId)
}

export async function loadCalendarReservations(
  client: SupabaseClient,
  orgId: string,
  facilityId: string,
  start: string,
  end: string,
) {
  const rows: ReservationRecord[] = []
  // A fixed 500-row ledger limit would silently hide a busy calendar's bookings.
  for (let offset = 0; ; offset += 200) {
    const { data, error } = await reservationQuery(client, orgId)
      .eq('facility_id', facilityId)
      .is('archived_at', null)
      .overlaps('during', `[${start},${end})`)
      .order('id')
      .range(offset, offset + 199)
    if (error) throw error
    rows.push(...(data as ReservationRecord[]))
    if (data.length < 200) return rows
  }
}

export async function loadCalendarFacility(
  client: SupabaseClient,
  orgId: string,
  facilityId: string,
) {
  if (!orgId) throw new Error('An organization is required.')
  const { data, error } = await client
    .from('facilities')
    .select('id, name, timezone, operating_hours')
    .eq('org_id', orgId)
    .eq('id', facilityId)
    .is('archived_at', null)
    .maybeSingle()
  if (error) throw error
  return data
}
