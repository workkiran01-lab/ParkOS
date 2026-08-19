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
import { defaultLocalDatetime, dollars } from '@/lib/format'
import { spaceTypes, type SpaceRow, type SpaceType, type ZoneRow } from '@/lib/holds'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

export type PriceRuleRow = {
  id: string
  zone_id: string | null
  space_type: SpaceType | null
  hourly_rate_cents: number
  daily_cap_cents: number | null
  currency: string
  priority: number
  archived_at: string | null
}

export type QuoteBreakdown = {
  currency: string
  price_rule_id: string
  total_cents: number
  line_items: {
    date: string
    hours: number
    hourly_rate_cents: number
    uncapped_cents: number
    daily_cap_cents: number | null
    subtotal_cents: number
  }[]
}

type Props = {
  orgId: string
  facilityId: string
  zones: ZoneRow[]
  spaces: SpaceRow[]
  rules: PriceRuleRow[]
  reload: () => Promise<void>
}

const ANY = 'any'

export function PricingSection({
  orgId,
  facilityId,
  zones,
  spaces,
  rules,
  reload,
}: Props) {
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<PriceRuleRow | null>(null)
  const [zoneId, setZoneId] = useState(ANY)
  const [spaceType, setSpaceType] = useState(ANY)
  const [hourlyDollars, setHourlyDollars] = useState('')
  const [capDollars, setCapDollars] = useState('')
  const [priority, setPriority] = useState(0)
  const [showArchived, setShowArchived] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // rate preview
  const [previewRule, setPreviewRule] = useState<PriceRuleRow | null>(null)
  const [previewStart, setPreviewStart] = useState('')
  const [previewHours, setPreviewHours] = useState(4)
  const [previewSpace, setPreviewSpace] = useState<SpaceRow | null>(null)
  const [quote, setQuote] = useState<QuoteBreakdown | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [quoting, setQuoting] = useState(false)

  const zoneById = useMemo(
    () => new Map(zones.map((zone) => [zone.id, zone])),
    [zones],
  )
  const activeZones = zones.filter((zone) => !zone.archived_at)

  const visibleRules = (
    showArchived ? rules : rules.filter((rule) => !rule.archived_at)
  )
    .slice()
    .sort((a, b) => b.priority - a.priority)

  function scopeLabel(rule: PriceRuleRow) {
    const zone = rule.zone_id ? (zoneById.get(rule.zone_id)?.name ?? '?') : null
    const type = rule.space_type ? label(rule.space_type) : null
    if (zone && type) return `${zone} · ${type}`
    if (zone) return zone
    if (type) return type
    return 'Facility-wide'
  }

  function openAdd() {
    setZoneId(ANY)
    setSpaceType(ANY)
    setHourlyDollars('')
    setCapDollars('')
    setPriority(0)
    setError(null)
    setAddOpen(true)
  }

  function openEdit(rule: PriceRuleRow) {
    setZoneId(rule.zone_id ?? ANY)
    setSpaceType(rule.space_type ?? ANY)
    setHourlyDollars((rule.hourly_rate_cents / 100).toFixed(2))
    setCapDollars(
      rule.daily_cap_cents === null ? '' : (rule.daily_cap_cents / 100).toFixed(2),
    )
    setPriority(rule.priority)
    setError(null)
    setEditing(rule)
  }

  function formValues() {
    const hourlyCents = Math.round(Number(hourlyDollars) * 100)
    const capCents =
      capDollars.trim() === '' ? null : Math.round(Number(capDollars) * 100)
    if (!Number.isFinite(hourlyCents) || hourlyCents < 0) {
      setError('Enter a valid hourly rate.')
      return null
    }
    if (capCents !== null && (!Number.isFinite(capCents) || capCents < 0)) {
      setError('Enter a valid daily cap, or leave it empty.')
      return null
    }
    return {
      zone_id: zoneId === ANY ? null : zoneId,
      space_type: spaceType === ANY ? null : (spaceType as SpaceType),
      hourly_rate_cents: hourlyCents,
      daily_cap_cents: capCents,
      priority,
    }
  }

  async function addRule(event: FormEvent) {
    event.preventDefault()
    const values = formValues()
    if (!values) return
    setSubmitting(true)
    setError(null)
    const { error: insertError } = await supabase.from('price_rules').insert({
      org_id: orgId,
      facility_id: facilityId,
      ...values,
    })
    setSubmitting(false)
    if (insertError) {
      setError(insertError.message)
      return
    }
    setAddOpen(false)
    toast.success('Price rule added')
    await reload()
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    const values = formValues()
    if (!values) return
    setSubmitting(true)
    setError(null)
    const { error: updateError } = await supabase
      .from('price_rules')
      .update(values)
      .eq('id', editing.id)
    setSubmitting(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    setEditing(null)
    toast.success('Price rule saved')
    await reload()
  }

  async function setRuleArchived(rule: PriceRuleRow, archived: boolean) {
    const { error: archiveError } = await supabase
      .from('price_rules')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq('id', rule.id)
    if (archiveError) {
      toast.error(archiveError.message)
      return
    }
    setEditing(null)
    toast.success(archived ? 'Price rule archived' : 'Price rule restored')
    await reload()
  }

  function matchingSpace(rule: PriceRuleRow): SpaceRow | null {
    return (
      spaces.find(
        (space) =>
          !space.archived_at &&
          !zoneById.get(space.zone_id)?.archived_at &&
          (rule.zone_id === null || space.zone_id === rule.zone_id) &&
          (rule.space_type === null || space.space_type === rule.space_type),
      ) ?? null
    )
  }

  function openPreview(rule: PriceRuleRow) {
    const space = matchingSpace(rule)
    setPreviewRule(rule)
    setPreviewSpace(space)
    setPreviewStart(defaultLocalDatetime())
    setPreviewHours(4)
    setQuote(null)
    setPreviewError(
      space ? null : 'No active space matches this rule’s scope to preview with.',
    )
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault()
    if (!previewSpace) return
    const start = new Date(previewStart)
    if (Number.isNaN(start.getTime()) || previewHours <= 0) {
      setPreviewError('Enter a valid start time and positive duration.')
      return
    }
    const end = new Date(start.getTime() + previewHours * 3600_000)
    setQuoting(true)
    setPreviewError(null)
    setQuote(null)

    // The real pricing function, against a real space in this rule's scope —
    // proves the rule and quote_reservation agree, not just that the row saved.
    const { data, error: quoteError } = await supabase.rpc('quote_reservation', {
      p_space_id: previewSpace.id,
      p_start: start.toISOString(),
      p_end: end.toISOString(),
    })

    setQuoting(false)
    if (quoteError) {
      setPreviewError(quoteError.message)
      return
    }
    setQuote(data as QuoteBreakdown)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pricing</CardTitle>
        <CardDescription>
          Hourly rates with optional daily caps. The most specific active rule
          wins: zone + type, then zone, then type, then facility-wide; priority
          breaks ties.
        </CardDescription>
        <CardAction>
          <Button onClick={openAdd}>Add rule</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived
        </label>

        {visibleRules.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">
            No price rules yet. Reservations can’t be quoted without one.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Hourly rate</TableHead>
                <TableHead>Daily cap</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell className="font-medium">{scopeLabel(rule)}</TableCell>
                  <TableCell>{dollars(rule.hourly_rate_cents)}/hr</TableCell>
                  <TableCell>
                    {rule.daily_cap_cents === null
                      ? '—'
                      : dollars(rule.daily_cap_cents)}
                  </TableCell>
                  <TableCell>{rule.priority}</TableCell>
                  <TableCell>
                    {rule.archived_at ? (
                      <Badge variant="outline">Archived</Badge>
                    ) : (
                      <Badge>Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="space-x-2">
                    <Button size="sm" variant="outline" onClick={() => openEdit(rule)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openPreview(rule)}
                    >
                      Preview
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Add / edit */}
        <Dialog
          open={addOpen || editing !== null}
          onOpenChange={(open) => {
            if (!open) {
              setAddOpen(false)
              setEditing(null)
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit price rule' : 'Add price rule'}</DialogTitle>
              <DialogDescription>
                Leave zone and type as “Any” for a facility-wide rule.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={editing ? saveRule : addRule} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Zone">
                  <Select value={zoneId} onValueChange={setZoneId}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any zone</SelectItem>
                      {activeZones.map((zone) => (
                        <SelectItem key={zone.id} value={zone.id}>
                          {zone.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Space type">
                  <Select value={spaceType} onValueChange={setSpaceType}>
                    <SelectTrigger className="w-full">
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
                <Field label="Hourly rate ($)">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    required
                    value={hourlyDollars}
                    onChange={(event) => setHourlyDollars(event.target.value)}
                  />
                </Field>
                <Field label="Daily cap ($, optional)">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={capDollars}
                    onChange={(event) => setCapDollars(event.target.value)}
                  />
                </Field>
                <Field label="Priority">
                  <Input
                    type="number"
                    required
                    value={priority}
                    onChange={(event) => setPriority(Number(event.target.value))}
                  />
                </Field>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter className="sm:justify-between">
                {editing && (
                  <Button
                    type="button"
                    variant={editing.archived_at ? 'default' : 'destructive'}
                    onClick={() => setRuleArchived(editing, !editing.archived_at)}
                  >
                    {editing.archived_at ? 'Restore rule' : 'Archive rule'}
                  </Button>
                )}
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Saving…' : editing ? 'Save' : 'Add rule'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Rate preview */}
        <Dialog
          open={previewRule !== null}
          onOpenChange={(open) => {
            if (!open) setPreviewRule(null)
          }}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Rate preview</DialogTitle>
              <DialogDescription>
                {previewRule && (
                  <>
                    Quotes {previewSpace?.space_number ?? 'a space'} (in{' '}
                    {previewRule
                      ? scopeLabel(previewRule).toLowerCase()
                      : 'this scope'}
                    ) with the real pricing function.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={runPreview} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Start">
                  <Input
                    type="datetime-local"
                    required
                    value={previewStart}
                    onChange={(event) => setPreviewStart(event.target.value)}
                  />
                </Field>
                <Field label="Duration (hours)">
                  <Input
                    type="number"
                    min={0.5}
                    step="0.5"
                    required
                    value={previewHours}
                    onChange={(event) => setPreviewHours(Number(event.target.value))}
                  />
                </Field>
              </div>
              {previewError && (
                <p className="text-sm text-destructive">{previewError}</p>
              )}
              {quote && previewRule && (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      Applied rule
                    </span>
                    {quote.price_rule_id === previewRule.id ? (
                      <Badge>This rule</Badge>
                    ) : (
                      <Badge variant="destructive">
                        A different rule won (
                        {ruleShortLabel(quote.price_rule_id, visibleRules, scopeLabel)}
                        )
                      </Badge>
                    )}
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Hours</TableHead>
                        <TableHead>Rate</TableHead>
                        <TableHead>Cap</TableHead>
                        <TableHead className="text-right">Subtotal</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {quote.line_items.map((item) => (
                        <TableRow key={item.date}>
                          <TableCell>{item.date}</TableCell>
                          <TableCell>{item.hours}</TableCell>
                          <TableCell>{dollars(item.hourly_rate_cents)}/hr</TableCell>
                          <TableCell>
                            {item.daily_cap_cents === null
                              ? '—'
                              : dollars(item.daily_cap_cents)}
                          </TableCell>
                          <TableCell className="text-right">
                            {dollars(item.subtotal_cents)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="text-right font-medium">
                    Total: {dollars(quote.total_cents)} {quote.currency}
                  </p>
                </div>
              )}
              <DialogFooter>
                <Button type="submit" disabled={quoting || !previewSpace}>
                  {quoting ? 'Quoting…' : 'Get quote'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}

function ruleShortLabel(
  ruleId: string,
  rules: PriceRuleRow[],
  scopeLabel: (rule: PriceRuleRow) => string,
) {
  const rule = rules.find((candidate) => candidate.id === ruleId)
  return rule
    ? `${scopeLabel(rule)}, priority ${rule.priority}`
    : ruleId.slice(0, 8)
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
