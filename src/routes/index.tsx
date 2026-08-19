import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-5xl font-bold tracking-tight">ParkOS</h1>
      <p className="text-lg text-gray-500">Parking management, simplified.</p>
      <div className="flex gap-4">
        <Link
          to="/login"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Log in
        </Link>
        <Link
          to="/app"
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-100"
        >
          Open app
        </Link>
      </div>
    </main>
  )
}
