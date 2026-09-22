import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calendarDays,
  facilityToday,
  openingIntervals,
  segmentForDay,
  type OperatingHours,
} from './calendar.ts'

const zone = 'America/Los_Angeles'
test('facility today differs from the browser day around midnight', () => {
  assert.equal(
    facilityToday(zone, new Date('2026-09-20T02:00:00Z')),
    '2026-09-19',
  )
  assert.equal(
    facilityToday('Asia/Tokyo', new Date('2026-09-19T23:00:00Z')),
    '2026-09-20',
  )
})
test('midnight spanning reservations appear on both days, exclusive midnight end on only one', () => {
  const days = calendarDays('2026-09-19', 'week', zone)
  const spanning = '[2026-09-19T06:30:00Z,2026-09-19T08:30:00Z)'
  assert.deepEqual(
    days.filter((day) => segmentForDay(spanning, day)).map((day) => day.date),
    ['2026-09-18', '2026-09-19'],
  )
  assert.deepEqual(
    days
      .filter((day) =>
        segmentForDay('[2026-09-19T06:30:00Z,2026-09-19T07:00:00Z)', day),
      )
      .map((day) => day.date),
    ['2026-09-18'],
  )
})
test('DST transition days preserve every instant once and use 23/25 real hours', () => {
  for (const [date, hours, during, duration] of [
    ['2026-03-08', 23, '[2026-03-08T09:30:00Z,2026-03-08T10:30:00Z)', 60],
    ['2026-11-01', 25, '[2026-11-01T08:30:00Z,2026-11-01T09:30:00Z)', 60],
  ] as const) {
    const days = calendarDays(date, 'week', zone)
    const day = days.find((value) => value.date === date)!
    assert.equal((day.end - day.start) / 3_600_000, hours)
    const segments = days.flatMap((value) => segmentForDay(during, value) ?? [])
    assert.equal(segments.length, 1)
    assert.equal((segments[0].end - segments[0].start) / 60_000, duration)
    for (let index = 1; index < days.length; index++)
      assert.equal(days[index - 1].end, days[index].start)
  }
})
test('weekly closed days include previous-day overnight spillover only', () => {
  const hours: OperatingHours = {
    type: 'weekly',
    days: {
      fri: { open: '22:00', close: '02:00' },
      sat: 'closed',
      sun: '24_hours',
    },
  }
  const days = calendarDays('2026-09-19', 'week', zone)
  const saturday = days.find((day) => day.date === '2026-09-19')!
  assert.deepEqual(openingIntervals(saturday, hours, zone), [
    { start: saturday.start, end: saturday.start + 2 * 3_600_000 },
  ])
  assert.equal(openingIntervals(days[0], hours, zone).length, 0)
  assert.deepEqual(
    openingIntervals(
      saturday,
      { type: 'daily', open: '06:00', close: '06:00' },
      zone,
    ),
    [{ start: saturday.start, end: saturday.end }],
  )
})
test('operating-hour boundaries match PostgreSQL gap and overlap resolution', () => {
  const spring = calendarDays('2026-03-08', 'week', zone).at(-1)!
  const fall = calendarDays('2026-11-01', 'week', zone).at(-1)!
  assert.equal(
    new Date(
      openingIntervals(
        spring,
        { type: 'daily', open: '02:30', close: '04:00' },
        zone,
      )[0].start,
    ).toISOString(),
    '2026-03-08T10:30:00.000Z',
  )
  assert.equal(
    new Date(
      openingIntervals(
        fall,
        { type: 'daily', open: '01:30', close: '04:00' },
        zone,
      )[0].start,
    ).toISOString(),
    '2026-11-01T09:30:00.000Z',
  )
})
test('month spans whole weeks and unbounded stays are retained', () => {
  const days = calendarDays('2026-08-01', 'month', zone)
  assert.equal(days.length, 42)
  assert.equal(days[0].date, '2026-07-27')
  assert.equal(days.at(-1)!.date, '2026-09-06')
  assert.ok(segmentForDay('[2026-08-01T07:00:00Z,)', days[10]))
})
