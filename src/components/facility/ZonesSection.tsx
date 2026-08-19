import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { SpaceRow, ZoneRow } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type Props = {
  orgId: string
  facilityId: string
  zones: ZoneRow[]
  spaces: SpaceRow[]
  reload: () => Promise<void>
}

export function ZonesSection({ orgId, facilityId, zones, spaces, reload }: Props) {
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<ZoneRow | null>(null)
  const [name, setName] = useState('')
  const [level, setLevel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function activeSpaceCount(zoneId: string) {
    return spaces.filter((space) => space.zone_id === zoneId && !space.archived_at)
      .length
  }

  function openAdd() {
    setName('')
    setLevel('')
    setError(null)
    setAddOpen(true)
  }

  function openEdit(zone: ZoneRow) {
    setName(zone.name)
    setLevel(zone.level === null ? '' : String(zone.level))
    setError(null)
    setEditing(zone)
  }

  async function addZone(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    const { error: insertError } = await supabase.from('zones').insert({
      org_id: orgId,
      facility_id: facilityId,
      name: name.trim(),
      level: level.trim() === '' ? null : Number(level),
    })
    setSubmitting(false)
    if (insertError) {
      setError(insertError.message)
      return
    }
    setAddOpen(false)
    toast.success('Zone added')
    await reload()
  }

  async function saveZone(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    setSubmitting(true)
    setError(null)
    const { error: updateError } = await supabase
      .from('zones')
      .update({
        name: name.trim(),
        level: level.trim() === '' ? null : Number(level),
      })
      .eq('id', editing.id)
    setSubmitting(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    setEditing(null)
    toast.success('Zone saved')
    await reload()
  }

  async function setZoneArchived(zone: ZoneRow, archived: boolean) {
    const { error: archiveError } = await supabase
      .from('zones')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq('id', zone.id)
    if (archiveError) {
      toast.error(archiveError.message)
      return
    }
    setEditing(null)
    toast.success(archived ? 'Zone archived' : 'Zone restored')
    await reload()
  }

  const zoneForm = (
    <div className="space-y-4">
      <Field label="Zone name">
        <Input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Level (optional)">
        <Input
          type="number"
          value={level}
          onChange={(event) => setLevel(event.target.value)}
        />
      </Field>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Zones</CardTitle>
        <CardDescription>
          Levels and areas within this facility, with active space counts.
        </CardDescription>
        <CardAction>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button onClick={openAdd}>Add zone</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add zone</DialogTitle>
                <DialogDescription>
                  A level or named area within this facility.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={addZone} className="space-y-4">
                {zoneForm}
                <DialogFooter>
                  <Button type="submit" disabled={submitting || !name.trim()}>
                    {submitting ? 'Adding…' : 'Add zone'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </CardAction>
      </CardHeader>
      <CardContent>
        {zones.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">No zones yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Active spaces</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {zones.map((zone) => (
                <TableRow key={zone.id}>
                  <TableCell className="font-medium">{zone.name}</TableCell>
                  <TableCell>{zone.level ?? '—'}</TableCell>
                  <TableCell>{activeSpaceCount(zone.id)}</TableCell>
                  <TableCell>
                    {zone.archived_at ? (
                      <Badge variant="outline">Archived</Badge>
                    ) : (
                      <Badge>Active</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => openEdit(zone)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Dialog
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit zone</DialogTitle>
              <DialogDescription>
                Rename, re-level, or archive this zone.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={saveZone} className="space-y-4">
              {zoneForm}
              <DialogFooter className="sm:justify-between">
                {editing && (
                  <Button
                    type="button"
                    variant={editing.archived_at ? 'default' : 'destructive'}
                    onClick={() => setZoneArchived(editing, !editing.archived_at)}
                  >
                    {editing.archived_at ? 'Restore zone' : 'Archive zone'}
                  </Button>
                )}
                <Button type="submit" disabled={submitting || !name.trim()}>
                  {submitting ? 'Saving…' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
