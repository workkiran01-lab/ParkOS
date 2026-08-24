// Pure receipt derivation: JSONB price_breakdown -> the exact rows and totals a
// receipt shows. Kept import-free so it runs under any TS runner and the
// "numbers match the breakdown, no rounding drift, no missing line items"
// invariant has a real test (see receipt-content.test.ts). The PDF renderer
// (receipt-pdf.ts) only draws the strings this produces.

export type PriceLineItem = {
  date?: string
  start?: string
  end?: string
  hours?: number
  hourly_rate_cents?: number
  subtotal_cents?: number
}

export type PriceBreakdown = {
  currency?: string
  line_items?: PriceLineItem[]
  total_cents?: number
}

export type ReceiptInput = {
  receiptNumber: string
  bookingCode: string
  /** Origin of the customer-facing app, '' when PUBLIC_APP_URL is unset. */
  appBaseUrl: string
  facilityName: string
  spaceNumber: string
  zoneName: string
  customerName: string
  timezone: string
  createdAt: string // ISO
  currency: string
  totalCents: number // authoritative, from the reservation row
  breakdown: PriceBreakdown
}

export type ReceiptRow = {
  when: string
  detail: string
  amount: string
}

export type ReceiptContent = {
  receiptNumber: string
  bookingCode: string
  /** What the printed QR encodes. */
  qrPayload: string
  issuedOn: string
  facilityName: string
  location: string
  customerName: string
  rows: ReceiptRow[]
  total: string
  currency: string
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || 'USD').toUpperCase(),
  }).format(cents / 100)
}

function formatDay(value: string | undefined, timezone: string): string {
  if (!value) return '—'
  const date = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: timezone || 'UTC',
  }).format(date)
}

function formatHours(hours: number | undefined): string {
  if (typeof hours !== 'number' || Number.isNaN(hours)) return ''
  // Trim trailing zeros: 2.0000 -> "2", 1.5000 -> "1.5".
  return `${Number(hours.toFixed(4))} hr`
}

/**
 * What the QR encodes: a check-in URL a phone camera can act on directly.
 *
 * Without a configured origin there is no honest absolute URL to bake into a
 * PDF that outlives this deploy, so it falls back to the bare booking code —
 * still scannable, just not tappable. Same shape of degradation as a missing
 * RESEND_API_KEY: the receipt is never blocked on configuration.
 */
export function buildQrPayload(appBaseUrl: string, bookingCode: string): string {
  const origin = appBaseUrl.trim().replace(/\/+$/, '')
  return origin ? `${origin}/checkin/${bookingCode}` : bookingCode
}

/**
 * Build the printable content. The line rows are derived purely from the stored
 * breakdown; the total is the reservation's authoritative total_cents. If the
 * summed line items disagree with that total, `totalMismatch` is set so the
 * caller/test can catch a data problem instead of silently drifting.
 */
export function buildReceiptContent(input: ReceiptInput): ReceiptContent & {
  summedCents: number
  totalMismatch: boolean
} {
  const items = input.breakdown.line_items ?? []
  const rows: ReceiptRow[] = items.map((item) => {
    const rate =
      typeof item.hourly_rate_cents === 'number'
        ? `${formatMoney(item.hourly_rate_cents, input.currency)}/hr`
        : ''
    const hours = formatHours(item.hours)
    const detail = [hours, rate].filter(Boolean).join(' · ')
    return {
      when: formatDay(item.date ?? item.start, input.timezone),
      detail,
      amount: formatMoney(item.subtotal_cents ?? 0, input.currency),
    }
  })

  const summedCents = items.reduce(
    (sum, item) => sum + (item.subtotal_cents ?? 0),
    0,
  )

  return {
    receiptNumber: input.receiptNumber,
    bookingCode: input.bookingCode,
    qrPayload: buildQrPayload(input.appBaseUrl, input.bookingCode),
    issuedOn: formatDay(input.createdAt, input.timezone),
    facilityName: input.facilityName,
    location: `Space ${input.spaceNumber} · ${input.zoneName}`,
    customerName: input.customerName,
    rows,
    total: formatMoney(input.totalCents, input.currency),
    currency: input.currency.toUpperCase(),
    summedCents,
    totalMismatch: summedCents !== input.totalCents,
  }
}
