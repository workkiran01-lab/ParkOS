import { stubBars } from '@/lib/ticket'
import { cn } from '@/lib/utils'

/**
 * The confirmation motif: a parking ticket stub.
 *
 * Reserved for the moment something becomes final — a reservation confirmed, a
 * payment settled — and deliberately NOT used for routine list rows. A
 * reservation in a table is just a row; that restraint is what keeps the stub
 * meaningful instead of wallpaper.
 */
export function TicketStub({
  status,
  code,
  lines,
  amount,
  className,
}: {
  /** The finality word, set as facility signage: CONFIRMED, PAID. */
  status: string
  /** Customer-facing booking code. Printed as text, and drives the mark. */
  code: string
  /** Facility, space, and time. One short row each. */
  lines: string[]
  /** Formatted total, when the moment involves money. */
  amount?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        // Perforated edge as a dashed rule — the one perforation treatment,
        // used everywhere. Square corners: a garage has no rounded corners.
        'border border-dashed border-foreground/40 bg-card p-4 text-card-foreground',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="signage-label">{status}</span>
        <span className="font-data text-sm font-semibold">
          <span className="sr-only">Booking code </span>
          {code}
        </span>
      </div>

      {/* Hairline rule, not a shadow. */}
      <hr className="my-3" />

      <div className="space-y-1">
        {lines.map((line) => (
          <p key={line} className="text-sm">
            {line}
          </p>
        ))}
      </div>

      <div className="mt-4 flex items-end justify-between gap-4">
        <StubMark code={code} />
        {amount && (
          <span className="font-data text-lg font-semibold">{amount}</span>
        )}
      </div>
    </div>
  )
}

/**
 * The stub's bar mark. Decorative on purpose: the booking code is printed as
 * text directly above it, so assistive tech reads the code once, from the text,
 * rather than hearing it repeated by an image label.
 */
function StubMark({ code }: { code: string }) {
  const { bars, width } = stubBars(code)

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${width} 10`}
      preserveAspectRatio="none"
      className="h-6 w-32 text-foreground"
    >
      {bars.map((bar) => (
        <rect
          key={bar.x}
          x={bar.x}
          y="0"
          width={bar.w}
          height="10"
          fill="currentColor"
        />
      ))}
    </svg>
  )
}
