import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'

export type AppRole =
  | 'admin'
  | 'manager'
  | 'attendant'
  | 'customer'
  | 'owner_viewer'

type RoleState = {
  role: AppRole | null
  org_id: string | null
  full_name: string | null
  loading: boolean
  /** True only once the profile query has succeeded and found no row — i.e.
   * the user has a session but never completed organization creation. Stays
   * false while loading and on query errors, so callers can distinguish
   * "don't know yet" from "confirmed missing". */
  profileMissing: boolean
  error: string | null
}

export function useRole() {
  const { user, loading: authLoading } = useAuth()
  const [state, setState] = useState<RoleState>({
    role: null,
    org_id: null,
    full_name: null,
    loading: true,
    profileMissing: false,
    error: null,
  })

  const refresh = useCallback(async () => {
    if (!user) {
      setState({
        role: null,
        org_id: null,
        full_name: null,
        loading: false,
        profileMissing: false,
        error: null,
      })
      return
    }

    setState((current) => ({ ...current, loading: true, error: null }))

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('org_id, full_name')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError || !profile) {
      setState({
        role: null,
        org_id: null,
        full_name: null,
        loading: false,
        profileMissing: !profileError && !profile,
        error: profileError?.message ?? null,
      })
      return
    }

    const { data: membership, error: membershipError } = await supabase
      .from('memberships')
      .select('role')
      .eq('org_id', profile.org_id)
      .eq('user_id', user.id)
      .maybeSingle()

    setState({
      role: (membership?.role as AppRole | undefined) ?? null,
      org_id: profile.org_id,
      full_name: profile.full_name,
      loading: false,
      profileMissing: false,
      error: membershipError?.message ?? null,
    })
  }, [user])

  useEffect(() => {
    if (!authLoading) void Promise.resolve().then(refresh)
  }, [authLoading, refresh])

  return { ...state, refresh }
}
