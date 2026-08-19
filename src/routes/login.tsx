import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/login')({
  component: Login,
})

function Login() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 p-8 shadow-sm">
        <h1 className="mb-6 text-2xl font-semibold">Log in</h1>
        <p className="text-sm text-gray-500">
          Authentication is not wired up yet.
        </p>
      </div>
    </main>
  )
}
