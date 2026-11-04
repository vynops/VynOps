import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { logFailedSignIn, logSignOut, logSuccessfulSignIn } from '@/lib/auth-audit'
import { isAuthSessionBlocked, isConfiguredSuperAdmin } from '@/lib/super-admin'

// -- Development-only fallback users (never used in production) -----------
type AuthUser = {
  id: string
  name: string
  email: string
  role: 'admin' | 'operator' | 'viewer'
  team: string
  avatar: string
  status?: 'active' | 'blocked'
  isSuperAdmin?: boolean
  mustChangePassword?: boolean
  sessionVersion?: number
}

const DEMO_USERS: AuthUser[] = [
  { id: '1', name: 'Alex Karev',   email: 'admin@VynOps.io',    role: 'admin'    as const, team: 'Platform Engineering', avatar: 'AK' },
  { id: '2', name: 'Sarah Chen',   email: 'operator@VynOps.io', role: 'operator' as const, team: 'SRE',                  avatar: 'SC' },
  { id: '3', name: 'Mike Johnson', email: 'viewer@VynOps.io',   role: 'viewer'   as const, team: 'Engineering',          avatar: 'MJ' },
]

const DEMO_USERS_ENABLED = process.env.NODE_ENV !== 'production' && process.env.DEMO_USERS_ENABLED === 'true'

// Demo users require explicit local passwords. Persistent users use passwords.json.
const PASSWORD_HASHES: Record<string, string> = {
  '1': process.env.USER_1_PASSWORD_HASH ?? (process.env.DEMO_ADMIN_PASSWORD ? bcrypt.hashSync(process.env.DEMO_ADMIN_PASSWORD, 10) : ''),
  '2': process.env.USER_2_PASSWORD_HASH ?? (process.env.DEMO_OPERATOR_PASSWORD ? bcrypt.hashSync(process.env.DEMO_OPERATOR_PASSWORD, 10) : ''),
  '3': process.env.USER_3_PASSWORD_HASH ?? (process.env.DEMO_VIEWER_PASSWORD ? bcrypt.hashSync(process.env.DEMO_VIEWER_PASSWORD, 10) : ''),
}

function demoUsers(): AuthUser[] {
  return DEMO_USERS_ENABLED && DEMO_USERS.every(user => Boolean(PASSWORD_HASHES[user.id])) ? DEMO_USERS : []
}

// -- Read users from data/users.json (upgrade-safe, live-reload) ----------
function readUsers(): AuthUser[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync, readFileSync } = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path') as typeof import('path')
    const p = join(process.cwd(), 'data', 'users.json')
    if (!existsSync(p)) return demoUsers()
    const arr = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(arr) && arr.length > 0 ? arr as AuthUser[] : demoUsers()
  } catch {
    return demoUsers()
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
        if (!parsed.success) {
          logFailedSignIn()
          return null
        }

        const { email, password } = parsed.data
        const user = readUsers().find((u) => u.email.toLowerCase() === email.toLowerCase())
        if (!user) {
          logFailedSignIn()
          return null
        }
        if (user.status === 'blocked') {
          logFailedSignIn({ id: user.id, email: user.email })
          return null
        }

        const hash = getPasswordHash(user.id)
        const valid = hash ? await bcrypt.compare(password, hash) : false
        if (!valid) {
          logFailedSignIn({ id: user.id, email: user.email })
          return null
        }

        return {
          id: user.id, name: user.name, email: user.email, role: user.role,
          team: user.team, avatar: user.avatar, mustChangePassword: user.mustChangePassword === true,
          sessionVersion: user.sessionVersion ?? 0,
        }
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
        token.sessionVersion = u.sessionVersion ?? 0
        token.mustChangePassword = u.mustChangePassword === true
      }
      const userId = user?.id ?? token.sub
      const currentUsers = readUsers()
      const currentUser = userId ? currentUsers.find(candidate => candidate.id === userId) : undefined
      if (currentUser) {
        const tokenSessionVersion = Number(token.sessionVersion ?? user?.sessionVersion ?? 0)
        token.blocked = isAuthSessionBlocked(currentUser, tokenSessionVersion)
        token.isSuperAdmin = isConfiguredSuperAdmin(currentUsers, currentUser.id)
        token.mustChangePassword = currentUser.mustChangePassword === true
        token.role = currentUser.role
        token.name = currentUser.name
        token.email = currentUser.email
        token.team = currentUser.team
        token.avatar = currentUser.avatar
        token.sessionVersion = tokenSessionVersion
      } else {
        token.blocked = true
        token.isSuperAdmin = false
        token.mustChangePassword = false
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
        u.blocked = token.blocked === true
        u.isSuperAdmin = token.isSuperAdmin === true
        u.mustChangePassword = token.mustChangePassword === true
      }
      return session
    },
  },
  events: {
    signIn({ user }) {
      logSuccessfulSignIn({ id: user.id, email: user.email })
    },
    signOut(message) {
      const token = 'token' in message ? message.token : null
      const session = 'session' in message ? message.session : null
      const identity = token
        ? { id: token.sub, email: token.email }
        : { id: session?.userId }
      logSignOut(identity)
    },
  },
})
