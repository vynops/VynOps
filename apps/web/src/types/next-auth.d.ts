import NextAuth from 'next-auth'

declare module 'next-auth' {
  interface User {
    role: 'admin' | 'operator' | 'viewer'
    team: string
    avatar: string
    isSuperAdmin?: boolean
    mustChangePassword?: boolean
    status?: 'active' | 'blocked'
    sessionVersion?: number
    blocked?: boolean
  }

  interface Session {
    user: {
      id: string
      name: string
      email: string
      role: 'admin' | 'operator' | 'viewer'
      team: string
      avatar: string
      blocked: boolean
      isSuperAdmin: boolean
      mustChangePassword: boolean
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role: 'admin' | 'operator' | 'viewer'
    team: string
    avatar: string
    blocked: boolean
    isSuperAdmin: boolean
    sessionVersion: number
    mustChangePassword: boolean
  }
}

// Suppress unused import warning — this file is a declaration-only augmentation
export type { NextAuth }
