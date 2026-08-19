import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatRange, type HoldRow, type SpaceRow, type ZoneRow } from '@/lib/holds'
import { supabase } from '@/lib/supabase'

type Props = {
  zones: ZoneRow[]
  spaces: SpaceRow[]
  holds: HoldRow[]
  reload: () => Promise<void>
}

export function MaintenanceSection({ zones, spaces, holds, reload }: Props) {
  const [releasing, setReleasing] = useState<string | null>(null)

  const spaceById = useMemo(
    () => new Map(spaces.map((space) => [space.id, space])),
    [spaces],
  )
  const zoneById = useMemo(
    () => new Map(zones.map((zone) => [zone.id, zone])),
    [zones],
  )

  // Parent loads only unreleased holds; this section shows the maintenance ones.
  const active = holds.filter((hold) => hold.hold_type === 'maintenance')

  async function release(holdId: string) {
    setReleasing(holdId)
    const { error } = await supabase
      .from('space_holds')
      .update({ released_at: new Date().toISOString() })
      .eq('id', holdId)
    setReleasing(null)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success('Maintenance block released')
    await reload()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance blocks</CardTitle>
        <CardDescription>
          Active (unreleased) maintenance holds for this facility. Releasing
          early frees the space for booking immediately.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {active.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">
            No active maintenance blocks.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Space</TableHead>
                <TableHead>Zone</TableHead>
                <TableHead>Window</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.map((hold) => {
                const space = spaceById.get(hold.space_id)
                const zone = space ? zoneById.get(space.zone_id) : undefined
                return (
                  <TableRow key={hold.id}>
                    <TableCell className="font-medium">
                      {space?.space_number ?? hold.space_id}
                    </TableCell>
                    <TableCell>{zone?.name ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRange(hold.during)}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={releasing === hold.id}
                        onClick={() => release(hold.id)}
                      >
                        {releasing === hold.id ? 'Releasing…' : 'Release early'}
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
  )
}
