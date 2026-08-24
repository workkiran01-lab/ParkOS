// QR layout geometry: a module matrix -> the rectangles pdf-lib draws.
//
// Import-free on purpose, exactly like receipt-content.ts, so qr.test.ts can
// check it under any TS runner without pulling in an encoder or a PDF. The
// encoding itself lives in receipt-pdf.ts, which already imports npm packages.

export type QrRect = { x: number; y: number; w: number; h: number }

/**
 * Lay a square dark-module matrix out inside the `size`-pt box whose
 * bottom-left corner is (x, y).
 *
 * Two things this has to get right. PDF's origin is bottom-left while the
 * matrix's row 0 is its top row, so rows are flipped. And horizontal runs of
 * dark modules are merged into one rectangle apiece, which cuts the drawn
 * object count several-fold for nothing.
 */
export function qrRects(
  matrix: boolean[][],
  x: number,
  y: number,
  size: number,
): QrRect[] {
  const count = matrix.length
  const module = size / count
  const rects: QrRect[] = []

  for (let row = 0; row < count; row++) {
    let col = 0
    while (col < count) {
      if (!matrix[row][col]) {
        col++
        continue
      }
      let end = col
      while (end + 1 < count && matrix[row][end + 1]) end++
      rects.push({
        x: x + col * module,
        y: y + size - (row + 1) * module,
        w: (end - col + 1) * module,
        h: module,
      })
      col = end + 1
    }
  }

  return rects
}
