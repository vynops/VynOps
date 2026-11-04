// Creates apps/web/.env.local from the template on first install. Never overwrites an existing file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapAdmin } from './bootstrap-admin.mjs'

const defaultWebDir = join(dirname(fileURLToPath(import.meta.url)), '..')

export function setupEnvironment(webDir = process.env.VYNOPS_SETUP_WEB_DIR || defaultWebDir) {
  const target = join(webDir, '.env.local')
  const template = join(webDir, '.env.local.example')

  if (!existsSync(target) && !existsSync(template)) return null

  if (!existsSync(target)) {
    // latin1 round-trips the template's non-ASCII comment characters unchanged.
    const env = readFileSync(template, 'latin1')
      .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${randomBytes(32).toString('base64')}`)
      .replace(/^NEXTAUTH_URL=.*$/m, 'NEXTAUTH_URL=http://localhost:3030')
      .replace(/^GROQ_MODEL=/m, '# GROQ_MODEL=')

    // 'wx' fails if the file exists, so parallel runs cannot overwrite each other's secret.
    try {
      writeFileSync(target, env, { encoding: 'latin1', mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (existsSync(target)) console.log('VynOps: created apps/web/.env.local (generated AUTH_SECRET).')
  }

  const dataDir = join(webDir, 'data')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const admin = bootstrapAdmin({ envFile: target, dataDir, skipIfInitialized: true })
  if (admin) {
    console.log('VynOps: first admin created with the temporary password changeme. It must be changed at first login.')
  }
  return admin
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) setupEnvironment()
