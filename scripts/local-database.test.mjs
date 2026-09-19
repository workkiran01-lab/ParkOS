import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertLoopbackDatabaseUrl,
  assertLoopbackHttpUrl,
} from './local-database.mjs'

test('accepts PostgreSQL URLs targeting IPv4, IPv6, or named loopback', () => {
  for (const url of [
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'postgres://postgres:postgres@localhost:54322/postgres',
    'postgresql://postgres:postgres@[::1]:54322/postgres',
  ]) {
    assert.doesNotThrow(() => assertLoopbackDatabaseUrl(url))
  }
})

test('rejects missing, malformed, and non-PostgreSQL database URLs', () => {
  for (const url of [undefined, 'not a URL', 'https://127.0.0.1/database']) {
    assert.throws(() => assertLoopbackDatabaseUrl(url))
  }
})

test('rejects every non-loopback database host before verification', () => {
  for (const url of [
    'postgresql://postgres:secret@db.example.com/postgres',
    'postgresql://postgres:secret@192.168.1.10/postgres',
    'postgresql://postgres:secret@host.docker.internal/postgres',
  ]) {
    assert.throws(
      () => assertLoopbackDatabaseUrl(url),
      /Refusing database verification against non-loopback host/u,
    )
  }
})

test('accepts only loopback Supabase HTTP endpoints', () => {
  assert.equal(
    assertLoopbackHttpUrl('http://127.0.0.1:54321'),
    'http://127.0.0.1:54321/',
  )
  assert.throws(
    () => assertLoopbackHttpUrl('https://project.supabase.co'),
    /non-loopback host/,
  )
})
