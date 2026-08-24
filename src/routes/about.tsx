import { Link, createFileRoute } from '@tanstack/react-router'
import { PublicShell } from '@/components/layout/PublicShell'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/about')({
  component: About,
})

function About() {
  return (
    <PublicShell>
      <section className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <h1 className="text-3xl font-semibold tracking-tight">About ParkOS</h1>

        <div className="mt-8 space-y-6 text-muted-foreground">
          <p className="text-lg text-foreground">
            ParkOS is parking management for independent operators — the
            single-lot and two-lot businesses that still run on spreadsheets,
            paper tickets, and a cash box.
          </p>

          <p>
            It's built to cover the whole day, not just the reservation. A
            customer books online, or drives up and gets checked in at the booth
            — either way, the space is held the moment it's committed. A
            database-level exclusion constraint makes it mechanically impossible
            for two people to be sold the same space at the same time. Real-time
            occupancy shows every attendant exactly what's held, available, or
            reserved, before it becomes a coordination problem.
          </p>

          <p>
            Payments settle through Stripe directly to the operator's own
            account — ParkOS never holds funds in transit — and every completed
            transaction produces an itemized receipt automatically, with a
            scannable check-in code. Monthly permits run on the same underlying
            schedule as reservations, so a permit holder's space can't silently
            double-book with a walk-in.
          </p>
        </div>
      </section>

      <section className="border-t bg-muted/30">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-6 py-12">
          <Button asChild className="h-11 px-5 text-sm">
            <Link to="/signup">Create account</Link>
          </Button>
          <Button asChild variant="outline" className="h-11 px-5 text-sm">
            <Link to="/">Back to home</Link>
          </Button>
        </div>
      </section>
    </PublicShell>
  )
}
