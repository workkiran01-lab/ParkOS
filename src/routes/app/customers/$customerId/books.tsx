import { createFileRoute } from '@tanstack/react-router'
import { CustomerRecord } from '@/components/customers/CustomerRecord'

export const Route = createFileRoute('/app/customers/$customerId/books')({
  component: CustomerBooks,
})
function CustomerBooks() {
  const { customerId } = Route.useParams()
  return <CustomerRecord customerId={customerId} books />
}
