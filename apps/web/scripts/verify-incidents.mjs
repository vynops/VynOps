import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(web, '../../package-lock.json'), 'utf8'))
if (lock.packages['apps/web'].dependencies.ws !== '^8.18.3' || !lock.packages['node_modules/ws']) throw new Error('WebSocket lockfile is incomplete')
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const steps = [
  ['incident-tests', [vitest, 'run', 'src/app/api/incidents/__tests__']],
  ['typecheck', [require.resolve('typescript/bin/tsc'), '--noEmit', '--pretty', 'false']],
  ['server-syntax', ['--check', 'server.mjs']],
]
if (process.argv.includes('--build')) steps.push(['production-build', [require.resolve('next/dist/bin/next'), 'build']])
for (const [name, args] of steps) {
  console.log(`GATE_START=${name}`)
  const result = spawnSync(process.execPath, args, { cwd: web, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  console.log(`GATE_EXIT=${name}:${result.status}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('ALL_GATES_PASSED')