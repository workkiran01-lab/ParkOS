/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from 'react'

export type FacilitySummary = { id: string; name: string }
export type FacilityOption = FacilitySummary & { timezone: string }

type FacilityContextValue = {
  facilities: FacilityOption[]
  allFacilities: FacilitySummary[]
  facilityId: string
  setFacilityId: (id: string) => void
  loading: boolean
  error: { message: string } | null
}

const FacilityContext = createContext<FacilityContextValue | null>(null)

export function FacilityProvider({
  value,
  children,
}: {
  value: FacilityContextValue
  children: ReactNode
}) {
  return (
    <FacilityContext.Provider value={value}>
      {children}
    </FacilityContext.Provider>
  )
}

export function useFacility() {
  const value = useContext(FacilityContext)
  if (!value)
    throw new Error('useFacility must be used inside FacilityProvider')
  return value
}
