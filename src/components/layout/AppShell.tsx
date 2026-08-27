import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  Bell,
  ChevronDown,
  ChevronsLeft,
  Command,
  LogOut,
  Menu,
  Search,
  UserRound,
  X,
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { FacilityOption } from '@/hooks/useFacility'
import { useDashboardConnection } from '@/hooks/useDashboardConnection'
import { cn } from '@/lib/utils'
import { StatusIndicator } from './PagePrimitives'

type AppShellProps = {
  sidebar: (collapsed: boolean) => ReactNode
  children: ReactNode
  facilities: FacilityOption[]
  facilityId: string
  onFacilityChange: (id: string) => void
  fullName: string | null
  roleLabel: string
  hasCustomerRecord: boolean
  onSignOut: () => void
}

const pageTitles: Record<string, string> = {
  '/app': 'Dashboard',
  '/app/booking/manifest': 'Daily Manifest',
  '/app/occupancy': 'Occupancy',
  '/app/availability': 'Availability',
  '/app/reservations': 'Reservations',
  '/app/facilities': 'Facilities',
  '/app/permits': 'Permits',
  '/app/override': 'Override',
  '/app/staff': 'Staff',
  '/app/reports': 'Reports',
  '/app/onboarding': 'Onboarding',
}

export function AppShell(props: AppShellProps) {
  const { status, updatedAt } = useDashboardConnection()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const pageTitle = useMemo(() => {
    const key = Object.keys(pageTitles)
      .sort((a, b) => b.length - a.length)
      .find((route) => pathname === route || pathname.startsWith(`${route}/`))
    return key ? pageTitles[key] : 'Workspace'
  }, [pathname])

  useEffect(() => {
    if (!mobileOpen) return
    closeRef.current?.focus()
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
      if (event.key !== 'Tab' || !drawerRef.current) return
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = priorOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [mobileOpen])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((open) => !open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const sidebarInner = (isMobile: boolean) => (
    <>
      <div className="flex h-16 items-center justify-between px-4">
        <Link
          to="/app"
          className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sidebar-ring"
        >
          <BrandMark />
          {(isMobile || !collapsed) && (
            <span className="text-lg font-semibold tracking-[-0.04em] text-sidebar-foreground">
              Park<span className="text-sidebar-muted">OS</span>
            </span>
          )}
        </Link>
        {isMobile && (
          <button
            ref={closeRef}
            type="button"
            onClick={() => setMobileOpen(false)}
            className="sidebar-icon-button"
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <nav
        className="sidebar-nav-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4"
        aria-label="Primary navigation"
        onClick={(event) => {
          if (isMobile && (event.target as HTMLElement).closest('a')) {
            setMobileOpen(false)
          }
        }}
      >
        {props.sidebar(isMobile ? false : collapsed)}
      </nav>
      <div className="border-t border-white/8 p-3">
        {props.hasCustomerRecord && (
          <Link
            to="/my/reservations"
            className="sidebar-footer-link"
            title="My reservations"
          >
            <UserRound className="size-4 shrink-0" />
            {(isMobile || !collapsed) && <span>My reservations</span>}
          </Link>
        )}
        <div
          className={cn(
            'mt-1 flex items-center gap-2 rounded-md border border-sidebar-border/25 bg-sidebar-foreground/[0.04] p-2',
            !isMobile && collapsed && 'justify-center',
          )}
        >
          <Avatar name={props.fullName} />
          {(isMobile || !collapsed) && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-sidebar-foreground">
                {props.fullName || 'ParkOS user'}
              </p>
              <p className="mt-0.5 truncate text-[10px] capitalize text-sidebar-muted">
                {props.roleLabel}
              </p>
            </div>
          )}
          {(isMobile || !collapsed) && (
            <button
              type="button"
              onClick={props.onSignOut}
              className="sidebar-icon-button"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="size-4" />
            </button>
          )}
        </div>
        {!isMobile && (
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="mt-2 flex h-9 w-full items-center justify-center rounded-md text-sidebar-muted hover:bg-sidebar-foreground/6 hover:text-sidebar-foreground"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <ChevronsLeft className={cn('size-4', collapsed && 'rotate-180')} />
          </button>
        )}
      </div>
    </>
  )

  return (
    <div className="app-shell min-h-screen bg-background">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-sidebar-border/30 bg-sidebar text-sidebar-foreground md:flex',
          collapsed ? 'w-[76px]' : 'w-[264px]',
        )}
      >
        {sidebarInner(false)}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-sidebar/70"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation overlay"
          />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="overlay-surface relative flex h-full w-[min(86vw,320px)] flex-col bg-sidebar text-sidebar-foreground"
          >
            {sidebarInner(true)}
          </aside>
        </div>
      )}
      <div
        className={cn(
          'min-h-screen min-w-0',
          collapsed ? 'md:pl-[76px]' : 'md:pl-[264px]',
        )}
      >
        <header className="command-bar sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="command-icon-button md:hidden"
            aria-label="Open navigation"
          >
            <Menu className="size-4" />
          </button>
          <div className="hidden min-w-0 sm:block">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Operations
            </p>
            <p className="truncate text-sm font-semibold">{pageTitle}</p>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {props.facilities.length > 0 && (
              <Select
                value={props.facilityId}
                onValueChange={props.onFacilityChange}
              >
                <SelectTrigger
                  className="selected-surface h-9 w-[118px] border-border bg-card text-xs shadow-none sm:w-[190px]"
                  aria-label="Active facility"
                >
                  <SelectValue placeholder="Facility" />
                </SelectTrigger>
                <SelectContent>
                  {props.facilities.map((facility) => (
                    <SelectItem key={facility.id} value={facility.id}>
                      {facility.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="selected-surface hidden h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:border-foreground hover:text-foreground lg:flex"
            >
              <Search className="size-3.5" />
              <span>Quick find</span>
              <kbd className="ml-4 rounded-sm border bg-muted px-1.5 py-0.5 font-data text-[9px]">
                ⌘K
              </kbd>
            </button>
            <div className="hidden border-l pl-3 xl:block">
              <StatusIndicator status={status} updatedAt={updatedAt} />
            </div>
            <button
              type="button"
              className="command-icon-button hidden sm:grid"
              aria-label="Notifications"
              title="No new notifications"
            >
              <Bell className="size-4" />
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setProfileOpen((open) => !open)}
                className="selected-surface flex h-9 items-center gap-2 rounded-md border border-border bg-card px-1.5 pr-2"
                aria-label="Open user menu"
                aria-expanded={profileOpen}
              >
                <Avatar name={props.fullName} light />
                <ChevronDown className="size-3 text-muted-foreground" />
              </button>
              {profileOpen && (
                <div className="overlay-surface absolute right-0 top-11 w-56 border bg-popover p-2">
                  <div className="px-2 py-2">
                    <p className="truncate text-sm font-medium">
                      {props.fullName || 'ParkOS user'}
                    </p>
                    <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                      {props.roleLabel}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={props.onSignOut}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
                  >
                    <LogOut className="size-4" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="min-w-0 overflow-x-hidden px-4 py-5 sm:px-6 xl:px-8">
          {props.children}
        </main>
      </div>
      {commandOpen && <QuickFind onClose={() => setCommandOpen(false)} />}
    </div>
  )
}

function BrandMark() {
  return (
    <span className="brand-ticket" aria-hidden="true">
      <span className="text-xs font-black tracking-[-0.08em]">P</span>
    </span>
  )
}
function Avatar({
  name,
  light = false,
}: {
  name: string | null
  light?: boolean
}) {
  const initials = (name || 'ParkOS user')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
  return (
    <span
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md text-[10px] font-bold',
        light
          ? 'bg-primary text-primary-foreground'
          : 'bg-sidebar-foreground/10 text-sidebar-foreground',
      )}
    >
      {initials}
    </span>
  )
}

const quickLinks = [
  { to: '/app', label: 'Dashboard' },
  { to: '/app/booking/manifest', label: 'Daily manifest' },
  { to: '/app/occupancy', label: 'Live occupancy' },
  { to: '/app/reservations', label: 'Reservations' },
  { to: '/app/reports', label: 'Reports' },
] as const
function QuickFind({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLAnchorElement>('a')?.focus()
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-sidebar/60 px-4 pt-[14vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Quick find"
    >
      <button
        type="button"
        className="absolute inset-0"
        onClick={onClose}
        aria-label="Close quick find"
      />
      <div
        ref={dialogRef}
        className="overlay-surface relative w-full max-w-lg overflow-hidden border bg-popover"
      >
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Command className="size-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Quick find</p>
            <p className="text-[11px] text-muted-foreground">
              Navigate to a ParkOS workspace
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="command-icon-button ml-auto"
            aria-label="Close quick find"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="p-2">
          {quickLinks.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={onClose}
              className="selected-surface flex items-center justify-between rounded-md px-3 py-3 text-sm font-medium hover:bg-muted focus-visible:bg-muted"
            >
              <span>{item.label}</span>
              <span className="text-xs text-muted-foreground">Open</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
