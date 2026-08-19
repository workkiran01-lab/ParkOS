import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { supabase } from '@/lib/supabase'
import { AuthPage, Field } from '@/routes/login'

export const Route = createFileRoute('/signup')({
  beforeLoad: async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (session) throw redirect({ to: '/app' })
  },
  component: Signup,
})

function Signup() {
  const navigate = useNavigate()
  const [fullName, setFullName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    setSubmitting(true)

    const { data, error: signupError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { full_name: fullName.trim() } },
    })

    if (signupError) {
      setSubmitting(false)
      setError(signupError.message)
      return
    }

    if (!data.session) {
      setSubmitting(false)
      setMessage('Check your email to confirm your account, then log in to continue.')
      return
    }

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
    <AuthPage>
      <Card>
        <CardHeader>
          <CardTitle>Create your ParkOS account</CardTitle>
          <CardDescription>
            You’ll be the administrator for a new organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Your name">
              <Input required value={fullName} onChange={(event) => setFullName(event.target.value)} />
            </Field>
            <Field label="Organization name">
              <Input required value={orgName} onChange={(event) => setOrgName(event.target.value)} />
            </Field>
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
                autoComplete="new-password"
                minLength={8}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>
          <p className="mt-5 text-center text-sm text-muted-foreground">
            Already registered?{' '}
            <Link to="/login" className="font-medium text-foreground underline">
              Log in
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthPage>
  )
}
