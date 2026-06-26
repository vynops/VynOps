'use client'

import { useSession } from 'next-auth/react'
import type { Role } from '@/lib/roles'
import { can } from '@/lib/roles'

interface RoleGateProps {
  /** Required permission string, e.g. 'run:automation' or 'view:*' */
  action: string
  /** Shown to unauthorized users instead of null (optional) */
  fallback?: React.ReactNode
  children: React.ReactNode
}

/**
 * Conditionally renders children only when the authenticated user
 * has the required permission. Falls back to null (or `fallback`).
 */
export function RoleGate({ action, fallback = null, children }: RoleGateProps) {
  const { data: session } = useSession()
  const role = (session?.user as { role?: Role })?.role

  if (!role || !can(role, action)) return <>{fallback}</>
  return <>{children}</>
}
