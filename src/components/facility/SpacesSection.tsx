import { useMemo, useState, type FormEvent } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  batchSpaceNumbers,
  makeTstzrange,
  rangeContainsNow,
  spaceStatuses,
  spaceTypes,
  type HoldRow,
  type SpaceRow,
  type SpaceType,
  type ZoneRow,
} from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type Props = {
  orgId: string
  zones: ZoneRow[]
  spaces: SpaceRow[]
  holds: HoldRow[]
  reload: () => Promise<void>
}

type BlockFailure = { spaceNumber: string; message: string }

export function SpacesSection({ orgId, zones, spaces, holds, reload }: Props) {
  const [zoneFilter, setZoneFilter] = useState('all')
  const [levelFilter, setLevelFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [showArchived, setShowArchived] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // add-batch dialog
  const [addOpen, setAddOpen] = useState(false)
  const [batchZoneId, setBatchZoneId] = useState('')
  const [prefix, setPrefix] = useState('')
  const [startingNumber, setStartingNumber] = useState(1)
  const [count, setCount] = useState(10)
  const [batchType, setBatchType] = useState<SpaceType>('standard')
  const [addError, setAddError] = useState<string | null>(null)

  // edit dialog
  const [editing, setEditing] = useState<SpaceRow | null>(null)
  const [editNumber, setEditNumber] = useState('')
  const [editType, setEditType] = useState<SpaceType>('standard')
  const [editError, setEditError] = useState<string | null>(null)

  // maintenance-block dialog
  const [blockOpen, setBlockOpen] = useState(false)
  const [blockStart, setBlockStart] = useState('')
  const [blockEnd, setBlockEnd] = useState('')
  const [blockFailures, setBlockFailures] = useState<BlockFailure[]>([])
  const [blockError, setBlockError] = useState<string | null>(null)

  const zoneById = useMemo(
    () => new Map(zones.map((zone) => [zone.id, zone])),
    [zones],
  )
  const activeZones = zones.filter((zone) => !zone.archived_at)
  const levels = useMemo(
    () =>
      [...new Set(zones.map((zone) => zone.level).filter((v) => v !== null))].sort(
        (a, b) => a! - b!,
      ),
    [zones],
  )

  const heldNow = useMemo(() => {
    const set = new Set<string>()
    for (const hold of holds) {
      if (hold.released_at === null && rangeContainsNow(hold.during)) {
        set.add(hold.space_id)
      }
    }
    return set
  }, [holds])

  const visible = spaces.filter((space) => {
    if (!showArchived && space.archived_at) return false
    if (zoneFilter !== 'all' && space.zone_id !== zoneFilter) return false
    if (levelFilter !== 'all') {
      const zone = zoneById.get(space.zone_id)
      if (String(zone?.level ?? '') !== levelFilter) return false
    }
    if (typeFilter !== 'all' && space.space_type !== typeFilter) return false
    if (statusFilter !== 'all' && space.status !== statusFilter) return false
    return true
  })

  const visibleSelected = visible.filter((space) => selected.has(space.id))
  const allVisibleSelected =
    visible.length > 0 && visibleSelected.length === visible.length

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(visible.map((space) => space.id)) : new Set())
  }

  function toggleOne(spaceId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(spaceId)
      else next.delete(spaceId)
      return next
    })
  }

  async function bulkSetArchived(archived: boolean) {
    if (visibleSelected.length === 0) return
    setBusy(true)
    const { error } = await supabase
      .from('spaces')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .in(
        'id',
        visibleSelected.map((space) => space.id),
      )
    setBusy(false)
    if (error) {
      toast.error(
        error.code === '23505'
          ? 'Restore failed: another active space already uses one of these numbers.'
          : error.message,
      )
      return
    }
    toast.success(
      `${visibleSelected.length} space${visibleSelected.length === 1 ? '' : 's'} ${archived ? 'archived' : 'restored'}`,
    )
    setSelected(new Set())
    await reload()
  }

  function openAdd() {
    setBatchZoneId(activeZones[0]?.id ?? '')
    setPrefix('')
    setStartingNumber(1)
    setCount(10)
    setBatchType('standard')
    setAddError(null)
    setAddOpen(true)
  }

  async function addBatch(event: FormEvent) {
    event.preventDefault()
    if (!batchZoneId || count < 1) return
    setBusy(true)
    setAddError(null)

    const rows = batchSpaceNumbers(prefix.trim(), startingNumber, count).map(
      (spaceNumber) => ({
        org_id: orgId,
        zone_id: batchZoneId,
        space_number: spaceNumber,
        space_type: batchType,
      }),
    )

    const { error } = await supabase.from('spaces').insert(rows)
    setBusy(false)
    if (error) {
      setAddError(
        error.code === '23505'
          ? 'One or more of these space numbers already exist as active spaces in that zone. Adjust the prefix or starting number.'
          : error.message,
      )
      return
    }
    setAddOpen(false)
    toast.success(`${count} space${count === 1 ? '' : 's'} added`)
    await reload()
  }

  function openEdit(space: SpaceRow) {
    setEditing(space)
    setEditNumber(space.space_number)
    setEditType(space.space_type)
    setEditError(null)
  }

  async function saveSpace(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    setBusy(true)
    setEditError(null)
    const { error } = await supabase
      .from('spaces')
      .update({ space_number: editNumber.trim(), space_type: editType })
      .eq('id', editing.id)
    setBusy(false)
    if (error) {
      setEditError(
        error.code === '23505'
          ? 'An active space with that number already exists in this zone.'
          : error.message,
      )
      return
    }
    setEditing(null)
    toast.success('Space saved')
    await reload()
  }

  async function setSpaceArchived(space: SpaceRow, archived: boolean) {
    const { error } = await supabase
      .from('spaces')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq('id', space.id)
    if (error) {
      setEditError(
        error.code === '23505'
          ? 'Cannot restore: another active space already uses this number.'
          : error.message,
      )
      return
    }
    setEditing(null)
    toast.success(archived ? 'Space archived' : 'Space restored')
    await reload()
  }

  function openBlock() {
    setBlockStart('')
    setBlockEnd('')
    setBlockFailures([])
    setBlockError(null)
    setBlockOpen(true)
  }

  async function blockForMaintenance(event: FormEvent) {
    event.preventDefault()
    if (visibleSelected.length === 0) return

    const start = new Date(blockStart)
    const end = new Date(blockEnd)
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      setBlockError('Enter a valid range: the end must be after the start.')
      return
    }

    setBusy(true)
    setBlockError(null)
    setBlockFailures([])

    const during = makeTstzrange(start.toISOString(), end.toISOString())
    const failures: BlockFailure[] = []
    let created = 0

    // One insert per space so a conflict on one space (23P01 from the
    // exclusion constraint) surfaces as a per-space error instead of
    // silently failing the whole batch.
    for (const space of visibleSelected) {
      const { error } = await supabase.from('space_holds').insert({
        org_id: orgId,
        space_id: space.id,
        hold_type: 'maintenance',
        during,
      })
      if (error) {
        failures.push({
          spaceNumber: space.space_number,
          message:
            error.code === '23P01'
              ? 'Overlapping hold (reservation, permit, or existing block) in this window.'
              : error.message,
        })
      } else {
        created += 1
      }
    }

    setBusy(false)
    setBlockFailures(failures)
    if (created > 0) {
      toast.success(
        `Maintenance block created for ${created} space${created === 1 ? '' : 's'}`,
      )
      await reload()
    }
    if (failures.length === 0) {
      setBlockOpen(false)
      setSelected(new Set())
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Spaces</CardTitle>
        <CardDescription>
          Filter, edit, archive, and block spaces for maintenance.
        </CardDescription>
        <CardAction>
          <Button onClick={openAdd} disabled={activeZones.length === 0}>
            Add spaces
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Zone">
            <Select value={zoneFilter} onValueChange={setZoneFilter}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All zones</SelectItem>
                {zones.map((zone) => (
                  <SelectItem key={zone.id} value={zone.id}>
                    {zone.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Level">
            <Select value={levelFilter} onValueChange={setLevelFilter}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                {levels.map((lvl) => (
                  <SelectItem key={String(lvl)} value={String(lvl)}>
                    Level {lvl}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Type">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {spaceTypes.map((spaceType) => (
                  <SelectItem key={spaceType} value={spaceType}>
                    {label(spaceType)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {spaceStatuses.map((status) => (
                  <SelectItem key={status} value={status}>
                    {label(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <label className="flex h-8 items-center gap-2 text-sm">
            <Checkbox
              checked={showArchived}
              onCheckedChange={(checked) => setShowArchived(checked === true)}
            />
            Show archived
          </label>
        </div>

        {visibleSelected.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 p-2">
            <span className="px-2 text-sm font-medium">
              {visibleSelected.length} selected
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => bulkSetArchived(true)}
            >
              Archive selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => bulkSetArchived(false)}
            >
              Restore selected
            </Button>
            <Button size="sm" disabled={busy} onClick={openBlock}>
              Block for maintenance
            </Button>
          </div>
        )}

        {visible.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">
            No spaces match the current filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={(checked) => toggleAll(checked === true)}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Space</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Held now</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((space) => (
                  <TableRow key={space.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(space.id)}
                        onCheckedChange={(checked) =>
                          toggleOne(space.id, checked === true)
                        }
                        aria-label={`Select ${space.space_number}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {space.space_number}
                      {space.archived_at && (
                        <Badge variant="outline" className="ml-2">
                          Archived
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{zoneById.get(space.zone_id)?.name ?? '—'}</TableCell>
                    <TableCell>{label(space.space_type)}</TableCell>
                    <TableCell>{label(space.status)}</TableCell>
                    <TableCell>
                      {heldNow.has(space.id) ? (
                        <Badge variant="destructive">Held</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(space)}
                      >
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Add batch */}
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add spaces</DialogTitle>
              <DialogDescription>
                Bulk-generate numbered spaces in one zone.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={addBatch} className="space-y-4">
              <Field label="Zone">
                <Select value={batchZoneId} onValueChange={setBatchZoneId}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {activeZones.map((zone) => (
                      <SelectItem key={zone.id} value={zone.id}>
                        {zone.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Prefix">
                  <Input
                    value={prefix}
                    onChange={(event) => setPrefix(event.target.value)}
                  />
                </Field>
                <Field label="Space type">
                  <Select
                    value={batchType}
                    onValueChange={(value) => setBatchType(value as SpaceType)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {spaceTypes.map((spaceType) => (
                        <SelectItem key={spaceType} value={spaceType}>
                          {label(spaceType)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Starting number">
                  <Input
                    type="number"
                    min={0}
                    required
                    value={startingNumber}
                    onChange={(event) =>
                      setStartingNumber(Number(event.target.value))
                    }
                  />
                </Field>
                <Field label="Count">
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    required
                    value={count}
                    onChange={(event) => setCount(Number(event.target.value))}
                  />
                </Field>
              </div>
              {addError && <p className="text-sm text-destructive">{addError}</p>}
              <DialogFooter>
                <Button type="submit" disabled={busy || !batchZoneId}>
                  {busy ? 'Adding…' : `Add ${count} spaces`}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Edit space */}
        <Dialog
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit space</DialogTitle>
              <DialogDescription>
                Change the number or type, or archive this space.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={saveSpace} className="space-y-4">
              <Field label="Space number">
                <Input
                  required
                  value={editNumber}
                  onChange={(event) => setEditNumber(event.target.value)}
                />
              </Field>
              <Field label="Space type">
                <Select
                  value={editType}
                  onValueChange={(value) => setEditType(value as SpaceType)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {spaceTypes.map((spaceType) => (
                      <SelectItem key={spaceType} value={spaceType}>
                        {label(spaceType)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {editError && <p className="text-sm text-destructive">{editError}</p>}
              <DialogFooter className="sm:justify-between">
                {editing && (
                  <Button
                    type="button"
                    variant={editing.archived_at ? 'default' : 'destructive'}
                    onClick={() => setSpaceArchived(editing, !editing.archived_at)}
                  >
                    {editing.archived_at ? 'Restore space' : 'Archive space'}
                  </Button>
                )}
                <Button type="submit" disabled={busy || !editNumber.trim()}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Block for maintenance */}
        <Dialog open={blockOpen} onOpenChange={setBlockOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Block for maintenance</DialogTitle>
              <DialogDescription>
                Creates one maintenance hold per selected space (
                {visibleSelected.map((space) => space.space_number).join(', ')}
                ). Times are entered in your local time and stored UTC.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={blockForMaintenance} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="From">
                  <Input
                    type="datetime-local"
                    required
                    value={blockStart}
                    onChange={(event) => setBlockStart(event.target.value)}
                  />
                </Field>
                <Field label="Until">
                  <Input
                    type="datetime-local"
                    required
                    value={blockEnd}
                    onChange={(event) => setBlockEnd(event.target.value)}
                  />
                </Field>
              </div>
              {blockError && <p className="text-sm text-destructive">{blockError}</p>}
              {blockFailures.length > 0 && (
                <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-sm font-medium text-destructive">
                    Not blocked:
                  </p>
                  {blockFailures.map((failure) => (
                    <p key={failure.spaceNumber} className="text-sm text-destructive">
                      {failure.spaceNumber}: {failure.message}
                    </p>
                  ))}
                </div>
              )}
              <DialogFooter>
                <Button type="submit" disabled={busy}>
                  {busy
                    ? 'Blocking…'
                    : `Block ${visibleSelected.length} space${visibleSelected.length === 1 ? '' : 's'}`}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
