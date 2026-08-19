import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app')({
  component: AppShell,
})

function AppShell() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-lg text-gray-500">App shell placeholder.</p>
    </main>
  )
}
