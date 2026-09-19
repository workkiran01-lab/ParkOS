import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { PageHeader } from '@/components/layout/PagePrimitives'
import { Input } from '@/components/ui/input'
import { useRole } from '@/hooks/useRole'
import {
  loadCustomers,
  loadCustomerVehicles,
  searchCustomers,
  type Customer,
  type CustomerVehicle,
} from '@/lib/customer-queries'
import { supabase } from '@/lib/supabase'

export const Route = createFileRoute('/app/customers/')({
  component: CustomerDirectory,
})

function CustomerDirectory() {
  const { org_id: orgId, role, loading } = useRole()
  const allowed = role === 'admin' || role === 'manager' || role === 'attendant'
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<{
    orgId: string
    customers: Customer[]
    vehicles: CustomerVehicle[]
    error?: string
  } | null>(null)
  useEffect(() => {
    if (!orgId || !allowed) return
    let cancelled = false
    void Promise.all([
      loadCustomers(supabase, orgId),
      loadCustomerVehicles(supabase, orgId),
    ])
      .then(([customers, vehicles]) => {
        if (!cancelled) setResult({ orgId, customers, vehicles })
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setResult({
            orgId,
            customers: [],
            vehicles: [],
            error:
              error instanceof Error
                ? error.message
                : 'Customers could not be loaded.',
          })
      })
    return () => {
      cancelled = true
    }
  }, [orgId, allowed])
  const current = result?.orgId === orgId ? result : null
  const matches = useMemo(
    () =>
      current
        ? searchCustomers(current.customers, current.vehicles, search)
        : [],
    [current, search],
  )
  const pageIndex = Math.min(
    page,
    Math.max(0, Math.ceil(matches.length / 25) - 1),
  )
  if (loading) return <p role="status">Loading customers…</p>
  if (!allowed) return <p>A staff role is required to view customers.</p>
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Customer / Directory"
        title="Customer"
        description="Find a customer by name, phone, email, or license plate."
      />
      <label className="block max-w-xl space-y-2 text-sm font-medium">
        Search customers
        <Input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(0)
          }}
          placeholder="Name, phone, email, or plate"
        />
      </label>
      {!current ? (
        <p role="status">Loading customers…</p>
      ) : current.error ? (
        <p role="alert" className="text-destructive">
          {current.error}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {matches.length} customer{matches.length === 1 ? '' : 's'}
          </p>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  {['Customer', 'Contact', 'Vehicles', 'Bookings'].map(
                    (label) => (
                      <th className="px-4 py-3 font-medium" key={label}>
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {matches
                  .slice(pageIndex * 25, pageIndex * 25 + 25)
                  .map((customer) => (
                    <tr key={customer.id} className="border-b last:border-0">
                      <td className="px-4 py-4">
                        <Link
                          to="/app/customers/$customerId"
                          params={{ customerId: customer.id }}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {customer.full_name}
                        </Link>
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                          {customer.id}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        <p>{customer.email || 'No email'}</p>
                        <p className="text-muted-foreground">
                          {customer.phone || 'No phone'}
                        </p>
                      </td>
                      <td className="px-4 py-4 font-mono text-xs">
                        {current.vehicles
                          .filter(
                            (vehicle) => vehicle.customer_id === customer.id,
                          )
                          .map((vehicle) => vehicle.license_plate || 'No plate')
                          .join(', ') || 'No vehicles'}
                      </td>
                      <td className="px-4 py-4">
                        <Link
                          to="/app/customers/$customerId/books"
                          params={{ customerId: customer.id }}
                          className="underline underline-offset-4"
                          aria-label={`Books for ${customer.full_name}`}
                        >
                          Books
                        </Link>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {matches.length === 0 && (
              <p className="p-8 text-center text-muted-foreground">
                {search
                  ? 'No customers match this search.'
                  : 'No customers yet.'}
              </p>
            )}
          </div>
          {matches.length > 25 && (
            <div className="flex items-center gap-4 text-sm">
              <button
                className="rounded border px-3 py-2 disabled:opacity-40"
                disabled={pageIndex === 0}
                onClick={() => setPage(pageIndex - 1)}
              >
                Previous
              </button>
              <span>
                Page {pageIndex + 1} of {Math.ceil(matches.length / 25)}
              </span>
              <button
                className="rounded border px-3 py-2 disabled:opacity-40"
                disabled={(pageIndex + 1) * 25 >= matches.length}
                onClick={() => setPage(pageIndex + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
