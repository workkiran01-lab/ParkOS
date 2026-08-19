import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { ErrorFallback } from '@/components/ui/ErrorFallback'
import { PageSpinner } from '@/components/ui/Spinner'
import './index.css'

const router = createRouter({
  routeTree,
  defaultErrorComponent: ErrorFallback,
  defaultPendingComponent: PageSpinner,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
