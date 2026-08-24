import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Chrome for the signed-out pages (home, about, privacy). Kept separate from
 * AppShell, which carries the dashboard sidebar and assumes an authenticated
 * org context. Children render full-bleed so a page can alternate section
 * backgrounds; page-level width is set per section, not here.
 */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="text-sm font-semibold tracking-tight">
            ParkOS
          </Link>
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost" className="h-9 px-3">
              <Link to="/login">Log in</Link>
            </Button>
            <Button asChild className="h-9 px-3">
              <Link to="/signup">Create account</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>ParkOS</span>
          <nav className="flex flex-wrap items-center gap-5">
            <Link
              to="/about"
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              About
            </Link>
            <Link
              to="/privacy"
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              Privacy
            </Link>
            <a
              href="https://github.com/workkiran01-lab/ParkOS"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
            >
              GitHub
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
