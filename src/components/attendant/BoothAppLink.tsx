import { Link } from '@tanstack/react-router'
import { useRole } from '@/hooks/useRole'

/** Keep attendants in the kiosk; let app users return without signing out. */
export function BoothAppLink() {
  const { role } = useRole()
  if (role !== 'admin' && role !== 'manager' && role !== 'owner_viewer')
    return null

  return (
    <Link
      to="/app"
      className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold underline underline-offset-4 hover:bg-muted"
    >
      Back to app
    </Link>
  )
}
