import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { MaintenanceSection } from '@/components/facility/MaintenanceSection'
import {
  PricingSection,
  type PriceRuleRow,
} from '@/components/facility/PricingSection'
import { SpacesSection } from '@/components/facility/SpacesSection'
import { ZonesSection } from '@/components/facility/ZonesSection'
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
import { useRole } from '@/hooks/useRole'
import type { HoldRow, SpaceRow, ZoneRow } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type FacilityRow = {
  id: string
  name: string
  address: string | null
  timezone: string
  operating_hours: { type: string; open: string; close: string } | null
  archived_at: string | null
}

export const Route = createFileRoute('/app/facilities/$facilityId')({
  component: FacilityDetail,
})

function FacilityDetail() {
  const { facilityId } = Route.useParams()
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const [facility, setFacility] = useState<FacilityRow | null>(null)
  const [zones, setZones] = useState<ZoneRow[]>([])
  const [spaces, setSpaces] = useState<SpaceRow[]>([])
  const [holds, setHolds] = useState<HoldRow[]>([])
  const [rules, setRules] = useState<PriceRuleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // edit form
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [timezone, setTimezone] = useState('')
  const [openTime, setOpenTime] = useState('06:00')
  const [closeTime, setCloseTime] = useState('22:00')
  const [saving, setSaving] = useState(false)

  const allowed = role === 'admin' || role === 'manager'

  const load = useCallback(async () => {
    if (!orgId || !allowed) return
    setLoading(true)
    setError(null)

    const { data: facilityRow, error: facilityError } = await supabase
      .from('facilities')
      .select('id, name, address, timezone, operating_hours, archived_at')
      .eq('id', facilityId)
      .maybeSingle()

    if (facilityError || !facilityRow) {
      setError(facilityError?.message ?? 'Facility not found.')
      setLoading(false)
      return
    }

    const { data: zoneRows, error: zoneError } = await supabase
      .from('zones')
      .select('id, name, level, archived_at')
      .eq('facility_id', facilityId)
      .order('level')
      .order('name')

    if (zoneError) {
      setError(zoneError.message)
      setLoading(false)
      return
    }

    const zoneIds = (zoneRows ?? []).map((zone) => zone.id)
    let spaceRows: SpaceRow[] = []
    let holdRows: HoldRow[] = []

    if (zoneIds.length > 0) {
      const { data: spacesData, error: spacesError } = await supabase
        .from('spaces')
        .select('id, zone_id, space_number, space_type, status, archived_at')
        .in('zone_id', zoneIds)
        .order('space_number')

      if (spacesError) {
        setError(spacesError.message)
        setLoading(false)
        return
      }
      spaceRows = (spacesData ?? []) as SpaceRow[]

      const spaceIds = spaceRows.map((space) => space.id)
      if (spaceIds.length > 0) {
        const { data: holdsData, error: holdsError } = await supabase
          .from('space_holds')
          .select('id, space_id, hold_type, during, released_at, created_at')
          .in('space_id', spaceIds)
          .is('released_at', null)
          .order('created_at', { ascending: false })

        if (holdsError) {
          setError(holdsError.message)
          setLoading(false)
          return
        }
        holdRows = (holdsData ?? []) as HoldRow[]
      }
    }

    const { data: ruleRows, error: rulesError } = await supabase
      .from('price_rules')
      .select(
        'id, zone_id, space_type, hourly_rate_cents, daily_cap_cents, currency, priority, archived_at',
      )
      .eq('facility_id', facilityId)
      .order('priority', { ascending: false })

    if (rulesError) {
      setError(rulesError.message)
      setLoading(false)
      return
    }

    const typedFacility = facilityRow as FacilityRow
    setFacility(typedFacility)
    setName(typedFacility.name)
    setAddress(typedFacility.address ?? '')
    setTimezone(typedFacility.timezone)
    setOpenTime(typedFacility.operating_hours?.open ?? '06:00')
    setCloseTime(typedFacility.operating_hours?.close ?? '22:00')
    setZones((zoneRows ?? []) as ZoneRow[])
    setSpaces(spaceRows)
    setHolds(holdRows)
    setRules((ruleRows ?? []) as PriceRuleRow[])
    setLoading(false)
  }, [orgId, allowed, facilityId])

  useEffect(() => {
    if (!roleLoading) void Promise.resolve().then(load)
  }, [load, roleLoading])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!facility) return
    setSaving(true)
    setError(null)

    // Same operating_hours shape onboarding writes: { type, open, close }.
    const { error: saveError } = await supabase
      .from('facilities')
      .update({
        name: name.trim(),
        address: address.trim() || null,
        timezone: timezone.trim(),
        operating_hours: { type: 'daily', open: openTime, close: closeTime },
      })
      .eq('id', facility.id)

    setSaving(false)
    if (saveError) {
      setError(saveError.message)
      return
    }
    toast.success('Facility saved')
    await load()
  }

  async function setArchived(archived: boolean) {
    if (!facility) return
    const { error: archiveError } = await supabase
      .from('facilities')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq('id', facility.id)
    if (archiveError) {
      setError(archiveError.message)
      return
    }
    toast.success(archived ? 'Facility archived' : 'Facility restored')
    await load()
  }

  if (roleLoading || (allowed && loading)) return <PageSpinner />

  if (!allowed) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Facilities unavailable</CardTitle>
          <CardDescription>
            An administrator or manager role is required.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!facility) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Facility not found</CardTitle>
          <CardDescription>
            {error ?? 'It may belong to another organization.'}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm">
            <Link
              to="/app/facilities"
              className="text-muted-foreground underline-offset-4 hover:underline"
            >
              ← Facilities
            </Link>
          </p>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {facility.name}
            </h1>
            {facility.archived_at ? (
              <Badge variant="outline">Archived</Badge>
            ) : (
              <Badge>Active</Badge>
            )}
          </div>
        </div>
        <Button
          variant={facility.archived_at ? 'default' : 'destructive'}
          onClick={() => setArchived(!facility.archived_at)}
        >
          {facility.archived_at ? 'Restore facility' : 'Archive facility'}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>
            Operating hours use the facility’s local time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={save}>
            <Field label="Name">
              <Input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Address">
              <Input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
            </Field>
            <Field label="IANA timezone">
              <Input
                required
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Open">
                <Input
                  type="time"
                  required
                  value={openTime}
                  onChange={(event) => setOpenTime(event.target.value)}
                />
              </Field>
              <Field label="Close">
                <Input
                  type="time"
                  required
                  value={closeTime}
                  onChange={(event) => setCloseTime(event.target.value)}
                />
              </Field>
            </div>
            <div>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <ZonesSection
        orgId={orgId!}
        facilityId={facility.id}
        zones={zones}
        spaces={spaces}
        reload={load}
      />

      <PricingSection
        orgId={orgId!}
        facilityId={facility.id}
        zones={zones}
        spaces={spaces}
        rules={rules}
        reload={load}
      />

      <SpacesSection
        orgId={orgId!}
        zones={zones}
        spaces={spaces}
        holds={holds}
        reload={load}
      />

      <MaintenanceSection
        zones={zones}
        spaces={spaces}
        holds={holds}
        reload={load}
      />
    </div>
  )
}
