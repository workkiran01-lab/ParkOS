import { createContext, useContext } from 'react'

// Shared context + control styles for the attendant ("booth") surface.
//
// This lives in a standalone leaf module rather than in the route file
// `routes/attendant.tsx`. That route file has a same-named sibling directory
// (`routes/attendant/`), which makes the bare specifier `@/routes/attendant`
// ambiguous (file vs. directory index). In the Vite dev server that ambiguity
// can load the route module as two separate instances, producing two distinct
// React contexts — the layout fills one while the child routes read the other
// and see `null` ("useAttendant must be used within the attendant layout").
// Importing the context from an unambiguous module keeps it a single instance.

export type AttendantFacility = { id: string; name: string; timezone: string }

export type AttendantContextValue = {
  orgId: string
  facility: AttendantFacility | null
}

export const AttendantContext = createContext<AttendantContextValue | null>(null)

export function useAttendant() {
  const ctx = useContext(AttendantContext)
  if (!ctx) throw new Error('useAttendant must be used within the attendant layout')
  return ctx
}

// Big, thumb-friendly control classes reused across the attendant screens:
// 44px minimum height, 16px minimum text.
export const tapTarget = 'min-h-11 text-base'
export const bigInput =
  'h-12 w-full rounded-lg border border-input bg-background px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'
export const bigButton =
  'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50'
export const bigButtonOutline =
  'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-input bg-background px-5 py-3 text-base font-medium transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50'
