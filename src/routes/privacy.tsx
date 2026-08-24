import type { ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { PublicShell } from '@/components/layout/PublicShell'
import { Card, CardContent } from '@/components/ui/card'

export const Route = createFileRoute('/privacy')({
  component: Privacy,
})

/** One numbered clause. The number is part of the content here — a policy gets
 *  cited by section, so it stays visible rather than becoming list decoration. */
function Clause({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: ReactNode
}) {
  return (
    <section className="border-t pt-8">
      <span className="text-xs font-semibold tabular-nums text-primary">
        {number}
      </span>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 space-y-3 text-muted-foreground">{children}</div>
    </section>
  )
}

const COLLECTED = [
  {
    term: 'Account information',
    detail: 'Name and email for anyone who creates an account.',
  },
  {
    term: 'Vehicle information',
    detail:
      'License plate, make, model, and colour, and photos taken at check-in and check-out for damage documentation.',
  },
  {
    term: 'Payment information',
    detail:
      'We do not store card details. Payments are processed by Stripe; we retain only transaction records — Stripe identifiers, amounts, and status.',
  },
  {
    term: 'Reservation and permit history',
    detail:
      'Bookings, facility and space assignments, timestamps, and the itemized receipts generated for each paid transaction.',
  },
  {
    term: 'Staff activity',
    detail:
      'An audit log of actions taken by Operator staff (check-ins, cancellations, overrides) for accountability and dispute resolution.',
  },
  {
    term: 'Usage data',
    detail:
      'Standard technical logs (IP address, browser type) for security and troubleshooting.',
  },
]

function Privacy() {
  return (
    <PublicShell>
      <section className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <header>
          <h1 className="text-3xl font-semibold tracking-tight">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Last updated: [8/23/2026]
          </p>
        </header>

        <div className="mt-12 space-y-8">
          <Clause number={1} title="Who we are">
            <p>
              ParkOS ("we," "us") provides a parking management platform used by
              parking operators ("Operators") and their customers ("Customers").
            </p>
          </Clause>

          <Clause number={2} title="Information we collect">
            <Card>
              <CardContent className="pt-6">
                <dl className="space-y-4">
                  {COLLECTED.map(({ term, detail }) => (
                    <div key={term}>
                      <dt className="text-sm font-semibold text-foreground">
                        {term}
                      </dt>
                      <dd className="mt-1 text-sm text-muted-foreground">
                        {detail}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          </Clause>

          <Clause number={3} title="How we use this information">
            <p>
              To operate reservations and permits, process payments, generate
              receipts, prevent double-booking and fraud, communicate essential
              account and booking information, and maintain an audit trail of
              staff actions.
            </p>
          </Clause>

          <Clause number={4} title="Who we share it with">
            <p>
              We share data only with the service providers necessary to run
              ParkOS: Stripe (payment processing — card details never reach
              ParkOS directly), Supabase (database, authentication, and file
              storage, hosted in the United States), Resend (transactional
              receipt email), and Vercel (application hosting). Operators can
              see data only for their own facility's Customers, enforced at the
              database level — never across organizations. We do not sell
              personal data.
            </p>
          </Clause>

          <Clause number={5} title="Data retention">
            <p>
              We use soft deletion throughout our systems: records are marked
              inactive rather than immediately erased, so history remains
              available for support and dispute resolution. Payment records
              specifically are retained permanently and are never deleted, for
              financial record-keeping. Vehicle photos are retained per Operator
              policy. You may request deletion of your personal account data,
              subject to records we are legally required to keep.
            </p>
          </Clause>

          <Clause number={6} title="Your rights">
            <p>
              You may request access to, correction of, or deletion of your
              personal data by contacting us at [contact email].
            </p>
          </Clause>

          <Clause number={7} title="Cookies">
            <p>
              We use essential cookies for login sessions only. We do not use
              third-party advertising trackers.
            </p>
          </Clause>

          <Clause number={8} title="Children's privacy">
            <p>
              ParkOS is not directed at children under 13, and we do not
              knowingly collect their data.
            </p>
          </Clause>

          <Clause number={9} title="Changes to this policy">
            <p>
              We will update the date above when this policy changes. Material
              changes will be communicated to Operators.
            </p>
          </Clause>

          <Clause number={10} title="Contact">
            <p>Questions about this policy: [contact email].</p>
          </Clause>
        </div>
      </section>
    </PublicShell>
  )
}
