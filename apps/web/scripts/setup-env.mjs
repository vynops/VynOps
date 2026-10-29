// Creates apps/web/.env.local from the template on first install. Never overwrites an existing file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(webDir, '.env.local')
const template = join(webDir, '.env.local.example')

if (existsSync(target) || !existsSync(template)) process.exit(0)

// latin1 round-trips the template's non-ASCII comment characters unchanged.
const env = readFileSync(template, 'latin1')
  .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${randomBytes(32).toString('base64')}`)
  .replace(/^NEXTAUTH_URL=.*$/m, 'NEXTAUTH_URL=http://localhost:3030')
  .replace(/^GROQ_MODEL=/m, '# GROQ_MODEL=')

// 'wx' fails if the file exists, so parallel runs cannot overwrite each other's secret.
try {
  writeFileSync(target, env, { encoding: 'latin1', mode: 0o600, flag: 'wx' })
} catch (err) {
  if (err.code === 'EEXIST') process.exit(0)
  throw err
}
mkdirSync(join(webDir, 'data'), { recursive: true })

console.log('VynOps: created apps/web/.env.local (generated AUTH_SECRET). Add GROQ_API_KEY to enable the AI Copilot.')
