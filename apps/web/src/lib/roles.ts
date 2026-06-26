/** Client-safe role constants and helpers — no server imports. */

export type Role = 'admin' | 'operator' | 'viewer'

// Permission map
const PERMISSIONS: Record<Role, string[]> = {
  admin: ['*'],
  operator: [
    'view:*',
    'acknowledge:incident',
    'resolve:incident',
    'create:incident',
    'run:automation',
    'mute:alert',
  ],
  viewer: ['view:*'],
}

/** Check whether `role` has permission to perform `action`. */
export function can(role: Role, action: string): boolean {
  const perms = PERMISSIONS[role]
  if (!perms) return false
  return perms.some((p) => {
    if (p === '*') return true
    if (p === action) return true
    if (p.endsWith(':*')) return action.startsWith(p.slice(0, -1))
    return false
  })
}

/** Human-readable role labels */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
}

/** Role badge colors (Tailwind) */
export const ROLE_COLORS: Record<Role, string> = {
  admin: 'text-brand-400 bg-brand-500/10 border-brand-500/20',
  operator: 'text-warning-400 bg-warning-500/10 border-warning-500/20',
  viewer: 'text-surface-400 bg-surface-700/50 border-surface-600/30',
}
