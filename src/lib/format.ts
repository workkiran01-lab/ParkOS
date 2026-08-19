export function dollars(cents: number) {
  return (cents / 100).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
  })
}

/** Now (+ optional offset) as a datetime-local input value, in local time. */
export function defaultLocalDatetime(offsetMs = 0) {
  const date = new Date(Date.now() + offsetMs)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}
