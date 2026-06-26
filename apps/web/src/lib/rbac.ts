// Re-export client-safe types and helpers from roles.ts so existing imports keep working.
export type { Role } from '@/lib/roles'
export { can, ROLE_LABELS, ROLE_COLORS } from '@/lib/roles'

// ── Server-only guards (uses auth() — never import this in client components) ──
import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'

/**
 * Route-handler guard: returns null if the caller is admin or operator.
 * Returns a 401 Response if unauthenticated, or a 403 Response if viewer.
 */
export async function assertOperator(): Promise<NextResponse | null> {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = (session.user as any)?.role as string | undefined
  if (role === 'viewer') {
    return NextResponse.json(
      { error: 'Forbidden: viewer role cannot perform mutations' },
      { status: 403 },
    )
  }
  return null
}

/**
 * Route-handler guard: returns null if the caller is authenticated (any role).
 * Returns 401 if unauthenticated.
 */
export async function assertSession(): Promise<NextResponse | null> {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

/**
 * Route-handler guard: returns null if the caller is admin.
 * Returns 401 if unauthenticated, 403 if operator or viewer.
 */
export async function assertAdmin(): Promise<NextResponse | null> {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = (session.user as any)?.role as string | undefined
  if (role !== 'admin') {
    return NextResponse.json(
      { error: 'Forbidden: admin role required' },
      { status: 403 },
    )
  }
  return null
}

/**
 * Returns the session user's id, or null if unauthenticated.
 */
export async function getSessionUserId(): Promise<string | null> {
  const session = await auth()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (session?.user as any)?.id ?? null
}
