/**
 * Minimal RFC 4180 CSV serialization. No dependency: the whole job is quoting
 * correctly, and getting that wrong silently corrupts a file the operator may
 * hand to an accountant.
 *
 * Kept import-free so csv.test.ts can exercise the escaping under any TS runner.
 */

export type CsvColumn<T> = {
  header: string
  value: (row: T) => string | number | null | undefined
}

/**
 * Byte-order mark, written as an escape rather than a literal so it is visible
 * to anyone reading this file. See downloadCsv for why Excel needs it.
 */
const BOM = '\uFEFF'

/** A field needs quoting if it contains a comma, a quote, or any line break. */
function escapeField(raw: unknown): string {
  const text = raw === null || raw === undefined ? '' : String(raw)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Serialize rows to CSV text. Line terminator is CRLF, per RFC 4180. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((column) => escapeField(column.header)).join(',')
  const body = rows.map((row) =>
    columns.map((column) => escapeField(column.value(row))).join(','),
  )
  return [header, ...body].join('\r\n')
}

/**
 * Hand the CSV to the browser as a download.
 *
 * The leading U+FEFF is for Excel: without it Excel reads UTF-8 as the local
 * codepage and mangles any non-ASCII character. It is deliberately not part of
 * toCsv, which stays pure so the tests can compare exact bytes.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([BOM + csv], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** `parkos-revenue-2026-08-01-to-2026-08-31.csv` */
export function csvFilename(report: string, from: string, to: string): string {
  return `parkos-${report}-${from}-to-${to}.csv`
}
