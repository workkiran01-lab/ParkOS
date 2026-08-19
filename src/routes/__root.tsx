import { Outlet, createRootRoute, Link } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { Toaster } from 'sonner'
import { ErrorFallback } from '@/components/ui/ErrorFallback'
import { PageSpinner } from '@/components/ui/Spinner'

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: ErrorFallback,
  pendingComponent: PageSpinner,
  notFoundComponent: NotFound,
})

function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster position="top-right" richColors />
      {import.meta.env.DEV && (
        <TanStackRouterDevtools position="bottom-right" />
      )}
    </>
  )
}

function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-6xl font-bold tracking-tight">404</h1>
      <p className="text-lg text-gray-500">This page could not be found.</p>
      <Link to="/" className="text-sm font-medium underline underline-offset-4">
        Back to home
      </Link>
    </main>
  )
}
