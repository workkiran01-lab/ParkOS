import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
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
import { formatRange } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { AuthPage, Field } from '@/routes/login'

type ReservationRow = {
  id: string
  facility_id: string
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
  const [facilityNames, setFacilityNames] = useState<Map<string, string>>(
    new Map(),
  )
  const [error, setError] = useState<string | null>(null)

  // inline login (customers never go through the staff /login route)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  const load = useCallback(async () => {
    // No org filter on purpose: RLS returns exactly the caller's own rows,
    // across every operator they've booked with.
    const { data, error: loadError } = await supabase
      .from('reservations')
      .select('id, facility_id, during, status, total_cents, currency, created_at')
      .order('created_at', { ascending: false })
    if (loadError) {
      setError(loadError.message)
      return
    }
    const reservations = (data ?? []) as ReservationRow[]
    setRows(reservations)

    const names = new Map<string, string>()
    const facilityIds = [...new Set(reservations.map((row) => row.facility_id))]
    await Promise.all(
      facilityIds.map(async (id) => {
        const { data: facility } = await supabase.rpc('get_public_facility', {
          p_facility_id: id,
        })
        const row = ((facility as { name: string }[]) ?? [])[0]
        if (row) names.set(id, row.name)
      }),
    )
    setFacilityNames(names)
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
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            My reservations
          </h1>
          <p className="mt-1 text-muted-foreground">
            Every booking on this account, across all parking operators.
          </p>
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
                    <TableHead>When</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        {facilityNames.get(row.facility_id) ?? 'Facility'}
                        <p className="font-mono text-xs text-muted-foreground">
                          {row.id.slice(0, 8)}
                        </p>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatRange(row.during)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.status === 'cancelled' ? 'outline' : 'default'
                          }
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {dollars(row.total_cents)} {row.currency}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
