import { createFileRoute, Link } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'

export const Route = createFileRoute('/app')({
  component: AppPage,
})

function AppPage() {
  return (
    <AppShell
      sidebar={
        <ul className="space-y-1 text-sm">
          <li>
            <Link
              to="/app"
              className="block rounded-md px-3 py-2 font-medium hover:bg-gray-100"
            >
              Dashboard
            </Link>
          </li>
        </ul>
      }
    >
      <p className="text-gray-500">App shell placeholder.</p>
    </AppShell>
  )
}
