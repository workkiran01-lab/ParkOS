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
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="max-w-2xl">
        {eyebrow && <p className="signage-label text-primary">{eyebrow}</p>}
        <h1 className="mt-1.5 text-2xl font-bold leading-tight tracking-[-0.035em] sm:text-3xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-xl text-sm leading-5 text-muted-foreground/75">
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
    <section className={cn('metric-card', `metric-card-${tone}`)}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/75">
          {label}
        </p>
        <div className={cn('metric-icon', `metric-icon-${tone}`)}>
          <Icon className="size-3.5" aria-hidden="true" />
        </div>
      </div>
      <p className="mt-3 font-data text-[2.5rem] font-semibold leading-none tracking-[-0.055em] sm:text-[2.75rem]">
        {value}
      </p>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground/75">
        {hint}
      </p>
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
      <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5 sm:px-5">
        <div>
          <h2 className="text-[13px] font-bold tracking-[0.01em]">{title}</h2>
          {description && (
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground/75">
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
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[11px] text-muted-foreground/75">
      <span
        className={cn('status-dot', `status-dot-${tone}`)}
        aria-hidden="true"
      />
      <span className="font-semibold text-foreground">{label}</span>
      {showUpdated && seconds != null && (
        <span>
          · Updated <span className="font-data">{seconds}s</span> ago
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
    <div className="flex min-h-32 flex-col items-center justify-center px-5 py-6 text-center">
      <span className="grid size-9 place-items-center rounded-md border bg-muted/40 text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <p className="mt-2.5 text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground/75">
        {description}
      </p>
    </div>
  )
}
