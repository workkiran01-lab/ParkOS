import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ReservationActions } from '@/components/reservations/ReservationActions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageSpinner } from '@/components/ui/Spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAuth } from '@/hooks/useAuth'
import { dollars } from '@/lib/format'
import { formatRange, parseTstzrange } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { AuthPage, Field } from '@/routes/login'

type ReservationRow = {
  reservation_id: string
  facility_id: string
  facility_name: string
  space_id: string
  space_number: string
  zone_name: string
  during: string
  status: string
  total_cents: number
  currency: string
  created_at: string
}

export const Route = createFileRoute('/my/reservations')({
  component: MyReservations,
})

function MyReservations() {
  const { user, loading: authLoading } = useAuth()
  const [rows, setRows] = useState<ReservationRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // inline login (customers never go through the staff /login route)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  const load = useCallback(async () => {
    // One elevated call returns the caller's own reservations across every
    // operator, with space/facility labels their reservation RLS can't join to.
    const { data, error: loadError } = await supabase.rpc('get_my_reservations')
    if (loadError) {
      setError(loadError.message)
      return
    }
    setRows((data ?? []) as ReservationRow[])
  }, [])

  useEffect(() => {
    if (!authLoading && user) void Promise.resolve().then(load)
  }, [authLoading, user, load])

  async function login(event: FormEvent) {
    event.preventDefault()
    setAuthBusy(true)
    setAuthError(null)
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    setAuthBusy(false)
    if (loginError) setAuthError(loginError.message)
  }

  if (authLoading) return <PageSpinner />

  if (!user) {
    return (
      <AuthPage>
        <Card>
          <CardHeader>
            <CardTitle>My reservations</CardTitle>
            <CardDescription>Log in to see your bookings.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={login}>
              <Field label="Email">
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {authError && <p className="text-sm text-destructive">{authError}</p>}
              <Button className="w-full" type="submit" disabled={authBusy}>
                {authBusy ? 'Logging in…' : 'Log in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </AuthPage>
    )
  }

  return (
    <div className="min-h-screen bg-muted/30 px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              My reservations
            </h1>
            <p className="mt-1 text-muted-foreground">
              Every booking on this account, across all parking operators.
            </p>
          </div>
          <Button variant="ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Card>
          <CardContent>
            {rows === null ? (
              <p className="py-6 text-center text-muted-foreground">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">
                No reservations yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Facility</TableHead>
                    <TableHead>Space</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Manage</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const { start, end } = parseTstzrange(row.during)
                    return (
                      <TableRow key={row.reservation_id}>
                        <TableCell className="font-medium">
                          {row.facility_name}
                          <p className="font-mono text-xs text-muted-foreground">
                            {row.reservation_id.slice(0, 8)}
                          </p>
                        </TableCell>
                        <TableCell>
                          {row.space_number}
                          <p className="text-xs text-muted-foreground">
                            {row.zone_name}
                          </p>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatRange(row.during)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.status === 'cancelled' || row.status === 'no_show'
                                ? 'outline'
                                : 'default'
                            }
                          >
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {dollars(row.total_cents)} {row.currency}
                        </TableCell>
                        <TableCell>
                          {start && end && (
                            <ReservationActions
                              reservationId={row.reservation_id}
                              status={row.status}
                              spaceId={row.space_id}
                              startIso={start.toISOString()}
                              endIso={end.toISOString()}
                              isStaff={false}
                              onDone={load}
                            />
                          )}
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" asChild>
                            <Link
                              to="/book/$facilityId"
                              params={{ facilityId: row.facility_id }}
                            >
                              Book again
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
