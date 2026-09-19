import { fileURLToPath } from 'node:url'

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function assertLoopbackDatabaseUrl(value) {
  if (!value) {
    throw new Error(
      'PARKOS_TEST_DATABASE_URL is required for database verification.',
    )
  }

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('PARKOS_TEST_DATABASE_URL must be a valid PostgreSQL URL.')
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(
      'PARKOS_TEST_DATABASE_URL must use the postgres or postgresql protocol.',
    )
  }

  if (!loopbackHosts.has(url.hostname.toLowerCase())) {
    throw new Error(
      `Refusing database verification against non-loopback host ${url.hostname}.`,
    )
  }

  return url.toString()
}

export function assertLoopbackHttpUrl(
  value,
  variableName = 'PARKOS_TEST_SUPABASE_URL',
) {
  if (!value) {
    throw new Error(
      `${variableName} is required for local Supabase verification.`,
    )
  }

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${variableName} must be a valid HTTP URL.`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${variableName} must use the http or https protocol.`)
  }

  if (!loopbackHosts.has(url.hostname.toLowerCase())) {
    throw new Error(
      `Refusing local Supabase verification against non-loopback host ${url.hostname}.`,
    )
  }

  return url.toString()
}

function main() {
  const url = new URL(
    assertLoopbackDatabaseUrl(process.env.PARKOS_TEST_DATABASE_URL),
  )
  console.log(`Loopback database target confirmed (${url.hostname}).`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
