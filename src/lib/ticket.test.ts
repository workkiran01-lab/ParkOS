// Runnable check for the stub mark's geometry:
//   bars must never overlap (overlapping rects render as one smear, not a
//   pattern), the width must never be zero (invalid viewBox renders nothing),
//   and the same code must always draw the same mark — a stub whose mark
//   changed between renders would look like the ticket itself had changed.
// Run: npx tsx src/lib/ticket.test.ts
import assert from 'node:assert/strict'
import { stubBars } from './ticket.ts'

const code = 'PKS-Q5A6X5'

// Deterministic: the same booking always draws the same mark.
assert.deepEqual(stubBars(code), stubBars(code))

// Different bookings draw different marks.
assert.notDeepEqual(stubBars('PKS-Q5A6X5').bars, stubBars('PKS-B7C2D9').bars)

// Bars never overlap, and every bar has real width.
const { bars, width } = stubBars(code)
for (const [i, bar] of bars.entries()) {
  assert.ok(bar.w > 0, `bar ${i} has no width`)
  const next = bars[i + 1]
  if (next) assert.ok(bar.x + bar.w <= next.x, `bar ${i} overlaps bar ${i + 1}`)
}

// The viewBox width covers every bar and is never zero.
assert.ok(width >= bars[bars.length - 1].x + bars[bars.length - 1].w)
assert.ok(stubBars('').width >= 1)
assert.equal(stubBars('').bars.length, 0)

// Separators are not drawn: the hyphen in PKS- contributes no bar.
assert.equal(stubBars('PKS-Q5').bars.length, 'PKSQ5'.length)

console.log('ticket: ok')
