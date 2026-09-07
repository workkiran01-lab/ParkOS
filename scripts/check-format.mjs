import { existsSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const supportedExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
])

function gitLines(args) {
  const output = execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  return output.split(/\r?\n/u).filter(Boolean)
}

function changedFiles() {
  const base = process.env.PARKOS_FORMAT_BASE || 'HEAD^'
  return new Set([
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMR', base, '--']),
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMR', '--']),
    ...gitLines([
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
      '--',
    ]),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ])
}

const files = [...changedFiles()]
  .filter((file) => supportedExtensions.has(extname(file).toLowerCase()))
  .filter((file) => existsSync(resolve(projectRoot, file)))
  .sort()

if (files.length === 0) {
  console.log('No changed Prettier-supported files to check.')
  process.exit(0)
}

const prettierCli = resolve(
  projectRoot,
  'node_modules',
  'prettier',
  'bin',
  'prettier.cjs',
)
const result = spawnSync(process.execPath, [prettierCli, '--check', ...files], {
  cwd: projectRoot,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
