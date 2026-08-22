export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

export class AuthenticationError extends Error {}

export class ConfigurationError extends Error {}

export function jsonResponse(body: unknown, status = 200, cors = true) {
  const headers = new Headers(cors ? corsHeaders : undefined)
  headers.set('Content-Type', 'application/json; charset=utf-8')

  return new Response(JSON.stringify(body), { status, headers })
}

export function errorResponse(message: string, status: number, cors = true) {
  return jsonResponse({ error: message }, status, cors)
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function readJsonObject(request: Request) {
  try {
    const value: unknown = await request.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

export function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function isUuid(value: string | null): value is string {
  return Boolean(
    value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  )
}

/**
 * Checkout return URLs are supplied by the browser so local and deployed apps
 * can share the same function. Only a bare HTTP(S) origin is accepted, and a
 * browser request must agree with its Origin header to prevent open redirects.
 */
export function validateReturnOrigin(
  value: unknown,
  requestOrigin: string | null,
) {
  const rawOrigin = readString(value)
  if (!rawOrigin) return null

  try {
    const candidate = new URL(rawOrigin)
    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:')
      return null
    if (candidate.username || candidate.password) return null
    if (candidate.pathname !== '/' || candidate.search || candidate.hash)
      return null

    if (requestOrigin) {
      const headerOrigin = new URL(requestOrigin)
      if (
        headerOrigin.protocol !== 'http:' &&
        headerOrigin.protocol !== 'https:'
      )
        return null
      if (candidate.origin !== headerOrigin.origin) return null
    }

    return candidate.origin
  } catch {
    return null
  }
}
