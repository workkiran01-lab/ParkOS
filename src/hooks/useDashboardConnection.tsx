/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ConnectionStatus =
  | 'connecting'
  | 'live'
  | 'stale'
  | 'unavailable'

type DashboardConnectionValue = {
  status: ConnectionStatus
  updatedAt: number | null
  setConnection: (status: ConnectionStatus, updatedAt: number | null) => void
}

const DashboardConnectionContext =
  createContext<DashboardConnectionValue | null>(null)

export function DashboardConnectionProvider({
  children,
}: {
  children: ReactNode
}) {
  const [connection, setConnectionState] = useState<{
    status: ConnectionStatus
    updatedAt: number | null
  }>({ status: 'connecting', updatedAt: null })
  const setConnection = useCallback(
    (status: ConnectionStatus, updatedAt: number | null) =>
      setConnectionState((current) =>
        current.status === status && current.updatedAt === updatedAt
          ? current
          : { status, updatedAt },
      ),
    [],
  )

  const value = useMemo<DashboardConnectionValue>(
    () => ({
      ...connection,
      setConnection,
    }),
    [connection, setConnection],
  )

  return (
    <DashboardConnectionContext.Provider value={value}>
      {children}
    </DashboardConnectionContext.Provider>
  )
}

export function useDashboardConnection() {
  const value = useContext(DashboardConnectionContext)
  if (!value) {
    throw new Error(
      'useDashboardConnection must be used within DashboardConnectionProvider',
    )
  }
  return value
}
