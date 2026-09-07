import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
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
import { useFacility } from '@/hooks/useFacility'
import { useRole } from '@/hooks/useRole'
import {
  FacilityTimeError,
  instantToFacilityInput,
  parseFacilityWindow,
} from '@/lib/facility-time'
import { dollars } from '@/lib/format'
import { spaceTypes, type SpaceRow, type ZoneRow } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

const ANY = 'any'

export const Route = createFileRoute('/app/availability')({
  component: Availability,
})

function Availability() {
  const { role, loading: roleLoading } = useRole()
  const { facilities, error: facilitiesError } = useFacility()
  const [zones, setZones] = useState<ZoneRow[]>([])
  const [facilityId, setFacilityId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [spaceType, setSpaceType] = useState(ANY)
  const [results, setResults] = useState<SpaceRow[] | null>(null)
  const [quotes, setQuotes] = useState<Map<string, QuoteBreakdown | string>>(
    new Map(),
  )
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allowed = role === 'admin' || role === 'manager' || role === 'attendant'
  const facility = facilities.find((option) => option.id === facilityId)

  useEffect(() => {
    if (roleLoading || !allowed) return
    void Promise.resolve().then(() => {
      if (facilitiesError) setError(facilitiesError.message)
      setFacilityId((current) => current || (facilities[0]?.id ?? ''))
    })
  }, [allowed, facilities, facilitiesError, roleLoading])

  useEffect(() => {
    if (!facility) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return
      try {
        setStart(instantToFacilityInput(new Date(), facility.timezone))
        setEnd(
          instantToFacilityInput(
            new Date(Date.now() + 4 * 3_600_000),
            facility.timezone,
          ),
        )
        setError(null)
      } catch (caught) {
        setStart('')
        setEnd('')
        setError(
          caught instanceof FacilityTimeError
            ? caught.message
            : 'The facility timezone could not be loaded.',
        )
      }
      setResults(null)
      setQuotes(new Map())
    })
    return () => {
      cancelled = true
    }
  }, [facility])

  const zoneById = useMemo(
    () => new Map(zones.map((zone) => [zone.id, zone])),
    [zones],
  )

  async function search(event: FormEvent) {
    event.preventDefault()
    if (!facility) {
      setError('Choose a facility.')
      return
    }
    let window
    try {
      window = parseFacilityWindow(start, end, facility.timezone)
    } catch (caught) {
      setError(
        caught instanceof FacilityTimeError
          ? caught.message
          : 'Enter a valid arrival and departure.',
      )
      return
    }

    setSearching(true)
    setError(null)
    setResults(null)
    setQuotes(new Map())

    const [spacesResult, zonesResult] = await Promise.all([
      supabase.rpc('find_available_spaces', {
        p_facility_id: facilityId,
        p_start: window.startIso,
        p_end: window.endIso,
        p_space_type: spaceType === ANY ? null : spaceType,
      }),
      supabase
        .from('zones')
        .select('id, name, level, archived_at')
        .eq('facility_id', facilityId),
    ])

    setSearching(false)
    if (spacesResult.error) {
      setError(spacesResult.error.message)
      return
    }
    if (zonesResult.error) {
      setError(zonesResult.error.message)
      return
    }
    setZones((zonesResult.data ?? []) as ZoneRow[])
    setResults((spacesResult.data ?? []) as SpaceRow[])
  }

  async function quoteSpace(space: SpaceRow) {
    if (!facility) return
    let window
    try {
      window = parseFacilityWindow(start, end, facility.timezone)
    } catch (caught) {
      setError(
        caught instanceof FacilityTimeError
          ? caught.message
          : 'Enter a valid arrival and departure.',
      )
      return
    }
    setQuotes((current) => new Map(current).set(space.id, 'loading'))
    const { data, error: quoteError } = await supabase.rpc(
      'quote_reservation',
      {
        p_space_id: space.id,
        p_start: window.startIso,
        p_end: window.endIso,
      },
    )
    setQuotes((current) =>
      new Map(current).set(
        space.id,
        quoteError ? `Error: ${quoteError.message}` : (data as QuoteBreakdown),
      ),
    )
  }

  if (roleLoading) return <PageSpinner />

  if (!allowed) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Availability unavailable</CardTitle>
          <CardDescription>A staff role is required.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Availability</h1>
        <p className="mt-1 text-muted-foreground">
          Find spaces free for a facility-local window — no overlapping
          reservation, permit, or maintenance hold.
        </p>
      </div>

      <Card>
        <CardContent>
          <form className="flex flex-wrap items-end gap-3" onSubmit={search}>
            <Field label="Facility">
              <Select value={facilityId} onValueChange={setFacilityId}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {facilities.map((facility) => (
                    <SelectItem key={facility.id} value={facility.id}>
                      {facility.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
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
              <Select value={spaceType} onValueChange={setSpaceType}>
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
            <Button type="submit" disabled={searching || !facilityId}>
              {searching ? 'Searching…' : 'Search'}
            </Button>
          </form>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {results !== null && (
        <Card>
          <CardHeader>
            <CardTitle>
              {results.length} available space{results.length === 1 ? '' : 's'}
            </CardTitle>
            <CardDescription>
              For the selected window. “Quote” prices that exact window.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {results.length === 0 ? (
              <p className="py-4 text-center text-muted-foreground">
                Nothing free in that window.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Space</TableHead>
                    <TableHead>Zone</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Price for window</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((space) => {
                    const quote = quotes.get(space.id)
                    return (
                      <TableRow key={space.id}>
                        <TableCell className="font-medium">
                          {space.space_number}
                        </TableCell>
                        <TableCell>
                          {zoneById.get(space.zone_id)?.name ?? '—'}
                        </TableCell>
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
                            <span className="text-muted-foreground">
                              Quoting…
                            </span>
                          ) : typeof quote === 'string' ? (
                            <span className="text-sm text-destructive">
                              {quote}
                            </span>
                          ) : (
                            <Badge variant="outline">
                              {dollars(quote.total_cents)} {quote.currency}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
