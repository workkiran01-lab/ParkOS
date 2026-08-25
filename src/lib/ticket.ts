// The stub mark: the little bar pattern printed on a ticket stub.
//
// Derived from the booking code, so one booking always draws the same mark and
// two bookings draw different ones. It is a visual motif, NOT a scannable
// symbology — the code is printed as text beside it, and that text is the real
// payload for both attendants and screen readers.
//
// ponytail: deterministic stripes, not a real barcode. The booking-code
// alphabet (23456789ABCDEFGHJKMNPQRSTUVWXYZ plus the PKS- prefix) is a subset
// of Code 39, so swap in a Code 39 encoder here if a scanner ever needs to read
// it. Nothing else has to change.

export type StubBar = { x: number; w: number }

/** Bar geometry for a code, in abstract units. Feed `width` to the viewBox. */
export function stubBars(code: string): { bars: StubBar[]; width: number } {
  const bars: StubBar[] = []
  let x = 0

  for (const character of code.toUpperCase().replace(/[^0-9A-Z]/g, '')) {
    const n = character.charCodeAt(0)
    const w = 1 + (n % 3) // 1-3 units of bar
    bars.push({ x, w })
    x += w + 1 + ((n >> 2) % 2) // then 1-2 units of gap
  }

  // A zero width is an invalid viewBox, which renders nothing at all.
  return { bars, width: Math.max(x, 1) }
}
