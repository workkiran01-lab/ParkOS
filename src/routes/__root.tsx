import { Outlet, createRootRoute, Link } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
})

function RootLayout() {
  return <Outlet />
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
