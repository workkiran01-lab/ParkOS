import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { toast } from 'sonner'
import { TicketStub } from '@/components/reservations/TicketStub'
import { PageSpinner } from '@/components/ui/Spinner'
import {
  loadReservationByCode,
  overstayAt,
  type CheckinLookup,
} from '@/lib/attendant'
import { bigButton, bigButtonOutline } from '@/lib/attendant-ui'
import {
  formatInZone,
  formatWindowInZone,
  overstayElapsed,
} from '@/lib/checkin'
import { friendlyError } from '@/lib/errors'
import { dollars } from '@/lib/format'
import { supabase } from '@/lib/supabase'

// The screen a receipt QR opens. `buildQrPayload` in the receipt Edge Function
// prints {origin}/checkin/{booking_code} onto every ticket, so this path is
// fixed by what is already in customers' hands — it is not free to rename.
//
// It is a BOOTH surface, not a customer one: an attendant scans the ticket the
// driver holds up. Auth therefore matches /attendant exactly — staff only, and
// a customer who scans their own receipt lands in their own area instead.
export const Route = createFileRoute('/checkin/$bookingCode')({
  beforeLoad: async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) throw redirect({ to: '/login' })

    const { data: membership } = await supabase
      .from('memberships')
      .select('role')
      .eq('user_id', session.user.id)
      .limit(1)
      .maybeSingle()
    if (!membership) throw redirect({ to: '/my/reservations' })
  },
  component: BoothCheckin,
})

type Method = 'cash' | 'card'

function BoothCheckin() {
  const { bookingCode } = Route.useParams()
  const [lookup, setLookup] = useState<CheckinLookup | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [overstayCents, setOverstayCents] = useState(0)
  const [method, setMethod] = useState<Method>('cash')
  const [busy, setBusy] = useState(false)
  const [settled, setSettled] = useState<{
    label: string
    amount: number
  } | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const found = await loadReservationByCode(bookingCode)
      setLookup(found)
      // Only a vehicle currently in the lot can be running over.
      setOverstayCents(
        found.state === 'checked_in'
          ? await overstayAt(found.reservation.id, new Date())
          : 0,
      )
    } catch (err) {
      setLoadError(friendlyError(err, 'Could not read that ticket.'))
    }
  }, [bookingCode])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  async function run(action: () => Promise<string>) {
    setBusy(true)
    try {
      toast.success(await action())
      await load()
    } catch (err) {
      toast.error(friendlyError(err, 'That did not go through. Try again.'))
    }
    setBusy(false)
  }

  if (loadError)
    return (
      <Booth code={bookingCode}>
        <Notice title="Lookup failed" body={loadError} />
      </Booth>
    )
  if (!lookup)
    return (
      <Booth code={bookingCode}>
        <PageSpinner />
      </Booth>
    )

  if (lookup.state === 'unknown') {
    return (
      <Booth code={bookingCode}>
        <Notice
          title="No such ticket"
          body="This code does not match any reservation at this operator. Check the code, or search by plate."
        />
      </Booth>
    )
  }

  const { reservation: r, facility, balanceCents } = lookup
  // What the driver owes if they left right now: the stored total already
  // covers the reserved window; the overstay is priced on top of it.
  const dueNow =
    balanceCents + (lookup.state === 'checked_in' ? overstayCents : 0)
  const over = overstayElapsed(r.during, new Date())

  async function checkIn() {
    const { error } = await supabase.rpc('check_in_reservation', {
      p_reservation_id: r.id,
    })
    if (error) throw error
    return 'Checked in'
  }

  async function collect() {
    const { error } = await supabase.rpc('record_booth_payment', {
      p_reservation_id: r.id,
      p_amount_cents: balanceCents,
      p_method: method,
    })
    if (error) throw error
    setSettled({ label: 'PAID', amount: balanceCents })
    return `${dollars(balanceCents)} taken in ${method}`
  }

  async function checkOut() {
    const { data, error } = await supabase.rpc('check_out_reservation', {
      p_reservation_id: r.id,
      p_departure_at: new Date().toISOString(),
      p_payment_method: dueNow > 0 ? method : null,
    })
    if (error) throw error
    const result = (data as { collected_cents: number }[] | null)?.[0]
    setSettled({ label: 'PAID', amount: result?.collected_cents ?? 0 })
    return 'Checked out'
  }

  return (
    <Booth code={bookingCode}>
      <Header state={lookup.state} r={r} />

      <dl className="divide-y divide-border border-y border-border">
        <Row label="Space">
          {r.space_number}
          {r.zone_name ? ` · ${r.zone_name}` : ''}
        </Row>
        <Row label="Vehicle">{r.license_plate ?? 'Not recorded'}</Row>
        <Row label="Reserved">
          {formatWindowInZone(r.during, facility.timezone)}
        </Row>
        {r.checked_in_at && (
          <Row label="Checked in">
            {formatInZone(r.checked_in_at, facility.timezone)}
          </Row>
        )}
        {r.checked_out_at && (
          <Row label="Checked out">
            {formatInZone(r.checked_out_at, facility.timezone)}
          </Row>
        )}
        <Row label="Facility">{`${facility.name} · ${facility.timezone}`}</Row>
      </dl>

      {settled ? (
        <TicketStub
          status={settled.label}
          code={r.booking_code}
          lines={[
            `${facility.name} · space ${r.space_number}`,
            formatInZone(new Date(), facility.timezone),
            `Taken in ${method}`,
          ]}
          amount={dollars(settled.amount)}
        />
      ) : (
        <>
          {lookup.state === 'archived' && (
            <Notice
              title="Archived reservation"
              body="This booking was archived. It cannot be checked in or paid. Raise it with a manager before admitting the vehicle."
            />
          )}
          {lookup.state === 'cancelled' && (
            <Notice
              title={r.status === 'no_show' ? 'Marked no-show' : 'Cancelled'}
              body="Nothing to admit against this code. Book the driver in as a walk-in if they still want the space."
            />
          )}
          {lookup.state === 'completed' && balanceCents === 0 && (
            <Notice
              title="Already checked out"
              body="This session is closed and settled. Nothing further to collect."
            />
          )}

          {(lookup.state === 'ready' ||
            lookup.state === 'checked_in' ||
            (lookup.state === 'completed' && balanceCents > 0)) && (
            <section className="space-y-4">
              <Amount
                due={dueNow}
                overstay={lookup.state === 'checked_in' ? overstayCents : 0}
                over={over}
              />

              {dueNow > 0 && (
                <MethodPicker
                  value={method}
                  onChange={setMethod}
                  disabled={busy}
                />
              )}

              <div className="space-y-2">
                {lookup.state === 'ready' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(checkIn)}
                    className={bigButton}
                  >
                    {busy ? 'Working…' : 'Check in'}
                  </button>
                )}

                {balanceCents > 0 && lookup.state !== 'ready' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(collect)}
                    className={bigButtonOutline}
                  >
                    {`Take ${dollars(balanceCents)} now`}
                  </button>
                )}

                {lookup.state === 'checked_in' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(checkOut)}
                    className={bigButton}
                  >
                    {busy
                      ? 'Working…'
                      : dueNow > 0
                        ? `Check out · take ${dollars(dueNow)}`
                        : 'Check out'}
                  </button>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </Booth>
  )
}

