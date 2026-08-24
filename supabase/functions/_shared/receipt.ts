// Issues the receipt for a succeeded reservation payment: record it (the row is
// the idempotency claim), render + store the PDF, email it. Best-effort by
// design — the webhook calls this after the payment is already committed, so a
// failure here must never fail the webhook (Stripe must not retry a settled
// payment). Everything is wrapped so the caller can log and move on.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.112.3'
import { renderReceiptPdf } from './receipt-pdf.ts'
import { type PriceBreakdown } from './receipt-content.ts'
import { sendReceiptEmail } from './resend.ts'

const BUCKET = 'receipts'

type ReservationDetail = {
  org_id: string
  facility_id: string
  space_id: string
  customer_id: string
  booking_code: string
  price_breakdown: PriceBreakdown
  total_cents: number
  currency: string
  facilities: { name: string; timezone: string } | null
  spaces: { space_number: string; zones: { name: string } | null } | null
  customers: { full_name: string; email: string | null } | null
}

export async function issueReceiptForPayment(
  admin: SupabaseClient,
  params: { paymentId: string; reservationId: string },
): Promise<{ issued: boolean; reason?: string }> {
  const { paymentId, reservationId } = params

  const { data, error } = await admin
    .from('reservations')
    .select(
      'org_id, facility_id, space_id, customer_id, booking_code,' +
        ' price_breakdown, total_cents, currency,' +
        ' facilities(name, timezone), spaces(space_number, zones(name)), customers(full_name, email)',
    )
    .eq('id', reservationId)
    .single()
  if (error || !data) throw error ?? new Error('reservation_not_found')
  const reservation = data as unknown as ReservationDetail

  // The row is the idempotency claim: unique(payment_id) means a duplicate
  // delivery that reaches here again just gets a conflict and stops.
  const storagePath = `${reservation.org_id}/${reservationId}.pdf`
  const { data: inserted, error: insertError } = await admin
    .from('receipts')
    .insert({
      org_id: reservation.org_id,
      reservation_id: reservationId,
      payment_id: paymentId,
      storage_path: storagePath,
    })
    .select('receipt_number')
    .single()

  if (insertError) {
    // 23505 = unique_violation: receipt already issued for this payment.
    if (insertError.code === '23505') return { issued: false, reason: 'already_issued' }
    throw insertError
  }
  const receiptNumber = inserted.receipt_number as string

  const pdf = await renderReceiptPdf({
    receiptNumber,
    bookingCode: reservation.booking_code,
    // Origin of the customer-facing app, for the QR's /checkin/{code} URL.
    // Unset -> the QR falls back to the bare code (see buildQrPayload).
    appBaseUrl: Deno.env.get('PUBLIC_APP_URL')?.trim() ?? '',
    facilityName: reservation.facilities?.name ?? 'Parking',
    spaceNumber: reservation.spaces?.space_number ?? '—',
    zoneName: reservation.spaces?.zones?.name ?? '',
    customerName: reservation.customers?.full_name ?? 'Customer',
    timezone: reservation.facilities?.timezone ?? 'UTC',
    createdAt: new Date().toISOString(),
    currency: reservation.currency,
    totalCents: reservation.total_cents,
    breakdown: reservation.price_breakdown,
  })

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true })
  if (uploadError) throw uploadError

  // Email is best-effort and independently skippable (no key / no address).
  const email = reservation.customers?.email?.trim()
  if (email) {
    const result = await sendReceiptEmail({
      to: email,
      customerName: reservation.customers?.full_name ?? 'there',
      receiptNumber,
      bookingCode: reservation.booking_code,
      facilityName: reservation.facilities?.name ?? 'ParkOS',
      pdf,
    })
    if (!result.sent) {
      console.warn(
        `Receipt ${receiptNumber}: would have emailed ${email} ` +
          `(booking ${reservation.booking_code}) — not sent: ${result.skipped}`,
      )
    }
  } else {
    console.warn(`Receipt ${receiptNumber}: customer has no email on file.`)
  }

  return { issued: true }
}
