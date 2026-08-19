import { createFileRoute } from '@tanstack/react-router'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageSpinner } from '@/components/ui/Spinner'
import { useRole } from '@/hooks/useRole'

export const Route = createFileRoute('/app/')({
  component: Dashboard,
})

function Dashboard() {
  const { role, org_id: orgId, loading, error } = useRole()

  if (loading) return <PageSpinner />

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-muted-foreground">Your ParkOS workspace is ready.</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Your role</CardTitle>
          </CardHeader>
          <CardContent className="capitalize">
            {role?.replace('_', ' ') ?? 'Not assigned'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Organization</CardTitle>
          </CardHeader>
          <CardContent className="break-all text-muted-foreground">
            {orgId ?? 'Onboarding required'}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
