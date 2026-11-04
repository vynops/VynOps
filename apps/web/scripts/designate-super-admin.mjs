import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.VYNOPS_SUPER_ADMIN_DATA_DIR || join(WEB_DIR, 'data')
const AUDIT_PATH = process.env.VYNOPS_SUPER_ADMIN_AUDIT_PATH || join(WEB_DIR, 'audit.log.jsonl')

export function designateSuperAdmin(email, { dataDir = DATA_DIR, auditPath = AUDIT_PATH } = {}) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase()
  if (!normalizedEmail) throw new Error('Usage: node scripts/designate-super-admin.mjs <existing-admin-email>')

  const usersPath = join(dataDir, 'users.json')
  if (!existsSync(usersPath)) throw new Error('User store does not exist; no account was created')
  const users = JSON.parse(readFileSync(usersPath, 'utf8'))
  if (!Array.isArray(users)) throw new Error('User store is invalid; refusing to change it')

  const matches = users.filter(user => String(user.email ?? '').trim().toLowerCase() === normalizedEmail)
  if (matches.length !== 1) throw new Error('Email must match exactly one existing user; no changes were made')
  const target = matches[0]
  if (target.role !== 'admin' || target.status === 'blocked') {
    throw new Error('The selected existing user must be an active admin; no changes were made')
  }

  const designated = users.filter(user => user.isSuperAdmin === true)
  if (designated.some(user => user.id !== target.id)) {
    throw new Error('A different super-admin is already designated; no changes were made')
  }

  const updatedUsers = users.map(user => ({ ...user, isSuperAdmin: user.id === target.id }))
  const temporaryPath = `${usersPath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(updatedUsers, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temporaryPath, 0o600)
  renameSync(temporaryPath, usersPath)
  chmodSync(usersPath, 0o600)
  appendFileSync(auditPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    user: 'server-operator',
    action: 'user.super_admin.designated',
    detail: `designated existing admin ${target.email}`,
  })}\n`)

  return { id: target.id, email: target.email }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = designateSuperAdmin(process.argv[2])
    console.log(`Super-admin designated: ${result.email} (${result.id})`)
  } catch (error) {
    console.error(`[designate-super-admin] ${error.message}`)
    process.exitCode = 1
  }
}
