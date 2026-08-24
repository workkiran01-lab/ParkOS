// Sends the receipt to the customer via Resend, with the PDF attached.
//
// Attachment (not a link) is deliberate: a receipt is a permanent record the
// customer keeps, while our download links are short-lived signed URLs that
// expire. The PDF travels with the email and works forever, offline.
//
// No RESEND_API_KEY -> this is a no-op that reports skipped, so the webhook path
// still works end to end (receipt stored + downloadable) before email is set up.
import { encodeBase64 } from 'jsr:@std/encoding@^1/base64'

type SendReceiptArgs = {
  to: string
  customerName: string
  receiptNumber: string
  bookingCode: string
  facilityName: string
  pdf: Uint8Array
}

export async function sendReceiptEmail(
  args: SendReceiptArgs,
): Promise<{ sent: boolean; skipped?: string }> {
  const apiKey = Deno.env.get('RESEND_API_KEY')?.trim()
  if (!apiKey) return { sent: false, skipped: 'RESEND_API_KEY not set' }

  const from =
    Deno.env.get('RECEIPT_FROM_EMAIL')?.trim() || 'ParkOS <onboarding@resend.dev>'

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [args.to],
      subject: `Your ${args.facilityName} receipt — booking ${args.bookingCode}`,
      text:
        `Hi ${args.customerName},\n\n` +
        `Thanks for parking with ${args.facilityName}.\n\n` +
        `Booking code: ${args.bookingCode}\n` +
        `Receipt: ${args.receiptNumber}\n\n` +
        `Quote the booking code if you need to reach the parking attendant. ` +
        `Your itemized receipt is attached as a PDF.\n\n— ParkOS`,
      attachments: [
        {
          filename: `${args.receiptNumber}.pdf`,
          content: encodeBase64(args.pdf),
        },
      ],
    }),
  })

  if (!response.ok) {
    console.error(`Resend rejected the receipt email (${response.status}).`)
    return { sent: false, skipped: `resend_status_${response.status}` }
  }
  return { sent: true }
}
