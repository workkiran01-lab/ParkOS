// Renders a receipt PDF with pdf-lib. All numbers/strings come pre-formatted
// from buildReceiptContent — this file only lays them out, so the money logic
// stays in the tested pure module.
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@^1.17.1'
import qrcode from 'npm:qrcode-generator@1.4.4'
import { buildReceiptContent, type ReceiptInput } from './receipt-content.ts'
import { qrRects } from './qr.ts'

const PAGE = { width: 612, height: 792 } // US Letter
const MARGIN = 56
const QR_SIZE = 84
const ink = rgb(0.1, 0.11, 0.13)
const muted = rgb(0.42, 0.45, 0.5)
const rule = rgb(0.85, 0.86, 0.88)

/**
 * Dark-module matrix for `text`. qrcode-generator is ~10KB with zero
 * dependencies and returns a plain module grid — no canvas, no PNG encoder.
 * pdf-lib draws the modules as vector rectangles, so the code stays sharp at
 * any print size and nothing heavier needs installing.
 */
function qrMatrix(text: string): boolean[][] {
  // 0 = auto-pick the smallest type that fits. 'M' (~15% recovery) survives a
  // folded or smudged printout without inflating the module count.
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => qr.isDark(row, col)),
  )
}

export async function renderReceiptPdf(input: ReceiptInput): Promise<Uint8Array> {
  const content = buildReceiptContent(input)

  const doc = await PDFDocument.create()
  doc.setTitle(`Receipt ${content.receiptNumber} · ${content.bookingCode}`)
  const page = doc.addPage([PAGE.width, PAGE.height])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const left = MARGIN
  const right = PAGE.width - MARGIN
  let y = PAGE.height - MARGIN

  const text = (
    s: string,
    x: number,
    yy: number,
    size: number,
    f = font,
    color = ink,
  ) => page.drawText(s, { x, y: yy, size, font: f, color })

  const rightText = (
    s: string,
    xRight: number,
    yy: number,
    size: number,
    f = font,
    color = ink,
  ) => text(s, xRight - f.widthOfTextAtSize(s, size), yy, size, f, color)

  // Header
  text('RECEIPT', left, y, 22, bold)
  rightText(content.receiptNumber, right, y + 2, 12, bold)
  rightText(`Issued ${content.issuedOn}`, right, y - 12, 9, font, muted)
  y -= 40

  // Booking code + QR. The code is what a customer reads out on the phone and
  // what an attendant types into the booth search, so it carries the largest
  // type on the page after the word RECEIPT. The QR encodes the check-in URL
  // (or the bare code when no app origin is configured — see buildQrPayload).
  const qrTop = y + 8
  const qrBottom = qrTop - QR_SIZE
  for (const r of qrRects(
    qrMatrix(content.qrPayload),
    right - QR_SIZE,
    qrBottom,
    QR_SIZE,
  )) {
    page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: ink })
  }
  if (content.qrPayload.startsWith('http')) {
    const caption = 'Scan to check in'
    text(
      caption,
      right - QR_SIZE / 2 - font.widthOfTextAtSize(caption, 8) / 2,
      qrBottom - 11,
      8,
      font,
      muted,
    )
  }

  text('BOOKING CODE', left, y, 9, bold, muted)
  y -= 26
  text(content.bookingCode, left, y, 22, bold)

  // Clear the QR block before the next section, whichever ran taller.
  y = qrBottom - 26

  // Facility + parties
  text(content.facilityName, left, y, 13, bold)
  y -= 15
  text(content.location, left, y, 10, font, muted)
  y -= 15
  text(`Billed to: ${content.customerName}`, left, y, 10, font, muted)
  y -= 28

  // Table header
  const amountCol = right
  text('DATE', left, y, 9, bold, muted)
  text('DETAIL', left + 150, y, 9, bold, muted)
  rightText('AMOUNT', amountCol, y, 9, bold, muted)
  y -= 8
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: rule })
  y -= 18

  // Rows
  for (const row of content.rows) {
    text(row.when, left, y, 10)
    if (row.detail) text(row.detail, left + 150, y, 10, font, muted)
    rightText(row.amount, amountCol, y, 10)
    y -= 20
    if (y < MARGIN + 60) break // single-page guard; reservations span a handful of days
  }

  // Total
  y -= 4
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: rule })
  y -= 22
  text('Total', left, y, 12, bold)
  rightText(`${content.total} ${content.currency}`, amountCol, y, 12, bold)

  // Footer
  text(
    'Thank you. This receipt was generated automatically on successful payment.',
    left,
    MARGIN,
    8,
    font,
    muted,
  )

  return await doc.save()
}
