// Runnable check for the receipt derivation invariant:
//   the receipt's line rows and total match the stored breakdown exactly —
//   no rounding drift, no missing line items.
// Run: npx tsx supabase/functions/_shared/receipt-content.test.ts
import assert from 'node:assert/strict'
import {
  buildQrPayload,
  buildReceiptContent,
  formatMoney,
  type ReceiptInput,
} from './receipt-content.ts'

// A real two-day breakdown shaped like quote_reservation output (with a daily cap
// applied on day two, so subtotal != hours*rate — the case rounding bugs hide in).
const breakdown = {
  currency: 'USD',
  price_rule_id: '00000000-0000-0000-0000-000000000001',
  line_items: [
    { date: '2026-08-24', hours: 3.5, hourly_rate_cents: 450, uncapped_cents: 1575, daily_cap_cents: 2000, subtotal_cents: 1575 },
    { date: '2026-08-25', hours: 9, hourly_rate_cents: 450, uncapped_cents: 4050, daily_cap_cents: 2000, subtotal_cents: 2000 },
  ],
  total_cents: 3575,
}

const input: ReceiptInput = {
  receiptNumber: 'RCPT-000042',
  bookingCode: 'PKS-VWNP6Y',
  appBaseUrl: 'https://park.example.com',
  facilityName: 'Downtown Garage',
  spaceNumber: 'A-12',
  zoneName: 'Level 1',
  customerName: 'Test Customer',
  timezone: 'America/Los_Angeles',
  createdAt: '2026-08-25T18:30:00Z',
  currency: 'USD',
  totalCents: breakdown.total_cents,
  breakdown,
}

const content = buildReceiptContent(input)

// Every line item is represented — none dropped.
assert.equal(content.rows.length, breakdown.line_items.length, 'row per line item')

// Each rendered amount equals that line item's stored subtotal, formatted.
breakdown.line_items.forEach((item, i) => {
  assert.equal(
    content.rows[i].amount,
    formatMoney(item.subtotal_cents, 'USD'),
    `row ${i} amount matches subtotal`,
  )
})

// Summed line items equal the authoritative total — no drift, no mismatch flag.
assert.equal(content.summedCents, breakdown.total_cents, 'lines sum to total')
assert.equal(content.totalMismatch, false, 'no total mismatch')
assert.equal(content.total, '$35.75', 'total formatted from cents')

// Money formatting is cents-exact (no float artifacts).
assert.equal(formatMoney(1575, 'USD'), '$15.75')
assert.equal(formatMoney(2000, 'USD'), '$20.00')
assert.equal(formatMoney(0, 'USD'), '$0.00')

// The booking code reaches the receipt verbatim, and the QR encodes a check-in
// URL a phone camera can act on.
assert.equal(content.bookingCode, 'PKS-VWNP6Y')
assert.equal(content.qrPayload, 'https://park.example.com/checkin/PKS-VWNP6Y')

// A trailing slash on the configured origin must not produce a double slash.
assert.equal(
  buildQrPayload('https://park.example.com/', 'PKS-VWNP6Y'),
  'https://park.example.com/checkin/PKS-VWNP6Y',
)

// No configured origin: fall back to the bare code rather than baking a wrong
// absolute URL into a PDF that outlives this deploy.
assert.equal(buildQrPayload('', 'PKS-VWNP6Y'), 'PKS-VWNP6Y')
assert.equal(buildQrPayload('   ', 'PKS-VWNP6Y'), 'PKS-VWNP6Y')

console.log('receipt-content: all assertions passed')
