export type AccountStatus = 'active' | 'blocked'

export interface SuperAdminCandidate {
  id: string
  role: string
  status?: AccountStatus
  isSuperAdmin?: boolean
}

export interface ManagedAccountState extends SuperAdminCandidate {
  sessionVersion?: number
}

export function getDesignatedSuperAdminId(users: SuperAdminCandidate[]): string | null {
  const designated = users.filter(user => user.isSuperAdmin === true)
  if (designated.length !== 1) return null
  return designated[0]?.id ?? null
}

export function getConfiguredSuperAdminId(users: SuperAdminCandidate[]): string | null {
  const id = getDesignatedSuperAdminId(users)
  const user = users.find(candidate => candidate.id === id)
  return user?.role === 'admin' && user.status !== 'blocked' ? id : null
}

export function isDesignatedSuperAdmin(users: SuperAdminCandidate[], userId: string | null | undefined): boolean {
  return !!userId && users.some(user => user.id === userId && user.isSuperAdmin === true)
}

export function isConfiguredSuperAdmin(users: SuperAdminCandidate[], userId: string | null | undefined): boolean {
  return !!userId && getConfiguredSuperAdminId(users) === userId
}

export function isAuthSessionBlocked(
  user: ManagedAccountState | null | undefined,
  tokenSessionVersion: number | undefined,
): boolean {
  if (!user || user.status === 'blocked') return true
  return (user.sessionVersion ?? 0) !== (tokenSessionVersion ?? 0)
}
