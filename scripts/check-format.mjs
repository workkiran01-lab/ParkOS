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

// A pull request has to be checked in full, not just its final commit. Compare
// against the merge base with the branch the work targets — GITHUB_BASE_REF on a
// pull_request event, `main` otherwise — so every file the branch touches is
// checked. `HEAD^` remains the fallback for the case the merge base cannot
// answer: a checkout sitting on the target branch tip itself, where the branch
// point is HEAD and the only meaningful diff is the last commit.
function resolveBase() {
  if (process.env.PARKOS_FORMAT_BASE) return process.env.PARKOS_FORMAT_BASE

  const head = gitLines(['rev-parse', 'HEAD'])[0]
  const target = process.env.GITHUB_BASE_REF || 'main'

  for (const ref of [`origin/${target}`, target]) {
    const result = spawnSync('git', ['merge-base', ref, 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
    if (result.status !== 0) continue
    const mergeBase = result.stdout.trim()
    if (mergeBase && mergeBase !== head) return mergeBase
  }

  return 'HEAD^'
}

const base = resolveBase()

function changedFiles() {
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

console.log(`Checking ${files.length} file(s) changed since ${base}.`)

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
