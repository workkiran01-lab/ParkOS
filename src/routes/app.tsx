import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
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
  CalendarPlus,
  ClipboardList,
  ChevronDown,
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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    () => {
      try {
        const stored: unknown = JSON.parse(
          sessionStorage.getItem('parkos.nav.groups') ?? '{}',
        )
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
          return Object.fromEntries(
            Object.entries(stored).filter(
              ([, value]) => typeof value === 'boolean',
            ),
          )
        }
      } catch {
        /* Storage can be unavailable in a private browser session. */
      }
      return {}
    },
  )
  function toggleGroup(label: string) {
    setExpandedGroups((current) => {
      const next = { ...current, [label]: current[label] === false }
      try {
        sessionStorage.setItem('parkos.nav.groups', JSON.stringify(next))
      } catch {
        /* Keep in-memory state. */
      }
      return next
    })
  }
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
    const options = rows.map(({ id, name, timezone }) => ({
      id,
      name,
      timezone,
    }))
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
            <div className="space-y-4">
              <NavItem
                to="/app"
                label="Dashboard"
                icon={LayoutDashboard}
                collapsed={collapsed}
              />
              {operations && (
                <NavGroup
                  label="Booking"
                  collapsed={collapsed}
                  expanded={expandedGroups.Booking !== false}
                  onToggle={toggleGroup}
                >
                  <NavItem
                    to="/app/booking/manifest"
                    label="Daily Manifest"
                    icon={ClipboardList}
                    collapsed={collapsed}
                  />
                  <NavItem
                    to="/app/booking/new"
                    label="New Booking"
                    icon={CalendarPlus}
                    collapsed={collapsed}
                  />
                  <NavItem
                    to="/app/reservations"
                    label="Reservations"
                    icon={CalendarDays}
                    collapsed={collapsed}
                  />
                  <NavItem
                    to="/app/availability"
                    label="Availability"
                    icon={ParkingSquare}
                    collapsed={collapsed}
                  />
                  <NavItem
                    to="/attendant"
                    label="Booth"
                    icon={SquareParking}
                    collapsed={collapsed}
                  />
                </NavGroup>
              )}
              {role === 'admin' && (
                <NavItem
                  to="/app/staff"
                  label="Employees"
                  icon={UserCog}
                  collapsed={collapsed}
                />
              )}
              {operations && (
                <NavGroup
                  label="Operations"
                  collapsed={collapsed}
                  expanded={expandedGroups.Operations !== false}
                  onToggle={toggleGroup}
                >
                  <NavItem
                    to="/app/occupancy"
                    label="Occupancy"
                    icon={Gauge}
                    collapsed={collapsed}
                  />
                  {management && (
                    <>
                      <NavItem
                        to="/app/permits"
                        label="Permits"
                        icon={TicketCheck}
                        collapsed={collapsed}
                      />
                      <NavItem
                        to="/app/reports"
                        label="Reports"
                        icon={BarChart3}
                        collapsed={collapsed}
                      />
                    </>
                  )}
                </NavGroup>
              )}
              {management && (
                <NavGroup
                  label="Management"
                  collapsed={collapsed}
                  expanded={expandedGroups.Management !== false}
                  onToggle={toggleGroup}
                >
                  <NavItem
                    to="/app/facilities"
                    label="Facilities"
                    icon={Warehouse}
                    collapsed={collapsed}
                  />
                  <NavItem
                    to="/app/override"
                    label="Override"
                    icon={SlidersHorizontal}
                    collapsed={collapsed}
                  />
                </NavGroup>
              )}
              {!facilitiesLoading && facilities.length === 0 && (
                <NavGroup
                  label="Setup"
                  collapsed={collapsed}
                  expanded={expandedGroups.Setup !== false}
                  onToggle={toggleGroup}
                >
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
  expanded,
  onToggle,
  children,
}: {
  label: string
  collapsed: boolean
  expanded: boolean
  onToggle: (label: string) => void
  children: ReactNode
}) {
  const contentId = useId()
  return (
    <section aria-label={label}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={label}
        title={collapsed ? label : undefined}
        onClick={() => onToggle(label)}
        className={cn(
          'mb-2 flex w-full items-center justify-between rounded-md px-3 py-2 text-xs font-semibold text-sidebar-muted hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-sidebar-ring',
          collapsed && 'justify-center px-0',
        )}
      >
        {!collapsed && <span>{label}</span>}
        <ChevronDown
          className={cn(
            'size-3.5 transition-transform',
            !expanded && '-rotate-90',
          )}
          aria-hidden="true"
        />
      </button>
      <div id={contentId} hidden={!expanded} className="space-y-1">
        {children}
      </div>
    </section>
  )
}

type AppPath =
  | '/app'
  | '/app/booking/manifest'
  | '/app/booking/new'
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
