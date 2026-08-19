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
import { AuthPage, Field } from '@/routes/login'

type InviteSearch = {
  token: string
  email: string
}

export const Route = createFileRoute('/accept-invite')({
  validateSearch: (search: Record<string, unknown>): InviteSearch => ({
    token: typeof search.token === 'string' ? search.token : '',
    email: typeof search.email === 'string' ? search.email : '',
  }),
  component: AcceptInvite,
})

function AcceptInvite() {
  const navigate = useNavigate()
  const { token, email } = Route.useSearch()
  const { user, loading: authLoading } = useAuth()
  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function accept() {
    if (!token) {
      setError('This invite link is missing its token.')
      return false
    }

    const { error: inviteError } = await supabase.rpc('accept_invite', {
      p_token: token,
    })

    if (inviteError) {
      setError(inviteError.message)
      return false
    }

    await navigate({ to: '/app' })
    return true
  }

  async function authenticate(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    setSubmitting(true)

    if (!email) {
      setSubmitting(false)
      setError('This invite link is missing its email address.')
      return
    }

    if (mode === 'signup') {
      const { data, error: signupError } = await supabase.auth.signUp({
        email,
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
        setMessage('Confirm your email, then return to this link and log in.')
        setMode('login')
        return
      }
    } else {
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (loginError) {
        setSubmitting(false)
        setError(loginError.message)
        return
      }
    }

    await accept()
    setSubmitting(false)
  }

  if (authLoading) {
    return <AuthPage><p className="text-center text-muted-foreground">Checking session…</p></AuthPage>
  }

  return (
    <AuthPage>
      <Card>
        <CardHeader>
          <CardTitle>Join a ParkOS team</CardTitle>
          <CardDescription>
            This invitation is tied to the email address below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {user ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Signed in as <span className="font-medium text-foreground">{user.email}</span>
              </p>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button
                className="w-full"
                disabled={submitting || !token}
                onClick={async () => {
                  setSubmitting(true)
                  setError(null)
                  await accept()
                  setSubmitting(false)
                }}
              >
                {submitting ? 'Accepting…' : 'Accept invitation'}
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={mode === 'signup' ? 'default' : 'outline'}
                  onClick={() => setMode('signup')}
                >
                  Create account
                </Button>
                <Button
                  variant={mode === 'login' ? 'default' : 'outline'}
                  onClick={() => setMode('login')}
                >
                  Log in
                </Button>
              </div>
              <form className="space-y-4" onSubmit={authenticate}>
                {mode === 'signup' && (
                  <Field label="Your name">
                    <Input required value={fullName} onChange={(event) => setFullName(event.target.value)} />
                  </Field>
                )}
                <Field label="Invited email">
                  <Input type="email" value={email} readOnly />
                </Field>
                <Field label="Password">
                  <Input
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    minLength={8}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
                {error && <p className="text-sm text-destructive">{error}</p>}
                {message && <p className="text-sm text-muted-foreground">{message}</p>}
                <Button className="w-full" type="submit" disabled={submitting || !token || !email}>
                  {submitting
                    ? 'Working…'
                    : mode === 'signup'
                      ? 'Create account and join'
                      : 'Log in and join'}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </AuthPage>
  )
}
