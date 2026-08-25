import { useCallback, useEffect, useState } from 'react'
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageSpinner } from '@/components/ui/Spinner'
import { SUPPORT_EMAIL } from '@/lib/account'
import { friendlyError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

export const Route = createFileRoute('/my/settings')({
  beforeLoad: async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) throw redirect({ to: '/login' })
  },
  component: MySettings,
})

function MySettings() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Mirrors the server-side block in deactivate_account(): anything not yet
  // cancelled still has a live subscription behind it.
  const [billedPermits, setBilledPermits] = useState<number | null>(null)

  const loadPermits = useCallback(async () => {
    const { data } = await supabase.rpc('get_my_permits')
    const rows = (data ?? []) as { status: string }[]
    setBilledPermits(rows.filter((row) => row.status !== 'cancelled').length)
  }, [])

  useEffect(() => {
    void Promise.resolve().then(loadPermits)
  }, [loadPermits])

  async function deactivate() {
    setBusy(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc('deactivate_account')
    if (rpcError) {
      setBusy(false)
      setError(
        friendlyError(
          rpcError,
          'Your account could not be deactivated. Please try again.',
        ),
      )
      return
    }
    // The function revokes server-side sessions; this clears the JWT this tab
    // is still holding.
    await supabase.auth.signOut()
    toast.success('Your account has been deactivated.')
    await navigate({ to: '/login' })
  }

  if (billedPermits === null) return <PageSpinner />

  return (
    <div className="min-h-screen bg-muted/30 px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <Link
            to="/my/reservations"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            <ArrowLeft className="size-3.5" />
            My reservations
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            Account settings
          </h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Deactivate account</CardTitle>
            <CardDescription>
              Close your ParkOS account and sign out of every device. Your
              booking history stays on file.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {billedPermits > 0 ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
                <p className="font-medium text-destructive">
                  You have an active permit subscription. Please cancel it
                  before deactivating your account.
                </p>
                <p className="mt-1 text-muted-foreground">
                  Permits are managed by the parking operator.{' '}
                  <Link
                    to="/my/reservations"
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    View your permits
                  </Link>{' '}
                  for the facility to contact.
                </p>
              </div>
            ) : (
              <Button variant="destructive" onClick={() => setOpen(true)}>
                Deactivate account
              </Button>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate account</DialogTitle>
            <DialogDescription>
              Please read this before confirming.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-2 pl-4 text-muted-foreground">
            <li>
              Your account is deactivated and you are logged out immediately.
            </li>
            <li>
              Your reservation and payment history is retained for our records.
            </li>
            <li>
              This does <strong className="text-foreground">not</strong> delete
              your data. To request full deletion, email{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="font-medium text-foreground underline underline-offset-4"
              >
                {SUPPORT_EMAIL}
              </a>
              .
            </li>
          </ul>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Keep my account
            </Button>
            <Button variant="destructive" disabled={busy} onClick={deactivate}>
              {busy ? 'Deactivating…' : 'Deactivate account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
