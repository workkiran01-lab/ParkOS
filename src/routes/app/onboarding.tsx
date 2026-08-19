import { useState, type FormEvent } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
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
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

type SpaceType =
  | 'standard'
  | 'compact'
  | 'accessible'
  | 'ev'
  | 'oversized'
  | 'motorcycle'

type SpaceBatch = {
  id: string
  zoneName: string
  prefix: string
  startingNumber: number
  count: number
  spaceType: SpaceType
}

const selectClass =
  'h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

export const Route = createFileRoute('/app/onboarding')({
  component: Onboarding,
})

function Onboarding() {
  const navigate = useNavigate()
  const { org_id: orgId, role, loading } = useRole()
  const [step, setStep] = useState(1)
  const [facilityName, setFacilityName] = useState('')
  const [address, setAddress] = useState('')
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
  )
  const [openTime, setOpenTime] = useState('06:00')
  const [closeTime, setCloseTime] = useState('22:00')
  const [batches, setBatches] = useState<SpaceBatch[]>([])
  const [zoneName, setZoneName] = useState('Level 1')
  const [prefix, setPrefix] = useState('L1-')
  const [startingNumber, setStartingNumber] = useState(1)
  const [count, setCount] = useState(40)
  const [spaceType, setSpaceType] = useState<SpaceType>('standard')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (loading) return <PageSpinner />

  if (!orgId || !role || !['admin', 'manager'].includes(role)) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Onboarding unavailable</CardTitle>
          <CardDescription>An administrator or manager role is required.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  function addBatch(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!zoneName.trim() || !prefix.trim() || startingNumber < 0 || count < 1) {
      setError('Enter a zone, prefix, starting number, and positive space count.')
      return
    }

    setBatches((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        zoneName: zoneName.trim(),
        prefix: prefix.trim(),
        startingNumber,
        count,
        spaceType,
      },
    ])

    const nextLevel = batches.length + 2
    setZoneName(`Level ${nextLevel}`)
    setPrefix(`L${nextLevel}-`)
  }

  async function finish() {
    if (batches.length === 0) {
      setError('Add at least one space batch before finishing.')
      return
    }

    setSubmitting(true)
    setError(null)

    // One RPC so the facility, its zones, and its spaces commit atomically —
    // a failure anywhere rolls back the whole bootstrap instead of leaving a
    // partial facility behind.
    const { error: rpcError } = await supabase.rpc(
      'create_facility_with_zones_and_spaces',
      {
        p_name: facilityName.trim(),
        p_address: address.trim() || null,
        p_timezone: timezone.trim(),
        p_operating_hours: { type: 'daily', open: openTime, close: closeTime },
        p_zones: batches.map((batch, index) => ({
          zone_name: batch.zoneName,
          level: index + 1,
          space_batches: [
            {
              prefix: batch.prefix,
              starting_number: batch.startingNumber,
              count: batch.count,
              space_type: batch.spaceType,
            },
          ],
        })),
      },
    )

    setSubmitting(false)
    if (rpcError) {
      setError(rpcError.message)
      return
    }

    await navigate({ to: '/app' })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Step {step} of 3</p>
        <h1 className="text-3xl font-semibold tracking-tight">Set up your first facility</h1>
      </div>

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Facility details</CardTitle>
            <CardDescription>Tell ParkOS where this parking operation lives.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Facility name">
              <Input required value={facilityName} onChange={(event) => setFacilityName(event.target.value)} />
            </Field>
            <Field label="Address">
              <Input value={address} onChange={(event) => setAddress(event.target.value)} />
            </Field>
            <Field label="IANA timezone">
              <Input required value={timezone} onChange={(event) => setTimezone(event.target.value)} />
            </Field>
            <Button disabled={!facilityName.trim() || !timezone.trim()} onClick={() => setStep(2)}>
              Continue
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Operating hours</CardTitle>
            <CardDescription>Use the facility’s local time.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Open">
                <Input type="time" required value={openTime} onChange={(event) => setOpenTime(event.target.value)} />
              </Field>
              <Field label="Close">
                <Input type="time" required value={closeTime} onChange={(event) => setCloseTime(event.target.value)} />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={() => setStep(3)}>Continue</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Bulk-generate spaces</CardTitle>
              <CardDescription>Add one batch per level, zone, or space type.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={addBatch}>
                <Field label="Zone or level name">
                  <Input required value={zoneName} onChange={(event) => setZoneName(event.target.value)} />
                </Field>
                <Field label="Space prefix">
                  <Input required value={prefix} onChange={(event) => setPrefix(event.target.value)} />
                </Field>
                <Field label="Starting number">
                  <Input type="number" min={0} required value={startingNumber} onChange={(event) => setStartingNumber(Number(event.target.value))} />
                </Field>
                <Field label="Count">
                  <Input type="number" min={1} max={1000} required value={count} onChange={(event) => setCount(Number(event.target.value))} />
                </Field>
                <Field label="Space type">
                  <select className={selectClass} value={spaceType} onChange={(event) => setSpaceType(event.target.value as SpaceType)}>
                    <option value="standard">Standard</option>
                    <option value="compact">Compact</option>
                    <option value="accessible">Accessible</option>
                    <option value="ev">EV</option>
                    <option value="oversized">Oversized</option>
                    <option value="motorcycle">Motorcycle</option>
                  </select>
                </Field>
                <div className="flex items-end">
                  <Button type="submit" variant="outline">Add batch</Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {batches.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Planned batches</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {batches.map((batch) => (
                  <div key={batch.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
                    <div>
                      <p className="font-medium">{batch.zoneName}</p>
                      <p className="text-sm text-muted-foreground">
                        {batch.count} {batch.spaceType.replace('_', ' ')} spaces · {batch.prefix}{batch.startingNumber}
                      </p>
                    </div>
                    <Button variant="ghost" onClick={() => setBatches((current) => current.filter((item) => item.id !== batch.id))}>
                      Remove
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
            <Button disabled={submitting || batches.length === 0} onClick={finish}>
              {submitting ? 'Creating facility…' : 'Finish setup'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
