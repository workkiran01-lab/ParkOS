import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

type AppShellProps = {
  /** Slot for sidebar navigation content. */
  sidebar?: ReactNode
  children: ReactNode
}

export function AppShell({ sidebar, children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-gray-200 bg-white px-4">
        <button
          type="button"
          onClick={() => setSidebarOpen((open) => !open)}
          aria-label="Toggle sidebar"
          aria-expanded={sidebarOpen}
          className="rounded-md p-2 hover:bg-gray-100 md:hidden"
        >
          <MenuIcon />
        </button>
        <Link to="/" className="text-lg font-semibold tracking-tight">
          ParkOS
        </Link>
      </header>

      <div className="flex flex-1">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-10 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        <aside
          className={`fixed inset-y-0 left-0 z-10 w-64 border-r border-gray-200 bg-white pt-14 transition-transform md:static md:translate-x-0 md:pt-0 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <nav className="p-4">{sidebar}</nav>
        </aside>

        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  )
}

function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="size-5"
      role="presentation"
      aria-hidden="true"
    >
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  )
}
