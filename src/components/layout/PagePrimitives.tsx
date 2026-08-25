import type { LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectionStatus } from '@/hooks/useDashboardConnection'
import { cn } from '@/lib/utils'

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="max-w-2xl">
        {eyebrow && <p className="signage-label text-primary">{eyebrow}</p>}
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  )
}

export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
}: {
  label: string
  value: ReactNode
  hint: string
  icon: LucideIcon
  tone?: 'neutral' | 'available' | 'occupied' | 'revenue'
}) {
  return (
    <section className="metric-card group">
      <div className={cn('metric-icon', `metric-icon-${tone}`)}>
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <p className="mt-4 text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 font-data text-3xl font-semibold tracking-[-0.05em] sm:text-4xl">
        {value}
      </p>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
    </section>
  )
}

export function SectionCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('section-card', className)}>
      <header className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4 sm:px-6">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

export function StatusIndicator({
  status,
  updatedAt,
  showUpdated = true,
}: {
  status: ConnectionStatus
  updatedAt?: number | null
  showUpdated?: boolean
}) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!updatedAt || !showUpdated) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [showUpdated, updatedAt])

  const label = {
    connecting: 'Connecting',
    live: 'Live',
    stale: 'Stale',
    unavailable: 'Unavailable',
  }[status]
  const tone = {
    connecting: 'warning',
    live: 'live',
    stale: 'warning',
    unavailable: 'quiet',
  }[status]
  const seconds = updatedAt
    ? Math.max(0, Math.floor((now - updatedAt) / 1000))
    : null

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium text-muted-foreground">
      <span
        className={cn('status-dot', `status-dot-${tone}`)}
        aria-hidden="true"
      />
      {label}
      {showUpdated && seconds != null && (
        <span className="font-normal text-muted-foreground/80">
          · Updated {seconds} {seconds === 1 ? 'second' : 'seconds'} ago
        </span>
      )}
    </span>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-6 py-10 text-center">
      <span className="grid size-10 place-items-center rounded-xl border bg-muted/60 text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  )
}
