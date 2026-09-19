import assert from 'node:assert/strict'
import {
  FacilityTimeError,
  facilityInputToUtc,
  formatInstantForFacility,
  instantToFacilityInput,
  isValidIanaTimeZone,
  parseFacilityWindow,
} from './facility-time.ts'

assert.equal(isValidIanaTimeZone('America/Los_Angeles'), true)
assert.equal(isValidIanaTimeZone('UTC'), true)
assert.equal(isValidIanaTimeZone('PST'), false)
assert.equal(isValidIanaTimeZone('Not/A_Zone'), false)

// Conversion depends only on the facility clock, never the test process's TZ.
assert.equal(
  facilityInputToUtc('2026-01-15T10:30', 'America/Los_Angeles'),
  '2026-01-15T18:30:00.000Z',
)
assert.equal(
  instantToFacilityInput('2026-01-15T18:30:00.000Z', 'America/Los_Angeles'),
  '2026-01-15T10:30',
)

const originalProcessTimezone = process.env.TZ
process.env.TZ = 'Pacific/Auckland'
const fromAucklandBrowser = facilityInputToUtc(
  '2026-01-15T10:30',
  'America/Los_Angeles',
)
process.env.TZ = 'America/New_York'
const fromNewYorkBrowser = facilityInputToUtc(
  '2026-01-15T10:30',
  'America/Los_Angeles',
)
process.env.TZ = originalProcessTimezone
assert.equal(fromAucklandBrowser, fromNewYorkBrowser)
assert.equal(fromAucklandBrowser, '2026-01-15T18:30:00.000Z')
assert.match(
  formatInstantForFacility('2026-01-15T18:30:00.000Z', 'America/Los_Angeles'),
  /Jan 15, 2026, 10:30/,
)

// Spring-forward wall time does not exist and must never be silently shifted.
assert.throws(
  () => facilityInputToUtc('2026-03-08T02:30', 'America/Los_Angeles'),
  (error) =>
    error instanceof FacilityTimeError && error.code === 'NONEXISTENT_TIME',
)

// Fall-back 01:30 occurs twice. ParkOS deliberately chooses the earlier one.
assert.equal(
  facilityInputToUtc('2026-11-01T01:30', 'America/Los_Angeles'),
  '2026-11-01T08:30:00.000Z',
)

assert.deepEqual(
  parseFacilityWindow(
    '2026-08-19T09:00',
    '2026-08-19T11:00',
    'America/Los_Angeles',
  ),
  {
    startIso: '2026-08-19T16:00:00.000Z',
    endIso: '2026-08-19T18:00:00.000Z',
  },
)
assert.throws(
  () =>
    parseFacilityWindow(
      '2026-08-19T11:00',
      '2026-08-19T09:00',
      'America/Los_Angeles',
    ),
  /Departure must be after arrival/,
)

console.log('facility-time: all assertions passed')
