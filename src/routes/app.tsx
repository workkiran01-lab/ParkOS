import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import {
  BarChart3,
  CalendarDays,
  ClipboardList,
  Gauge,
  LayoutDashboard,
  ParkingSquare,
  SlidersHorizontal,
  Sparkles,
  SquareParking,
  TicketCheck,
  UserCog,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { DashboardConnectionProvider } from '@/hooks/useDashboardConnection'
import {
  FacilityProvider,
  type FacilityOption,
  type FacilitySummary,
} from '@/hooks/useFacility'
import { useAuth } from '@/hooks/useAuth'
import { useRole } from '@/hooks/useRole'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/app')({
  beforeLoad: async ({ location }) => {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) throw redirect({ to: '/login' })
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', session.user.id)
      .maybeSingle()
    const onSetup = location.pathname.startsWith('/app/setup')
    if (!error && !profile && !onSetup) {
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
  const { role, org_id: orgId, full_name: fullName } = useRole()
  const [hasCustomerRecord, setHasCustomerRecord] = useState(false)
  const [facilities, setFacilities] = useState<FacilityOption[]>([])
  const [allFacilities, setAllFacilities] = useState<FacilitySummary[]>([])
  const [facilityId, setFacilityId] = useState('')
  const [facilitiesLoading, setFacilitiesLoading] = useState(true)
  const [facilitiesError, setFacilitiesError] = useState<{
    message: string
  } | null>(null)

  const loadShellData = useCallback(async () => {
    if (!user || !orgId) return
    const [customerResult, facilityResult] = await Promise.all([
      supabase
        .from('customers')
        .select('id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle(),
      supabase
        .from('facilities')
        // timezone: the daily manifest bins by the facility's local day, not
        // the browser's.
        .select('id, name, timezone, archived_at')
        .eq('org_id', orgId)
        .order('name'),
    ])
    setHasCustomerRecord(!!customerResult.data)
    const rows = (facilityResult.data ?? []) as (FacilityOption & {
      archived_at: string | null
    })[]
    const options = rows.map(({ id, name }) => ({ id, name }))
    const activeOptions = rows
      .filter((facility) => facility.archived_at === null)
      .map(({ id, name, timezone }) => ({ id, name, timezone }))
    setAllFacilities(options)
    setFacilities(activeOptions)
    setFacilityId((current) => current || activeOptions[0]?.id || '')
    setFacilitiesError(facilityResult.error)
    setFacilitiesLoading(false)
  }, [orgId, user])

  useEffect(() => {
    void Promise.resolve().then(loadShellData)
  }, [loadShellData])
  async function signOut() {
    await supabase.auth.signOut()
    await navigate({ to: '/login' })
  }
  const operations =
    role === 'admin' || role === 'manager' || role === 'attendant'
  const management = role === 'admin' || role === 'manager'

  return (
    <FacilityProvider
      value={{
        facilities,
        allFacilities,
        facilityId,
        setFacilityId,
        loading: facilitiesLoading,
        error: facilitiesError,
      }}
    >
      <DashboardConnectionProvider>
        <AppShell
          facilities={facilities}
          facilityId={facilityId}
          onFacilityChange={setFacilityId}
          fullName={fullName}
          roleLabel={role?.replace('_', ' ') ?? 'Staff'}
          hasCustomerRecord={hasCustomerRecord}
          onSignOut={signOut}
          sidebar={(collapsed) => (
          <div className="space-y-6">
            <NavGroup label="Overview" collapsed={collapsed}>
              <NavItem
                to="/app"
                label="Dashboard"
                icon={LayoutDashboard}
                collapsed={collapsed}
              />
            </NavGroup>
            {operations && (
              <NavGroup label="Booking" collapsed={collapsed}>
                <NavItem
                  to="/app/booking/manifest"
                  label="Daily Manifest"
                  icon={ClipboardList}
                  collapsed={collapsed}
                />
                {/* Booth keeps its own full-screen layout outside AppShell;
                    only its position in the sidebar moved. */}
                <NavItem
                  to="/attendant"
                  label="Booth"
                  icon={SquareParking}
                  collapsed={collapsed}
                />
              </NavGroup>
            )}
            {operations && (
              <NavGroup label="Operations" collapsed={collapsed}>
                <NavItem
                  to="/app/occupancy"
                  label="Occupancy"
                  icon={Gauge}
                  collapsed={collapsed}
                />
                <NavItem
                  to="/app/availability"
                  label="Availability"
                  icon={ParkingSquare}
                  collapsed={collapsed}
                />
                <NavItem
                  to="/app/reservations"
                  label="Reservations"
                  icon={CalendarDays}
                  collapsed={collapsed}
                />
              </NavGroup>
            )}
            {management && (
              <NavGroup label="Management" collapsed={collapsed}>
                <NavItem
                  to="/app/facilities"
                  label="Facilities"
                  icon={Warehouse}
                  collapsed={collapsed}
                />
                <NavItem
                  to="/app/permits"
                  label="Permits"
                  icon={TicketCheck}
                  collapsed={collapsed}
                />
                <NavItem
                  to="/app/override"
                  label="Override"
                  icon={SlidersHorizontal}
                  collapsed={collapsed}
                />
                {role === 'admin' && (
                  <NavItem
                    to="/app/staff"
                    label="Staff"
                    icon={UserCog}
                    collapsed={collapsed}
                  />
                )}
              </NavGroup>
            )}
            {management && (
              <NavGroup label="Insights" collapsed={collapsed}>
                <NavItem
                  to="/app/reports"
                  label="Reports"
                  icon={BarChart3}
                  collapsed={collapsed}
                />
              </NavGroup>
            )}
            {!facilitiesLoading && facilities.length === 0 && (
              <NavGroup label="Setup" collapsed={collapsed}>
                <NavItem
                  to="/app/onboarding"
                  label="Onboarding"
                  icon={Sparkles}
                  collapsed={collapsed}
                />
              </NavGroup>
            )}
          </div>
          )}
        >
          <Outlet />
        </AppShell>
      </DashboardConnectionProvider>
    </FacilityProvider>
  )
}

function NavGroup({
  label,
  collapsed,
  children,
}: {
  label: string
  collapsed: boolean
  children: ReactNode
}) {
  return (
    <section>
      {collapsed ? (
        <div className="mx-auto mb-2 h-px w-5 bg-white/10" />
      ) : (
        <p className="mb-2 px-3 text-[9px] font-semibold uppercase tracking-[0.18em] text-sidebar-muted/70">
          {label}
        </p>
      )}
      <div className="space-y-1">{children}</div>
    </section>
  )
}

type AppPath =
  | '/app'
  | '/app/booking/manifest'
  | '/app/onboarding'
  | '/app/staff'
  | '/app/facilities'
  | '/app/permits'
  | '/app/occupancy'
  | '/app/availability'
  | '/app/reservations'
  | '/app/override'
  | '/app/reports'
  | '/attendant'
function NavItem({
  to,
  label,
  icon: Icon,
  collapsed,
}: {
  to: AppPath
  label: string
  icon: LucideIcon
  collapsed: boolean
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === '/app' }}
      title={collapsed ? label : undefined}
      className={cn('sidebar-nav-link', collapsed && 'justify-center px-0')}
      activeProps={{ className: 'sidebar-nav-link-active' }}
    >
      <Icon className="size-[17px] shrink-0" aria-hidden="true" />
      {!collapsed && <span>{label}</span>}
    </Link>
  )
}
