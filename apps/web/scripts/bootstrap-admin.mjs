import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.VYNOPS_BOOTSTRAP_DATA_DIR || join(WEB_DIR, 'data')
const ENV_FILE = process.env.VYNOPS_BOOTSTRAP_ENV_FILE || join(WEB_DIR, '.env.local')
const BOOTSTRAP_KEYS = /^(?:export\s+)?INITIAL_ADMIN_(?:EMAIL|PASSWORD|NAME)\s*=/

function parseEnvFile(file) {
  if (!existsSync(file)) return {}
  const values = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    let value = match[2]
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    values[match[1]] = value
  }
  return values
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writePrivateJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

function clearBootstrapValues(file) {
  if (!existsSync(file)) return
  const contents = readFileSync(file, 'utf8')
  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const cleaned = contents.split(/\r?\n/).filter(line => !BOOTSTRAP_KEYS.test(line)).join(newline)
  writeFileSync(file, `${cleaned}${contents.endsWith('\n') ? newline : ''}`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

export function bootstrapAdmin({ envFile = ENV_FILE, dataDir = DATA_DIR, env = process.env, skipIfInitialized = false } = {}) {
  const usersFile = join(dataDir, 'users.json')
  const passwordsFile = join(dataDir, 'passwords.json')
  const users = readJson(usersFile, [])
  if (!Array.isArray(users)) throw new Error('User store is invalid; refusing to overwrite it')
  if (users.length > 0) {
    if (skipIfInitialized) return null
    throw new Error('User store is already initialized; no changes were made')
  }

  const fileEnv = parseEnvFile(envFile)
  const email = String(env.INITIAL_ADMIN_EMAIL || fileEnv.INITIAL_ADMIN_EMAIL || 'admin@vynops.io').trim().toLowerCase()
  const password = String(env.INITIAL_ADMIN_PASSWORD || fileEnv.INITIAL_ADMIN_PASSWORD || 'changeme')
  const name = String(env.INITIAL_ADMIN_NAME || fileEnv.INITIAL_ADMIN_NAME || 'Platform Administrator').trim()

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('INITIAL_ADMIN_EMAIL must be a valid email address')
  if ((password !== 'changeme' && password.length < 8) || password.includes('\n') || password.includes('\r')) {
    throw new Error('INITIAL_ADMIN_PASSWORD must be a single-line password of at least 8 characters')
  }
  if (!name) throw new Error('INITIAL_ADMIN_NAME must not be empty')

  const existingPasswords = readJson(passwordsFile, {})
  if (!existingPasswords || typeof existingPasswords !== 'object' || Array.isArray(existingPasswords)) {
    throw new Error('Password store is invalid; refusing to overwrite it')
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)

  const id = `admin-${randomUUID()}`
  const user = {
    id,
    name,
    email,
    role: 'admin',
    team: 'Platform Engineering',
    avatar: name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(),
    createdAt: new Date().toISOString(),
    status: 'active',
    isSuperAdmin: true,
    mustChangePassword: true,
    sessionVersion: 0,
  }

  writePrivateJson(passwordsFile, { ...existingPasswords, [id]: bcrypt.hashSync(password, 12) })
  writePrivateJson(usersFile, [user])
  clearBootstrapValues(envFile)

  return { id, email, role: user.role }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = bootstrapAdmin()
    if (result) console.log('Initial admin created with the temporary password changeme. It must be changed at first login.')
    else console.log('User store already initialized; no admin changes made.')
  } catch (error) {
    console.error(`[bootstrap-admin] ${error.message}`)
    process.exitCode = 1
  }
}