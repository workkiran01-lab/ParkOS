import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { QuoteBreakdown } from '@/components/facility/PricingSection'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { defaultLocalDatetime, dollars } from '@/lib/format'
import { spaceTypes, type SpaceType } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type PublicFacility = {
  name: string
  address: string | null
  timezone: string
  operating_hours: { open: string; close: string } | null
}

type CustomerInfo = { customer_id: string; org_id: string; full_name: string }

type VehicleRow = {
  id: string
  license_plate: string | null
  make: string | null
  model: string | null
  color: string | null
}

type AvailableSpace = {
  space_id: string
  space_number: string
  zone_name: string
  space_type: SpaceType
}

type Confirmation = {
  reservation_id: string
  total_cents: number
  price_breakdown: QuoteBreakdown
  space_number: string
  start: string
  end: string
}

const ANY = 'any'
const NO_VEHICLE = 'none'

export const Route = createFileRoute('/book/$facilityId')({
  component: BookingPage,
})

function BookingPage() {
  const { facilityId } = Route.useParams()
  const { user, loading: authLoading } = useAuth()
  const [facility, setFacility] = useState<PublicFacility | null>(null)
  const [facilityLoading, setFacilityLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // inline auth
  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  // customer record
  const [customer, setCustomer] = useState<CustomerInfo | null>(null)
  const [needsDetails, setNeedsDetails] = useState(false)
  const [phone, setPhone] = useState('')
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [detailsBusy, setDetailsBusy] = useState(false)

  // vehicles
  const [vehicles, setVehicles] = useState<VehicleRow[]>([])
  const [vehicleId, setVehicleId] = useState(NO_VEHICLE)
  const [addingVehicle, setAddingVehicle] = useState(false)
  const [plate, setPlate] = useState('')
  const [makeModel, setMakeModel] = useState('')
  const [color, setColor] = useState('')
  const [vehicleError, setVehicleError] = useState<string | null>(null)

  // search + booking
  const [start, setStart] = useState(() => defaultLocalDatetime(3600_000))
  const [end, setEnd] = useState(() => defaultLocalDatetime(5 * 3600_000))
  const [typeFilter, setTypeFilter] = useState(ANY)
  const [results, setResults] = useState<AvailableSpace[] | null>(null)
  const [quotes, setQuotes] = useState<Map<string, QuoteBreakdown | string>>(
    new Map(),
  )
  const [searching, setSearching] = useState(false)
  const [bookingSpace, setBookingSpace] = useState<string | null>(null)
  const [bookError, setBookError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  useEffect(() => {
    let active = true
    void supabase
      .rpc('get_public_facility', { p_facility_id: facilityId })
      .then(({ data, error: loadError }) => {
        if (!active) return
        if (loadError) setError(loadError.message)
        else setFacility(((data as PublicFacility[]) ?? [])[0] ?? null)
        setFacilityLoading(false)
      })
    return () => {
      active = false
    }
  }, [facilityId])

  const ensureCustomer = useCallback(
    async (details?: { fullName: string; email: string; phone: string }) => {
      const { data, error: ensureError } = await supabase.rpc(
        'public_ensure_customer',
        {
          p_facility_id: facilityId,
          p_full_name: details?.fullName ?? null,
          p_email: details?.email ?? null,
          p_phone: details?.phone ?? null,
        },
      )
      if (ensureError) {
        if (ensureError.message === 'CUSTOMER_DETAILS_REQUIRED') {
          setNeedsDetails(true)
          return null
        }
        setDetailsError(ensureError.message)
        return null
      }
      const info = ((data as CustomerInfo[]) ?? [])[0] ?? null
      setCustomer(info)
      setNeedsDetails(false)
      return info
    },
    [facilityId],
  )

  const loadVehicles = useCallback(async (customerId: string) => {
    const { data, error: vehiclesError } = await supabase
      .from('vehicles')
      .select('id, license_plate, make, model, color')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .order('created_at')
    if (vehiclesError) {
      setVehicleError(vehiclesError.message)
      return
    }
    setVehicles((data ?? []) as VehicleRow[])
  }, [])

  useEffect(() => {
    if (authLoading || !user || customer) return
    void Promise.resolve().then(async () => {
      const info = await ensureCustomer()
      if (info) await loadVehicles(info.customer_id)
    })
  }, [authLoading, user, customer, ensureCustomer, loadVehicles])

  async function authenticate(event: FormEvent) {
    event.preventDefault()
    setAuthBusy(true)
    setAuthError(null)
    setAuthMessage(null)

    // Plain customer auth. Never touches create_organization_with_admin —
    // org creation is the staff signup path only.
    if (mode === 'signup') {
      const { data, error: signupError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: fullName.trim() } },
      })
      setAuthBusy(false)
      if (signupError) {
        setAuthError(signupError.message)
        return
      }
      if (!data.session) {
        setAuthMessage('Check your email to confirm your account, then log in here.')
        setMode('login')
        return
      }
    } else {
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      setAuthBusy(false)
      if (loginError) {
        setAuthError(loginError.message)
        return
      }
    }
  }

  async function submitDetails(event: FormEvent) {
    event.preventDefault()
    setDetailsBusy(true)
    setDetailsError(null)
    const info = await ensureCustomer({
      fullName: fullName.trim() || (user?.user_metadata?.full_name as string) || '',
      email: user?.email ?? email,
      phone,
    })
    setDetailsBusy(false)
    if (info) void loadVehicles(info.customer_id)
  }

  async function addVehicle(event: FormEvent) {
    event.preventDefault()
    if (!customer) return
    setVehicleError(null)
    const [make, ...modelParts] = makeModel.trim().split(' ')
    const { data, error: insertError } = await supabase
      .from('vehicles')
      .insert({
        org_id: customer.org_id,
        customer_id: customer.customer_id,
        license_plate: plate.trim().toUpperCase(),
        make: make || null,
        model: modelParts.join(' ') || null,
        color: color.trim() || null,
      })
      .select('id, license_plate, make, model, color')
      .single()
    if (insertError) {
      setVehicleError(insertError.message)
      return
    }
    const vehicle = data as VehicleRow
    setVehicles((current) => [...current, vehicle])
    setVehicleId(vehicle.id)
    setAddingVehicle(false)
    setPlate('')
    setMakeModel('')
    setColor('')
  }

  async function search(event: FormEvent) {
    event.preventDefault()
    const startDate = new Date(start)
    const endDate = new Date(end)
    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(endDate.getTime()) ||
      endDate <= startDate
    ) {
      setBookError('Enter a valid window: the end must be after the start.')
      return
    }
    setSearching(true)
    setBookError(null)
    setResults(null)
    setQuotes(new Map())
    const { data, error: searchError } = await supabase.rpc(
      'get_public_availability',
      {
        p_facility_id: facilityId,
        p_start: startDate.toISOString(),
        p_end: endDate.toISOString(),
        p_space_type: typeFilter === ANY ? null : typeFilter,
      },
    )
    setSearching(false)
    if (searchError) {
      setBookError(searchError.message)
      return
    }
    setResults((data ?? []) as AvailableSpace[])
  }

  async function quoteSpace(space: AvailableSpace) {
    setQuotes((current) => new Map(current).set(space.space_id, 'loading'))
    const { data, error: quoteError } = await supabase.rpc(
      'public_quote_reservation',
      {
        p_space_id: space.space_id,
        p_start: new Date(start).toISOString(),
        p_end: new Date(end).toISOString(),
      },
    )
    setQuotes((current) =>
      new Map(current).set(
        space.space_id,
        quoteError ? `Error: ${quoteError.message}` : (data as QuoteBreakdown),
      ),
    )
  }

  async function book(space: AvailableSpace) {
    if (!customer) return
    setBookingSpace(space.space_id)
    setBookError(null)
    const { data, error: bookErr } = await supabase.rpc(
      'public_create_reservation',
      {
        p_facility_id: facilityId,
        p_space_id: space.space_id,
        p_customer_id: customer.customer_id,
        p_vehicle_id: vehicleId === NO_VEHICLE ? null : vehicleId,
        p_start: new Date(start).toISOString(),
        p_end: new Date(end).toISOString(),
      },
    )
    setBookingSpace(null)
    if (bookErr) {
      setBookError(
        bookErr.message === 'SPACE_UNAVAILABLE'
          ? `${space.space_number} was taken for that window (someone else booked it, or it's blocked). Search again for an updated list.`
          : bookErr.message,
      )
      return
    }
    const row = (
      data as {
        reservation_id: string
        total_cents: number
        price_breakdown: QuoteBreakdown
      }[]
    )[0]
    setConfirmation({
      ...row,
      space_number: space.space_number,
      start,
      end,
    })
  }

  if (facilityLoading || authLoading) return <PageSpinner />

  if (!facility) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>Facility not found</CardTitle>
            <CardDescription>
              {error ?? 'This booking link is invalid or the facility is closed.'}
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    )
  }

  if (confirmation) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>You’re booked! 🎉</CardTitle>
            <CardDescription>
              {facility.name} — space {confirmation.space_number}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1 text-sm">
              <p>
                <span className="text-muted-foreground">Reservation:</span>{' '}
                <span className="font-mono">{confirmation.reservation_id}</span>
              </p>
              <p>
                <span className="text-muted-foreground">When:</span>{' '}
                {new Date(confirmation.start).toLocaleString()} →{' '}
                {new Date(confirmation.end).toLocaleString()}
              </p>
              <p>
                <span className="text-muted-foreground">Total:</span>{' '}
                <span className="font-medium">
                  {dollars(confirmation.total_cents)}
                </span>
              </p>
            </div>
            <BreakdownTable quote={confirmation.price_breakdown} />
            <p className="text-sm text-muted-foreground">
              Show this reservation ID at the facility. (QR code coming later.)
            </p>
            <div className="flex gap-2">
              <Button onClick={() => setConfirmation(null)} variant="outline">
                Book another
              </Button>
              <Button asChild>
                <Link to="/my/reservations">My reservations</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {facility.name}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {facility.address ? `${facility.address} · ` : ''}
            {facility.operating_hours
              ? `Open ${facility.operating_hours.open}–${facility.operating_hours.close} (${facility.timezone})`
              : facility.timezone}
          </p>
        </div>
        {user && (
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/my/reservations">My reservations</Link>
            </Button>
            <Button variant="ghost" onClick={() => supabase.auth.signOut()}>
              Sign out
            </Button>
          </div>
        )}
      </div>

      {!user ? (
        <Card className="mx-auto w-full max-w-md">
          <CardHeader>
            <CardTitle>
              {mode === 'signup' ? 'Create an account to book' : 'Log in to book'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={mode === 'signup' ? 'default' : 'outline'}
                onClick={() => setMode('signup')}
              >
                Sign up
              </Button>
              <Button
                variant={mode === 'login' ? 'default' : 'outline'}
                onClick={() => setMode('login')}
              >
                Log in
              </Button>
            </div>
            <form className="space-y-4" onSubmit={authenticate}>
              {mode === 'signup' && (
                <Field label="Your name">
                  <Input
                    required
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                  />
                </Field>
              )}
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
                  autoComplete={
                    mode === 'signup' ? 'new-password' : 'current-password'
                  }
                  minLength={8}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {authError && <p className="text-sm text-destructive">{authError}</p>}
              {authMessage && (
                <p className="text-sm text-muted-foreground">{authMessage}</p>
              )}
              <Button className="w-full" type="submit" disabled={authBusy}>
                {authBusy
                  ? 'Working…'
                  : mode === 'signup'
                    ? 'Sign up'
                    : 'Log in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : needsDetails ? (
        <Card className="mx-auto w-full max-w-md">
          <CardHeader>
            <CardTitle>Almost there</CardTitle>
            <CardDescription>
              Tell {facility.name} who’s parking.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submitDetails}>
              <Field label="Full name">
                <Input
                  required
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                />
              </Field>
              <Field label="Phone (optional)">
                <Input
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </Field>
              {detailsError && (
                <p className="text-sm text-destructive">{detailsError}</p>
              )}
              <Button className="w-full" type="submit" disabled={detailsBusy}>
                {detailsBusy ? 'Saving…' : 'Continue'}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : customer ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Your vehicle</CardTitle>
              <CardDescription>
                Optional — helps the attendant find you.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Vehicle">
                  <Select value={vehicleId} onValueChange={setVehicleId}>
                    <SelectTrigger className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_VEHICLE}>No vehicle</SelectItem>
                      {vehicles.map((vehicle) => (
                        <SelectItem key={vehicle.id} value={vehicle.id}>
                          {vehicleLabel(vehicle)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Button
                  variant="outline"
                  onClick={() => setAddingVehicle((current) => !current)}
                >
                  {addingVehicle ? 'Cancel' : 'Add vehicle'}
                </Button>
              </div>
              {addingVehicle && (
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={addVehicle}
                >
                  <Field label="License plate">
                    <Input
                      required
                      value={plate}
                      onChange={(event) => setPlate(event.target.value)}
                    />
                  </Field>
                  <Field label="Make and model">
                    <Input
                      value={makeModel}
                      onChange={(event) => setMakeModel(event.target.value)}
                    />
                  </Field>
                  <Field label="Color">
                    <Input
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                    />
                  </Field>
                  <Button type="submit">Save vehicle</Button>
                </form>
              )}
              {vehicleError && (
                <p className="text-sm text-destructive">{vehicleError}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Find a space</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form className="flex flex-wrap items-end gap-3" onSubmit={search}>
                <Field label="From">
                  <Input
                    type="datetime-local"
                    required
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </Field>
                <Field label="Until">
                  <Input
                    type="datetime-local"
                    required
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </Field>
                <Field label="Type">
                  <Select value={typeFilter} onValueChange={setTypeFilter}>
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any type</SelectItem>
                      {spaceTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          {label(type)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Button type="submit" disabled={searching}>
                  {searching ? 'Searching…' : 'Search'}
                </Button>
              </form>

              {bookError && <p className="text-sm text-destructive">{bookError}</p>}

              {results !== null &&
                (results.length === 0 ? (
                  <p className="py-4 text-center text-muted-foreground">
                    Nothing free in that window — try different times.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Space</TableHead>
                        <TableHead>Zone</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Price</TableHead>
                        <TableHead className="w-24" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.map((space) => {
                        const quote = quotes.get(space.space_id)
                        return (
                          <TableRow key={space.space_id}>
                            <TableCell className="font-medium">
                              {space.space_number}
                            </TableCell>
                            <TableCell>{space.zone_name}</TableCell>
                            <TableCell>{label(space.space_type)}</TableCell>
                            <TableCell>
                              {quote === undefined ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => quoteSpace(space)}
                                >
                                  Quote
                                </Button>
                              ) : quote === 'loading' ? (
                                <span className="text-muted-foreground">…</span>
                              ) : typeof quote === 'string' ? (
                                <span className="text-sm text-destructive">
                                  {quote}
                                </span>
                              ) : (
                                <Badge variant="outline">
                                  {dollars(quote.total_cents)}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                disabled={bookingSpace !== null}
                                onClick={() => book(space)}
                              >
                                {bookingSpace === space.space_id
                                  ? 'Booking…'
                                  : 'Book'}
                              </Button>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                ))}
            </CardContent>
          </Card>
        </>
      ) : (
        <PageSpinner />
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/30 px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">{children}</div>
    </div>
  )
}

function BreakdownTable({ quote }: { quote: QuoteBreakdown }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Hours</TableHead>
          <TableHead>Rate</TableHead>
          <TableHead className="text-right">Subtotal</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {quote.line_items.map((item) => (
          <TableRow key={item.date}>
            <TableCell>{item.date}</TableCell>
            <TableCell>{item.hours}</TableCell>
            <TableCell>{dollars(item.hourly_rate_cents)}/hr</TableCell>
            <TableCell className="text-right">
              {dollars(item.subtotal_cents)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function vehicleLabel(vehicle: VehicleRow) {
  const desc = [vehicle.color, vehicle.make, vehicle.model]
    .filter(Boolean)
    .join(' ')
  return desc
    ? `${vehicle.license_plate ?? '?'} — ${desc}`
    : (vehicle.license_plate ?? 'Vehicle')
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
