import {
  createClient,
  type SupabaseClient,
  type User,
} from 'npm:@supabase/supabase-js@2.112.3'
import { AuthenticationError, ConfigurationError } from './http.ts'

const authOptions = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
}

let cachedAdminClient: SupabaseClient | null = null

function requiredEnvironment(names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim()
    if (value) return value
  }

  throw new ConfigurationError('Server configuration is incomplete.')
}

function supabaseUrl() {
  return requiredEnvironment(['SUPABASE_URL'])
}

function publicKey() {
  return requiredEnvironment(['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'])
}

function serviceKey() {
  return requiredEnvironment([
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SECRET_KEY',
  ])
}

export function getAdminClient() {
  if (!cachedAdminClient) {
    cachedAdminClient = createClient(supabaseUrl(), serviceKey(), {
      auth: authOptions,
    })
  }

  return cachedAdminClient
}

export async function getAuthenticatedClients(request: Request): Promise<{
  userClient: SupabaseClient
  adminClient: SupabaseClient
  user: User
}> {
  const authorization = request.headers.get('Authorization')
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  if (!authorization || !match?.[1]) {
    throw new AuthenticationError('Sign in is required.')
  }

  const accessToken = match[1]
  const userClient = createClient(supabaseUrl(), publicKey(), {
    auth: authOptions,
    global: { headers: { Authorization: authorization } },
  })
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser(accessToken)

  if (error || !user)
    throw new AuthenticationError('Your session is no longer valid.')

  return { userClient, adminClient: getAdminClient(), user }
}
