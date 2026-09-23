import type { SupabaseClient } from '@supabase/supabase-js'
import {
  reservationQuery,
  type ReservationRecord,
} from './reservation-queries.ts'

export type Customer = {
  id: string
  org_id: string
  full_name: string
  email: string | null
  phone: string | null
  created_at: string
}
export type CustomerVehicle = {
  id: string
  org_id: string
  customer_id: string | null
  license_plate: string | null
  make: string | null
  model: string | null
  color: string | null
  year: number | null
}
export type CustomerPayment = {
  id: string
  org_id: string
  reservation_id: string
  amount_cents: number
  status: string
  refunded_cents?: number | null
}

export async function readPages<T>(
  query: (
    start: number,
    end: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const result: T[] = []
  for (let offset = 0; ; offset += 200) {
    const { data, error } = await query(offset, offset + 199)
    if (error) throw new Error(error.message)
    if (!data) throw new Error('The server returned no data.')
    result.push(...data)
    if (data.length < 200) return result
  }
}

function requireOrg(orgId: string) {
  if (!orgId) throw new Error('An organization is required.')
}

export function loadCustomers(client: SupabaseClient, orgId: string) {
  requireOrg(orgId)
  return readPages<Customer>((start, end) =>
    client
      .from('customers')
      .select('id, org_id, full_name, email, phone, created_at')
      .eq('org_id', orgId)
      .is('archived_at', null)
      .order('full_name')
      .order('id')
      .range(start, end),
  )
}

export async function loadCustomer(
  client: SupabaseClient,
  orgId: string,
  customerId: string,
) {
  requireOrg(orgId)
  const { data, error } = await client
    .from('customers')
    .select('id, org_id, full_name, email, phone, created_at')
    .eq('org_id', orgId)
    .eq('id', customerId)
    .is('archived_at', null)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as Customer | null
}

export function loadCustomerVehicles(
  client: SupabaseClient,
  orgId: string,
  customerId?: string,
) {
  requireOrg(orgId)
  return readPages<CustomerVehicle>((start, end) => {
    let query = client
      .from('vehicles')
      .select(
        'id, org_id, customer_id, license_plate, make, model, color, year',
      )
      .eq('org_id', orgId)
      .is('archived_at', null)
      .order('id')
    if (customerId) query = query.eq('customer_id', customerId)
    return query.range(start, end)
  })
}

export function loadCustomerBookings(
  client: SupabaseClient,
  orgId: string,
  customerId: string,
) {
  return readPages<ReservationRecord>((start, end) =>
    reservationQuery(client, orgId)
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .order('id')
      .range(start, end),
  )
}

/** Read both ledgers, retaining refund amounts as well as payment state. */
export async function loadCustomerPayments(
  client: SupabaseClient,
  orgId: string,
  reservationIds: string[],
  table: 'payments' | 'booth_payments',
) {
  requireOrg(orgId)
  const rows: CustomerPayment[] = []
  for (let index = 0; index < reservationIds.length; index += 100) {
    rows.push(
      ...(await readPages<CustomerPayment>((start, end) =>
        (table === 'payments'
          ? client
              .from('payments')
              .select(
                'id, org_id, reservation_id, amount_cents, status, refunded_cents',
              )
          : client
              .from('booth_payments')
              .select('id, org_id, reservation_id, amount_cents, status')
        )
          .eq('org_id', orgId)
          .in('reservation_id', reservationIds.slice(index, index + 100))
          .order('id')
          .range(start, end),
      )),
    )
  }
  return rows
}

export function searchCustomers(
  customers: Customer[],
  vehicles: CustomerVehicle[],
  search: string,
) {
  const term = search.trim().toLocaleLowerCase()
  if (!term) return customers
  const plateTerm = term.replace(/[\s-]/g, '')
  const phoneTerm = /^[+\d\s().-]+$/.test(term) ? term.replace(/\D/g, '') : ''
  const matchedVehicles = new Set(
    vehicles
      .filter((vehicle) =>
        vehicle.license_plate
          ?.toLocaleLowerCase()
          .replace(/[\s-]/g, '')
          .includes(plateTerm),
      )
      .map((vehicle) => vehicle.customer_id),
  )
  return customers.filter(
    (customer) =>
      [customer.full_name, customer.email, customer.phone].some((value) =>
        value?.toLocaleLowerCase().includes(term),
      ) ||
      (phoneTerm.length > 0 &&
        customer.phone?.replace(/\D/g, '').includes(phoneTerm)) ||
      matchedVehicles.has(customer.id),
  )
}

export function bookingPayment(total: number, payments: CustomerPayment[]) {
  const needsReconciliation = payments.some(
    (payment) =>
      payment.status === 'partially_refunded' &&
      (payment.refunded_cents == null || payment.refunded_cents === 0),
  )
  const paid = payments
    .filter((payment) =>
      ['succeeded', 'partially_refunded'].includes(payment.status),
    )
    .reduce(
      (sum, payment) =>
        sum +
        (payment.status === 'partially_refunded' && !payment.refunded_cents
          ? 0
          : payment.amount_cents - (payment.refunded_cents ?? 0)),
      0,
    )
  const pending = payments
    .filter((payment) => payment.status === 'pending')
    .reduce((sum, payment) => sum + payment.amount_cents, 0)
  return {
    paid,
    pending,
    needsReconciliation,
    due: needsReconciliation ? 0 : Math.max(0, total - paid - pending),
    refunded: payments.some(
      (payment) =>
        payment.status === 'refunded' ||
        payment.status === 'partially_refunded',
    ),
  }
}