/**
 * The booth shell: one column, maximum contrast, no chrome competing with the
 * ticket. Deliberately not the app shell — this runs on a mounted tablet in
 * daylight, read at arm's length.
 */
function Booth({
  code,
  children,
}: {
  code: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-foreground/15">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-4 px-4 py-3">
          <span className="signage-label">Booth · check in</span>
          <Link
            to="/attendant"
            className="min-h-11 px-2 py-2 text-base font-semibold underline underline-offset-4"
          >
            Search
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-xl space-y-6 px-4 py-6">
        <p className="font-data text-3xl font-semibold tracking-tight">
          {code}
        </p>
        {children}
      </main>
    </div>
  )
}

const STATE_WORD = {
  archived: 'Archived',
  ready: 'Expected',
  checked_in: 'In the lot',
  completed: 'Checked out',
  cancelled: 'Not valid',
} as const

function Header({
  state,
  r,
}: {
  state: keyof typeof STATE_WORD
  r: { customer_name: string }
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <h1 className="text-2xl font-bold tracking-tight">{r.customer_name}</h1>
      <span className="signage-label text-foreground">{STATE_WORD[state]}</span>
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="signage-label">{label}</dt>
      <dd className="text-right text-base font-medium">{children}</dd>
    </div>
  )
}

function Amount({
  due,
  overstay,
  over,
}: {
  due: number
  overstay: number
  over: string | null
}) {
  return (
    <div className="border border-foreground/15 p-4">
      <p className="signage-label">Amount due</p>
      <p className="font-data mt-1 text-4xl font-semibold tracking-tight">
        {dollars(due)}
      </p>
      {overstay > 0 && (
        <p className="mt-2 text-base">
          Includes{' '}
          <span className="font-data font-semibold">{dollars(overstay)}</span>{' '}
          overstay{over ? ` · ${over} past the reserved end` : ''}
        </p>
      )}
      {due === 0 && <p className="mt-2 text-base">Nothing to collect.</p>}
    </div>
  )
}

function MethodPicker({
  value,
  onChange,
  disabled,
}: {
  value: Method
  onChange: (m: Method) => void
  disabled: boolean
}) {
  return (
    <fieldset className="grid grid-cols-2 gap-2">
      <legend className="signage-label mb-2">Taken as</legend>
      {(['cash', 'card'] as const).map((m) => (
        <button
          key={m}
          type="button"
          disabled={disabled}
          aria-pressed={value === m}
          onClick={() => onChange(m)}
          className={value === m ? bigButton : bigButtonOutline}
        >
          {m === 'cash' ? 'Cash' : 'Card'}
        </button>
      ))}
    </fieldset>
  )
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-foreground/15 p-4">
      <p className="text-lg font-bold">{title}</p>
      <p className="mt-1 text-base">{body}</p>
    </div>
  )
}
