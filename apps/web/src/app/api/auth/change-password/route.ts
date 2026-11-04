import { auth } from '@/lib/auth'
import bcrypt from 'bcryptjs'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { appendAuditLog } from '@/app/api/settings/config/shared'

const DATA_DIR      = join(process.cwd(), 'data')
const PASSWORDS_FILE = join(DATA_DIR, 'passwords.json')

// In-memory fallback hashes (same defaults as auth.ts) — used only to verify
// the current password when no persisted override exists yet.
const DEFAULT_PASSWORDS: Record<string, string> = {
  '1': process.env.USER_1_PASSWORD_HASH ?? bcrypt.hashSync(process.env.DEMO_ADMIN_PASSWORD    ?? 'admin123',    10),
  '2': process.env.USER_2_PASSWORD_HASH ?? bcrypt.hashSync(process.env.DEMO_OPERATOR_PASSWORD ?? 'operator123', 10),
  '3': process.env.USER_3_PASSWORD_HASH ?? bcrypt.hashSync(process.env.DEMO_VIEWER_PASSWORD   ?? 'viewer123',   10),
}

function readOverrides(): Record<string, string> {
  try {
    if (existsSync(PASSWORDS_FILE)) return JSON.parse(readFileSync(PASSWORDS_FILE, 'utf8'))
  } catch {}
  return {}
}

function getCurrentHash(userId: string): string {
  const overrides = readOverrides()
  return overrides[userId] ?? DEFAULT_PASSWORDS[userId] ?? ''
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { currentPassword?: string; newPassword?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { currentPassword, newPassword } = body
  if (!currentPassword || !newPassword) {
    return Response.json({ error: 'currentPassword and newPassword are required' }, { status: 400 })
  }
  if (newPassword.length < 8) {
    return Response.json({ error: 'New password must be at least 8 characters' }, { status: 400 })
  }
  if (currentPassword === newPassword) {
    return Response.json({ error: 'New password must differ from current password' }, { status: 400 })
  }

  const userId = (session.user as { id?: string }).id
  if (!userId) return Response.json({ error: 'Session has no user id' }, { status: 400 })

  const currentHash = getCurrentHash(userId)
  const valid = currentHash ? await bcrypt.compare(currentPassword, currentHash) : false
  if (!valid) return Response.json({ error: 'Current password is incorrect' }, { status: 403 })

  const newHash = await bcrypt.hash(newPassword, 12)

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const overrides = readOverrides()
  overrides[userId] = newHash
  writeFileSync(PASSWORDS_FILE, JSON.stringify(overrides, null, 2))

  const usersPath = join(DATA_DIR, 'users.json')
  if (existsSync(usersPath)) {
    const users = JSON.parse(readFileSync(usersPath, 'utf8'))
    if (Array.isArray(users)) {
      const user = users.find((item: { id?: string }) => item.id === userId)
      if (user?.mustChangePassword) {
        user.mustChangePassword = false
        user.sessionVersion = (user.sessionVersion ?? 0) + 1
        writeFileSync(usersPath, JSON.stringify(users, null, 2))
        const credentialFile = join(DATA_DIR, 'initial-admin-credentials.txt')
        if (user.isSuperAdmin && existsSync(credentialFile)) unlinkSync(credentialFile)
      }
    }
  }

  appendAuditLog({ ts: new Date().toISOString(), user: session.user.email ?? userId, action: 'user.password_change', detail: 'changed own password' })

  return Response.json({ ok: true })
}
