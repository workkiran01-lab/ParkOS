import { supabase } from '@/lib/supabase'

export const SUPPORT_EMAIL = 'support@parkos.app'

export const DEACTIVATED_MESSAGE = `This account has been deactivated. Email ${SUPPORT_EMAIL} if you need it reopened.`

/** Every sign-in routes through here: a deactivated account keeps working until
 *  its JWT expires, so the session has to be dropped the moment we see one.
 *  Returns true when the caller should show DEACTIVATED_MESSAGE instead of
 *  continuing. RLS scopes account_status to the caller's own row. */
export async function signOutIfDeactivated() {
  const { data } = await supabase
    .from('account_status')
    .select('status')
    .maybeSingle()

  if (data?.status !== 'deactivated') return false
  await supabase.auth.signOut()
  return true
}
