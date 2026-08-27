import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sqlRoots = [
  resolve(projectRoot, 'supabase/migrations'),
  resolve(projectRoot, 'supabase/dev-only'),
]

// These migrations are immutable because they have already been applied. Both
// contain the historical bug, and both are superseded by later repair
// migrations. New and still-editable SQL receives no exception.
const grandfatheredFiles = new Set([
  '20260819170000_attendant_checkin.sql',
  '20260825010000_booth_payments.sql',
])

// PostgreSQL parses these as conditional expressions rather than ordinary
// functions. A schema-qualified spelling such as pg_catalog.coalesce(...) is
// therefore invalid even when every argument has the same type.
const specialFormPattern =
  /\b(?:[a-z_][a-z0-9_$]*\s*\.\s*)+(coalesce|nullif|greatest|least)\s*\(/giu

function maskRange(chars, start, end) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
  }
}

export function maskSqlComments(sql) {
  const chars = [...sql]

  for (let index = 0; index < chars.length;) {
    if (chars[index] === "'") {
      const start = index
      index += 1
      while (index < chars.length) {
        if (chars[index] !== "'") {
          index += 1
          continue
        }
        if (chars[index + 1] === "'") {
          index += 2
          continue
        }
        index += 1
        break
      }
      maskRange(chars, start, index)
      continue
    }

    if (chars[index] === '"') {
      const start = index
      index += 1
      while (index < chars.length) {
        if (chars[index] !== '"') {
          index += 1
          continue
        }
        if (chars[index + 1] === '"') {
          index += 2
          continue
        }
        index += 1
        break
      }
      maskRange(chars, start, index)
      continue
    }

    if (chars[index] === '-' && chars[index + 1] === '-') {
      const start = index
      index += 2
      while (
        index < chars.length &&
        chars[index] !== '\n' &&
        chars[index] !== '\r'
      ) {
        index += 1
      }
      maskRange(chars, start, index)
      continue
    }

    if (chars[index] === '/' && chars[index + 1] === '*') {
      const start = index
      let depth = 1
      index += 2
      while (index < chars.length && depth > 0) {
        if (chars[index] === '/' && chars[index + 1] === '*') {
          depth += 1
          index += 2
        } else if (chars[index] === '*' && chars[index + 1] === '/') {
          depth -= 1
          index += 2
        } else {
          index += 1
        }
      }
      maskRange(chars, start, index)
      continue
    }

    index += 1
  }

  return chars.join('')
}

export function findSchemaQualifiedSpecialForms(sql) {
  const searchable = maskSqlComments(sql)
  const lines = sql.split(/\r?\n/u)
  const violations = []

  for (const match of searchable.matchAll(specialFormPattern)) {
    const before = searchable.slice(0, match.index)
    const line = before.split('\n').length
    violations.push({
      construct: match[1].toUpperCase(),
      line,
      text: lines[line - 1]?.trim() ?? match[0].trim(),
    })
  }

  return violations
}

async function listSqlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = []

  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      paths.push(...(await listSqlFiles(path)))
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      paths.push(path)
    }
  }

  return paths.sort()
}

export async function scanSqlFiles(roots = sqlRoots) {
  const files = (await Promise.all(roots.map(listSqlFiles))).flat().sort()
  const violations = []

  for (const file of files) {
    const filename = file.split(/[\\/]/u).at(-1)
    if (grandfatheredFiles.has(filename)) continue

    const sql = await readFile(file, 'utf8')
    for (const violation of findSchemaQualifiedSpecialForms(sql)) {
      violations.push({
        ...violation,
        file: relative(projectRoot, file).replaceAll('\\', '/'),
      })
    }
  }

  return { filesScanned: files.length - grandfatheredFiles.size, violations }
}

async function main() {
  const { filesScanned, violations } = await scanSqlFiles()

  if (violations.length === 0) {
    console.log(
      `SQL special-form guard passed (${filesScanned} files scanned).`,
    )
    return
  }

  console.error(
    'Schema-qualified PostgreSQL conditional expressions are invalid:',
  )
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}: ${violation.construct}: ${violation.text}`,
    )
  }
  process.exitCode = 1
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isCli) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
