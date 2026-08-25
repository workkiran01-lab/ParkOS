// Runnable check for the CSV escaping invariant:
//   a field containing a comma, a quote, or a newline must survive a round trip
//   into a spreadsheet unchanged. Getting this wrong shifts columns silently,
//   which is the worst way for a financial export to fail.
// Run: npx tsx src/lib/csv.test.ts
import assert from 'node:assert/strict'
import { csvFilename, toCsv, type CsvColumn } from './csv.ts'

type Row = { day: string; label: string; cents: number | null }

const columns: CsvColumn<Row>[] = [
  { header: 'Date', value: (r) => r.day },
  { header: 'Label', value: (r) => r.label },
  { header: 'Amount (cents)', value: (r) => r.cents },
]

// Plain rows: no quoting, CRLF terminators, header first.
const plain = toCsv(
  [{ day: '2026-08-18', label: 'standard', cents: 3500 }],
  columns,
)
assert.equal(
  plain,
  'Date,Label,Amount (cents)\r\n2026-08-18,standard,3500',
  'plain rows are unquoted and CRLF-terminated',
)

// A comma in a value must be quoted, or it becomes an extra column.
const comma = toCsv([{ day: 'd', label: 'Level 1, Zone A', cents: 1 }], columns)
assert.ok(comma.includes('"Level 1, Zone A"'), 'comma forces quoting')
assert.equal(comma.split('\r\n')[1].split('","').length, 1, 'still one row')

// A double quote is escaped by doubling, and the field is quoted.
const quoted = toCsv([{ day: 'd', label: 'space "A-12"', cents: 1 }], columns)
assert.ok(quoted.includes('"space ""A-12"""'), 'quotes are doubled')

// Newlines inside a field must be quoted, not break the row apart.
const multiline = toCsv(
  [{ day: 'd', label: 'line1\nline2', cents: 1 }],
  columns,
)
assert.ok(multiline.includes('"line1\nline2"'), 'newline forces quoting')
assert.equal(
  multiline.split('\r\n').length,
  2,
  'an embedded LF does not create a new CSV record',
)

// Null and undefined render as empty, never the string "null".
const empty = toCsv([{ day: 'd', label: '', cents: null }], columns)
assert.equal(empty.split('\r\n')[1], 'd,,', 'null becomes an empty field')

// Zero is a real value and must not be blanked by a falsy check.
const zero = toCsv([{ day: 'd', label: 'x', cents: 0 }], columns)
assert.equal(zero.split('\r\n')[1], 'd,x,0', 'zero is preserved')

// Header row alone when there are no rows.
assert.equal(
  toCsv([], columns),
  'Date,Label,Amount (cents)',
  'empty data still emits headers',
)

assert.equal(
  csvFilename('revenue', '2026-08-01', '2026-08-31'),
  'parkos-revenue-2026-08-01-to-2026-08-31.csv',
)

console.log('csv: all assertions passed')
