import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { PageSpinner } from '@/components/ui/Spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useRole } from '@/hooks/useRole'
import { supabase } from '@/lib/supabase'

type FacilityRow = {
  id: string
  name: string
  address: string | null
  timezone: string
  archived_at: string | null
}

export const Route = createFileRoute('/app/facilities/')({
  component: FacilitiesList,
})

function FacilitiesList() {
  const { role, org_id: orgId, loading: roleLoading } = useRole()
  const [facilities, setFacilities] = useState<FacilityRow[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const allowed = role === 'admin' || role === 'manager'

  const load = useCallback(async () => {
    if (!orgId || !allowed) return
    setLoading(true)
    setError(null)
    const { data, error: loadError } = await supabase
      .from('facilities')
      .select('id, name, address, timezone, archived_at')
      .eq('org_id', orgId)
      .order('name')
    if (loadError) {
      setError(loadError.message)
      setLoading(false)
      return
    }
    setFacilities((data ?? []) as FacilityRow[])
    setLoading(false)
  }, [orgId, allowed])

  useEffect(() => {
    if (!roleLoading) void Promise.resolve().then(load)
  }, [load, roleLoading])

  if (roleLoading) return <PageSpinner />

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

  const visible = showArchived
    ? facilities
    : facilities.filter((facility) => !facility.archived_at)

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Facilities</h1>
          <p className="mt-1 text-muted-foreground">
            Manage your organization’s lots, zones, and spaces.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(checked) => setShowArchived(checked === true)}
          />
          Show archived
        </label>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardContent>
          {loading ? (
            <p className="py-6 text-center text-muted-foreground">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              {showArchived
                ? 'No facilities yet. Run onboarding to create your first one.'
                : 'No active facilities.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Timezone</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((facility) => (
                  <TableRow key={facility.id}>
                    <TableCell>
                      <Link
                        to="/app/facilities/$facilityId"
                        params={{ facilityId: facility.id }}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {facility.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {facility.address ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {facility.timezone}
                    </TableCell>
                    <TableCell>
                      {facility.archived_at ? (
                        <Badge variant="outline">Archived</Badge>
                      ) : (
                        <Badge>Active</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
