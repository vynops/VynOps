import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { z } from 'zod'

// -- Fallback demo users (used only when data/users.json is absent) --------
const DEMO_USERS = [
  { id: '1', name: 'Alex Karev',   email: 'admin@VynOps.io',    role: 'admin'    as const, team: 'Platform Engineering', avatar: 'AK' },
  { id: '2', name: 'Sarah Chen',   email: 'operator@VynOps.io', role: 'operator' as const, team: 'SRE',                  avatar: 'SC' },
  { id: '3', name: 'Mike Johnson', email: 'viewer@VynOps.io',   role: 'viewer'   as const, team: 'Engineering',          avatar: 'MJ' },
]

// Fallback in-memory password hashes for the 3 demo users.
// In production, hashes live in data/passwords.json (written by /api/settings/users).
const PASSWORD_HASHES: Record<string, string> = {
  '1': process.env.USER_1_PASSWORD_HASH ?? bcrypt.hashSync(process.env.DEMO_ADMIN_PASSWORD    ?? 'admin123',    10),
  '2': process.env.USER_2_PASSWORD_HASH ?? bcrypt.hashSync(process.env.DEMO_OPERATOR_PASSWORD ?? 'operator123', 10),
  '3': process.env.USER_3_PASSWORD_HASH ?? bcrypt.hashSync(process.env.DEMO_VIEWER_PASSWORD   ?? 'viewer123',   10),
}

// -- Read users from data/users.json (upgrade-safe, live-reload) ----------
function readUsers(): typeof DEMO_USERS {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync, readFileSync } = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path') as typeof import('path')
    const p = join(process.cwd(), 'data', 'users.json')
    if (!existsSync(p)) return DEMO_USERS
    const arr = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(arr) && arr.length > 0 ? arr : DEMO_USERS
  } catch {
    return DEMO_USERS
  }
}

// -- Read bcrypt hash from data/passwords.json, fallback to in-memory -----
function getPasswordHash(userId: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync, readFileSync } = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path') as typeof import('path')
    const overridesPath = join(process.cwd(), 'data', 'passwords.json')
    if (existsSync(overridesPath)) {
      const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'))
      if (overrides[userId]) return overrides[userId]
    }
  } catch {}
  return PASSWORD_HASHES[userId]
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  pages: {
    signIn: '/login',
  },
  session: { strategy: 'jwt' },
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email', placeholder: 'you@VynOps.io' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials) => {
        const parsed = credentialsSchema.safeParse(credentials)
        if (!parsed.success) return null

        const { email, password } = parsed.data
        const user = readUsers().find((u) => u.email.toLowerCase() === email.toLowerCase())
        if (!user) return null

        const hash = getPasswordHash(user.id)
        const valid = hash ? await bcrypt.compare(password, hash) : false
        if (!valid) return null

        return { id: user.id, name: user.name, email: user.email, role: user.role, team: user.team, avatar: user.avatar }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const u = user as any
        // Explicitly persist standard fields - beta.25 does not always auto-populate
        token.name   = u.name
        token.email  = u.email
        token.role   = u.role
        token.team   = u.team
        token.avatar = u.avatar
      }
      return token
    },
    session({ session, token }) {
      if (session.user) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const u = session.user as any
        u.role = token.role
        u.team = token.team
        u.avatar = token.avatar
        u.id = token.sub
      }
      return session
    },
  },
})
