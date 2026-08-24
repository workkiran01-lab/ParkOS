// Runnable check for the QR layout invariant:
//   every dark module lands inside the box, at the right place, with row 0 of
//   the matrix drawn at the TOP of the PDF box (PDF's origin is bottom-left, so
//   this flip is the easy thing to get backwards and the hard thing to notice —
//   a vertically mirrored QR still looks like a QR).
// Run: npx tsx supabase/functions/_shared/qr.test.ts
import assert from 'node:assert/strict'
import { qrRects } from './qr.ts'

const _ = false
const X = true

// row 0 is the top row.
const matrix = [
  [X, X, _, _],
  [_, _, _, _],
  [_, X, X, X],
  [X, _, _, X],
]

const BOX = { x: 10, y: 20, size: 40 }
const MODULE = BOX.size / matrix.length // 10
const rects = qrRects(matrix, BOX.x, BOX.y, BOX.size)

// Horizontal runs are merged: 7 dark modules become 4 rectangles, not 7.
assert.equal(rects.length, 4, 'runs merged into one rect each')

// Area is conserved by the merge — no module dropped, none double-drawn.
const darkCount = matrix.flat().filter(Boolean).length
assert.equal(
  rects.reduce((sum, r) => sum + r.w * r.h, 0),
  darkCount * MODULE * MODULE,
  'merged area equals total dark module area',
)

// Row 0 is drawn at the top of the box: its rect has the highest y, and its top
// edge is flush with the box's top edge.
const topRect = rects.reduce((a, b) => (a.y >= b.y ? a : b))
assert.equal(
  topRect.y + topRect.h,
  BOX.y + BOX.size,
  'row 0 sits at the box top',
)
assert.equal(topRect.x, BOX.x, 'row 0 run starts at the box left')
assert.equal(topRect.w, 2 * MODULE, 'row 0 run spans two modules')

// The three-module run in row 2 is one rect, offset one module in from the left.
const wide = rects.find((r) => r.w === 3 * MODULE)
assert.ok(wide, 'row 2 merged into a single three-module rect')
assert.equal(wide.x, BOX.x + MODULE, 'row 2 run starts at column 1')
assert.equal(
  wide.y,
  BOX.y + BOX.size - 3 * MODULE,
  'row 2 is the third row down',
)

// Row 3 is the bottom row and its two isolated modules stay separate.
const bottom = rects.filter((r) => r.y === BOX.y)
assert.equal(bottom.length, 2, 'row 3 has two separate rects')
assert.deepEqual(
  bottom.map((r) => r.x).sort((a, b) => a - b),
  [BOX.x, BOX.x + 3 * MODULE],
  'row 3 modules at columns 0 and 3',
)

// Nothing escapes the box.
for (const r of rects) {
  assert.ok(
    r.x >= BOX.x && r.x + r.w <= BOX.x + BOX.size,
    'rect within box width',
  )
  assert.ok(
    r.y >= BOX.y && r.y + r.h <= BOX.y + BOX.size,
    'rect within box height',
  )
}

// A fully dark row collapses to exactly one full-width rect.
const solid = qrRects([[X, X, X, X]], 0, 0, 40)
assert.equal(solid.length, 1)
assert.deepEqual(solid[0], { x: 0, y: 0, w: 40, h: 40 })

// An empty matrix row draws nothing.
assert.equal(qrRects([[_, _, _, _]], 0, 0, 40).length, 0)

console.log('qr: all assertions passed')
