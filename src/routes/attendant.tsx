import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { PageSpinner } from '@/components/ui/Spinner'
import { useRole } from '@/hooks/useRole'
import {
  AttendantContext,
  bigInput,
  tapTarget,
  type AttendantFacility,
} from '@/lib/attendant-ui'
import { supabase } from '@/lib/supabase'

// Deliberately NOT app.tsx's AppShell. The attendant surface is a physically
// different screen: a minimal top bar, one centered column at every width, and
// large tap targets — no sidebar, no dashboard. The context and control styles
// live in `@/lib/attendant-ui` so child routes share a single context instance.

const FACILITY_KEY = 'parkos.attendant.facility'

export const Route = createFileRoute('/attendant')({
  beforeLoad: async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) throw redirect({ to: '/login' })

    // Staff only. A customer (no membership) is sent to their own area rather
    // than the booth screen.
    const { data: membership } = await supabase
      .from('memberships')
      .select('role')
      .eq('user_id', session.user.id)
      .limit(1)
      .maybeSingle()
    if (!membership) throw redirect({ to: '/my/reservations' })
  },
  component: AttendantLayout,
})

function AttendantLayout() {
  const navigate = useNavigate()
  const { org_id: orgId, loading: roleLoading } = useRole()
  const [facilities, setFacilities] = useState<AttendantFacility[]>([])
  const [facilityId, setFacilityId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!orgId) return
    const { data } = await supabase
      .from('facilities')
      .select('id, name, timezone')
      .eq('org_id', orgId)
      .is('archived_at', null)
      .order('name')
    const list = (data ?? []) as AttendantFacility[]
    setFacilities(list)
    const stored = window.localStorage.getItem(FACILITY_KEY)
    const initial =
      list.find((f) => f.id === stored)?.id ?? list[0]?.id ?? null
    setFacilityId(initial)
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    if (!roleLoading) void Promise.resolve().then(load)
  }, [roleLoading, load])

  function chooseFacility(id: string) {
    setFacilityId(id)
    window.localStorage.setItem(FACILITY_KEY, id)
  }

  async function signOut() {
    await supabase.auth.signOut()
    await navigate({ to: '/login' })
  }

  const facility = useMemo(
    () => facilities.find((f) => f.id === facilityId) ?? null,
    [facilities, facilityId],
  )

  if (roleLoading || loading) return <PageSpinner />

  return (
    <AttendantContext.Provider value={{ orgId: orgId!, facility }}>
      <div className="min-h-screen bg-muted/30">
        <header className="sticky top-0 z-10 border-b bg-background">
          <div className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-lg font-semibold tracking-tight">
                ParkOS Booth
              </span>
              <button
                onClick={signOut}
                className="min-h-11 rounded-lg px-3 text-base font-medium text-muted-foreground hover:bg-muted"
              >
                Sign out
              </button>
            </div>

            {facilities.length > 1 ? (
              <select
                aria-label="Facility"
                className={bigInput}
                value={facilityId ?? ''}
                onChange={(event) => chooseFacility(event.target.value)}
              >
                {facilities.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-base text-muted-foreground">
                {facility?.name ?? 'No facility'}
              </span>
            )}

            <nav className="grid grid-cols-2 gap-2">
              <AttendantTab to="/attendant">Search</AttendantTab>
              <AttendantTab to="/attendant/active">Active</AttendantTab>
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-xl px-4 py-5">
          {facility ? (
            <Outlet />
          ) : (
            <p className="py-10 text-center text-base text-muted-foreground">
              No active facility on this account.
            </p>
          )}
        </main>
      </div>
    </AttendantContext.Provider>
  )
}

function AttendantTab({
  to,
  children,
}: {
  to: '/attendant' | '/attendant/active'
  children: string
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === '/attendant' }}
      className={`flex items-center justify-center rounded-lg border px-4 text-base font-medium ${tapTarget}`}
      activeProps={{ className: 'bg-primary text-primary-foreground border-primary' }}
      inactiveProps={{ className: 'bg-background hover:bg-muted' }}
    >
      {children}
    </Link>
  )
}
