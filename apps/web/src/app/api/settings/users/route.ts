import { NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import bcrypt from 'bcryptjs'
import { assertAdmin, assertOperator, assertSession, getSessionUserId } from '@/lib/rbac'
import { appendAuditLog } from '@/app/api/settings/config/shared'
import { auth } from '@/lib/auth'

const DATA_DIR       = join(process.cwd(), 'data')
const USERS_FILE     = join(DATA_DIR, 'users.json')
const PASSWORDS_FILE = join(DATA_DIR, 'passwords.json')

type StoredUser = {
  id: string
  name: string
  email: string
  role: 'admin' | 'operator' | 'viewer'
  team: string
  avatar: string
  createdAt: string
}

function readUsers(): StoredUser[] {
  try {
    if (!existsSync(USERS_FILE)) return []
    const parsed = JSON.parse(readFileSync(USERS_FILE, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function writeUsers(users: StoredUser[]) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8')
}

function readPasswords(): Record<string, string> {
  try {
    if (!existsSync(PASSWORDS_FILE)) return {}
    return JSON.parse(readFileSync(PASSWORDS_FILE, 'utf8'))
  } catch { return {} }
}

function writePasswords(p: Record<string, string>) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(PASSWORDS_FILE, JSON.stringify(p, null, 2), 'utf8')
}

function makeAvatar(name: string): string {
  return name.trim().split(/\s+/).map(n => n[0]).join('').slice(0, 2).toUpperCase()
}

// ?? GET ? list users (any authenticated user can view) ?????????????????????
export async function GET() {
  const deny = await assertSession()
  if (deny) return deny
  return NextResponse.json(readUsers())
}

// ?? POST ? create user (admin only) ??????????????????????????????????????
export async function POST(req: Request) {
  const deny = await assertAdmin()
  if (deny) return deny

  const body = await req.json()
  const { name, email, role, team, password } = body as {
    name: string; email: string; role?: string; team?: string; password: string
  }

  if (!name?.trim() || !email?.trim() || !password?.trim()) {
    return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 })
  }

  const users = readUsers()
  if (users.find(u => u.email.toLowerCase() === email.trim().toLowerCase())) {
    return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 })
  }

  const id = `user-${Date.now()}`
  const newUser: StoredUser = {
    id,
    name:      name.trim(),
    email:     email.trim().toLowerCase(),
    role:      (['admin', 'operator', 'viewer'].includes(role ?? '') ? role! : 'viewer') as StoredUser['role'],
    team:      team?.trim() ?? '',
    avatar:    makeAvatar(name),
    createdAt: new Date().toISOString(),
  }

  const hash = await bcrypt.hash(password, 12)
  const passwords = readPasswords()
  passwords[id] = hash
  writePasswords(passwords)

  users.push(newUser)
  writeUsers(users)

  const session = await auth()
  appendAuditLog({ ts: new Date().toISOString(), user: (session?.user as any)?.email ?? 'unknown', action: 'user.create', detail: `created user ${newUser.email} (${newUser.role})` })

  return NextResponse.json(newUser, { status: 201 })
}

// ?? PATCH ? update user profile or change password (admin only) ??????????
export async function PATCH(req: Request) {
  const deny = await assertAdmin()
  if (deny) return deny

  const body = await req.json()
  const { id, password, name, email, role, team } = body as {
    id: string; password?: string
    name?: string; email?: string; role?: string; team?: string
  }

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const users = readUsers()
  const idx = users.findIndex(u => u.id === id)
  if (idx === -1) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  if (email) {
    const conflict = users.find(u => u.id !== id && u.email.toLowerCase() === email.trim().toLowerCase())
    if (conflict) return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
  }

  const u = users[idx]
  if (name)             { u.name = name.trim(); u.avatar = makeAvatar(name) }
  if (email)            u.email = email.trim().toLowerCase()
  if (role && ['admin', 'operator', 'viewer'].includes(role)) u.role = role as StoredUser['role']
  if (team !== undefined) u.team = team.trim()

  writeUsers(users)

  if (password?.trim()) {
    const hash = await bcrypt.hash(password, 12)
    const passwords = readPasswords()
    passwords[id] = hash
    writePasswords(passwords)
  }

  const session = await auth()
  const actor = (session?.user as any)?.email ?? 'unknown'
  if (password?.trim()) {
    appendAuditLog({ ts: new Date().toISOString(), user: actor, action: 'user.password_change', detail: `changed password for user ${u.email}` })
  } else {
    appendAuditLog({ ts: new Date().toISOString(), user: actor, action: 'user.update', detail: `updated profile for user ${u.email}` })
  }

  return NextResponse.json(u)
}

// ?? DELETE ? remove user (admin only, cannot self-delete) ?????????????????
export async function DELETE(req: Request) {
  const deny = await assertAdmin()
  if (deny) return deny

  const { id } = await req.json() as { id: string }
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const requesterId = await getSessionUserId()
  if (id === requesterId) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 })
  }

  const users = readUsers()
  if (!users.find(u => u.id === id)) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const deletedUser = users.find(u => u.id === id)
  writeUsers(users.filter(u => u.id !== id))

  const passwords = readPasswords()
  delete passwords[id]
  writePasswords(passwords)

  const session = await auth()
  appendAuditLog({ ts: new Date().toISOString(), user: (session?.user as any)?.email ?? 'unknown', action: 'user.delete', detail: `deleted user ${deletedUser?.email ?? id}` })

  return NextResponse.json({ ok: true })
}
