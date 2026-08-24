import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowRight,
  CalendarCheck,
  IdCard,
  LayoutGrid,
  ShieldCheck,
} from 'lucide-react'
import { PublicShell } from '@/components/layout/PublicShell'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  tileStatusClasses,
  tileStatusLabel,
  tileStatusSwatch,
  tileStatuses,
  type TileStatus,
} from '@/lib/occupancy'

export const Route = createFileRoute('/')({
  component: Home,
})

/**
 * A representative level, drawn with the same tiles the live occupancy map
 * uses. Static on purpose — the landing page does no data fetching.
 */
const LOT: TileStatus[] = [
  'occupied',
  'occupied',
  'available',
  'permit',
  'occupied',
  'reserved',
  'available',
  'occupied',
  'permit',
  'occupied',
  'occupied',
  'available',
  'occupied',
  'occupied',
  'reserved',
  'available',
  'available',
  'occupied',
  'permit',
  'occupied',
  'maintenance',
  'occupied',
  'available',
  'occupied',
  'occupied',
  'reserved',
  'available',
  'occupied',
  'permit',
  'available',
  'occupied',
  'occupied',
]

const HELD = LOT.filter((status) => status !== 'available').length

const FEATURES = [
  {
    icon: CalendarCheck,
    title: 'Reservations & walk-ins',
    body: 'Take bookings online or check in a drive-up at the booth. Both land in the same schedule, and a database exclusion constraint makes double-booking impossible.',
  },
  {
    icon: LayoutGrid,
    title: 'Real-time occupancy',
    body: 'A live map of every space across zones and levels. Available, occupied, reserved, permit, or out of service, at a glance.',
  },
  {
    icon: IdCard,
    title: 'Monthly permits',
    body: 'Assign a space to a long-term holder with recurring billing. Permits and reservations compete for the same spaces through the same constraint.',
  },
  {
    icon: ShieldCheck,
    title: 'Secure payments',
    body: 'Hosted Stripe Checkout, with payment state written only from signature-verified webhooks. Every paid reservation gets an itemized PDF receipt.',
  },
]

const STEPS = [
  {
    title: 'Create your facility',
    body: 'Lay out zones, levels, and spaces, and invite the staff who will work them.',
  },
  {
    title: 'Set your pricing',
    body: 'Hourly rates with optional daily caps, scoped by zone or space type.',
  },
  {
    title: 'Start taking reservations',
    body: 'Share your booking link. Payments settle straight to your own Stripe account.',
  },
]

function OccupancyPreview() {
  return (
    <Card className="w-full">
      <CardHeader className="border-b">
        <CardTitle className="text-base">Level 1</CardTitle>
        <CardDescription className="tabular-nums">
          {HELD} of {LOT.length} spaces held
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-6">
        <div
          role="img"
          aria-label={`Occupancy map: ${HELD} of ${LOT.length} spaces held on Level 1`}
          className="grid grid-cols-6 justify-items-center gap-1.5 sm:grid-cols-8"
        >
          {LOT.map((status, index) => (
            <div
              key={index}
              aria-hidden="true"
              className={`flex h-10 w-10 items-center justify-center rounded-md border text-[10px] font-medium tabular-nums ${tileStatusClasses[status]}`}
            >
              {String(index + 1).padStart(3, '0')}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 border-t pt-4">
          {tileStatuses.map((status) => (
            <span
              key={status}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                className={`size-2.5 rounded-sm ${tileStatusSwatch[status]}`}
              />
              {tileStatusLabel[status]}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function Home() {
  return (
    <PublicShell>
      <>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1fr_28rem]">
            <div className="space-y-6">
              <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                Every space accounted for.
              </h1>
              <p className="max-w-prose text-lg text-muted-foreground">
                ParkOS runs reservations, walk-ins, monthly permits, and card
                payments for attended and unattended lots — with a live map of
                who is parked where, and an itemized receipt behind every
                transaction.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button asChild className="h-11 px-5 text-sm">
                  <Link to="/signup">Create account</Link>
                </Button>
                <Button asChild variant="outline" className="h-11 px-5 text-sm">
                  <Link to="/login">Log in</Link>
                </Button>
              </div>
            </div>
            <OccupancyPreview />
          </div>
        </section>

        {/* Features */}
        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
            <h2 className="text-2xl font-semibold tracking-tight">
              What it handles
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <Card key={title} className="h-full">
                  <CardHeader>
                    <Icon
                      className="size-5 text-primary"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    <CardTitle className="mt-3 text-base">{title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">{body}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* How it works — numbered because the order is real: you cannot price
            a facility that does not exist, or take bookings without a price. */}
        <section className="border-t">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
            <h2 className="text-2xl font-semibold tracking-tight">
              Getting set up
            </h2>
            <ol className="mt-8 grid gap-8 sm:grid-cols-3">
              {STEPS.map(({ title, body }, index) => (
                <li key={title} className="border-t pt-4">
                  <span className="text-xs font-semibold tabular-nums text-primary">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <h3 className="mt-2 font-semibold tracking-tight">{title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* About */}
        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
            <h2 className="text-2xl font-semibold tracking-tight">
              About ParkOS
            </h2>
            <p className="mt-4 text-muted-foreground">
              ParkOS is parking management for independent operators — the
              single-lot and two-lot businesses that still run on spreadsheets,
              paper tickets, and a cash box. It covers the whole day, not just
              the reservation: the space is held the moment it's committed, and
              every completed transaction produces an itemized receipt.
            </p>
            <Link
              to="/about"
              className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Learn more
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </>
    </PublicShell>
  )
}
