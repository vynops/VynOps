import NextAuth from 'next-auth'

declare module 'next-auth' {
  interface User {
    role: 'admin' | 'operator' | 'viewer'
    team: string
    avatar: string
  }

  interface Session {
    user: {
      id: string
      name: string
      email: string
      role: 'admin' | 'operator' | 'viewer'
      team: string
      avatar: string
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role: 'admin' | 'operator' | 'viewer'
    team: string
    avatar: string
  }
}

// Suppress unused import warning — this file is a declaration-only augmentation
export type { NextAuth }
