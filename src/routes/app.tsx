import { useCallback, useEffect, useState } from 'react'
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { useRole } from '@/hooks/useRole'
import { supabase } from '@/lib/supabase'

export const Route = createFileRoute('/app')({
  beforeLoad: async ({ location }) => {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) throw redirect({ to: '/login' })

    // A session without a profile means organization creation never completed
    // (e.g. the signup RPC failed after auth succeeded). Send those users to
    // the recovery route instead of rendering the app with no role. On a query
    // error we let the page render and surface it rather than misclassifying.
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', session.user.id)
      .maybeSingle()

    const onSetup = location.pathname.startsWith('/app/setup')
    if (!error && !profile && !onSetup) {
      // A profile-less session is either a staff user whose org creation
      // failed, or a customer who only ever booked (customers row, no
      // membership). Send customers to their bookings instead of offering
      // org creation, which is the staff-only recovery path.
      const { data: customer } = await supabase
        .from('customers')
        .select('id')
        .eq('user_id', session.user.id)
        .limit(1)
        .maybeSingle()
      throw redirect({ to: customer ? '/my/reservations' : '/app/setup' })
    }
    if (profile && onSetup) throw redirect({ to: '/app' })
  },
  component: AppLayout,
})

function AppLayout() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { role, full_name: fullName } = useRole()
  // A staff user who has also booked as a customer (a customers row linked to
  // this login) gets a persistent link to their own bookings, so they never
  // have to switch accounts. Staff who never booked don't see it.
  const [hasCustomerRecord, setHasCustomerRecord] = useState(false)

  const loadCustomerRecord = useCallback(async () => {
    if (!user) {
      setHasCustomerRecord(false)
      return
    }
    const { data } = await supabase
      .from('customers')
      .select('id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle()
    setHasCustomerRecord(!!data)
  }, [user])

  useEffect(() => {
    void Promise.resolve().then(loadCustomerRecord)
  }, [loadCustomerRecord])

  async function signOut() {
    await supabase.auth.signOut()
    await navigate({ to: '/login' })
  }

  return (
    <AppShell
      sidebar={
        <div className="flex h-full flex-col justify-between gap-8">
          <ul className="space-y-1 text-sm">
            <li>
              <NavLink to="/app">Dashboard</NavLink>
            </li>
            <li>
              <NavLink to="/app/onboarding">Onboarding</NavLink>
            </li>
            {(role === 'admin' || role === 'manager' || role === 'attendant') && (
              <>
                <li>
                  <NavLink to="/app/availability">Availability</NavLink>
                </li>
                <li>
                  <NavLink to="/app/reservations">Reservations</NavLink>
                </li>
              </>
            )}
            {(role === 'admin' || role === 'manager') && (
              <>
                <li>
                  <NavLink to="/app/facilities">Facilities</NavLink>
                </li>
                <li>
                  <NavLink to="/app/override">Override</NavLink>
                </li>
              </>
            )}
            {role === 'admin' && (
              <li>
                <NavLink to="/app/staff">Staff</NavLink>
              </li>
            )}
          </ul>
          <div className="space-y-2 border-t pt-4">
            {fullName && (
              <p className="truncate text-xs text-muted-foreground">{fullName}</p>
            )}
            {hasCustomerRecord && (
              <Button variant="ghost" className="w-full" asChild>
                <Link to="/my/reservations">My reservations</Link>
              </Button>
            )}
            <Button variant="outline" className="w-full" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      }
    >
      <Outlet />
    </AppShell>
  )
}

function NavLink({
  to,
  children,
}: {
  to:
    | '/app'
    | '/app/onboarding'
    | '/app/staff'
    | '/app/facilities'
    | '/app/availability'
    | '/app/reservations'
    | '/app/override'
  children: string
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === '/app' }}
      className="block rounded-md px-3 py-2 font-medium hover:bg-muted"
      activeProps={{ className: 'bg-muted text-foreground' }}
    >
      {children}
    </Link>
  )
}
