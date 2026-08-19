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
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { Field } from '@/routes/login'

// Recovery route for users who have a session but no profile — typically
// because create_organization_with_admin failed after signup. Re-offers the
// organization-creation step so they aren't stuck with no role.
export const Route = createFileRoute('/app/setup')({
  component: Setup,
})

function Setup() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [orgName, setOrgName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const { error: orgError } = await supabase.rpc(
      'create_organization_with_admin',
      { p_org_name: orgName.trim() },
    )

    setSubmitting(false)
    if (orgError) {
      setError(orgError.message)
      return
    }

    await navigate({ to: '/app/onboarding' })
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>Finish setting up your account</CardTitle>
        <CardDescription>
          {user?.email ? (
            <>
              <span className="font-medium text-foreground">{user.email}</span>{' '}
              is signed in but doesn’t belong to an organization yet. Create one
              to continue — you’ll be its administrator.
            </>
          ) : (
            'Your account doesn’t belong to an organization yet. Create one to continue.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Organization name">
            <Input
              required
              value={orgName}
              onChange={(event) => setOrgName(event.target.value)}
            />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button className="w-full" type="submit" disabled={submitting}>
            {submitting ? 'Creating organization…' : 'Create organization'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
