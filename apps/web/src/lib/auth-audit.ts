import { appendAuditLog } from '@/app/api/settings/config/shared'
import { createRateLimiter } from './rate-limit'

export interface AuthAuditIdentity {
  id?: string | null
  email?: string | null
}

const failedSignInLimit = createRateLimiter(5, 15 * 60 * 1000)

export function appendAuthAuditSafely(
  identity: AuthAuditIdentity,
  action: string,
  detail: string,
  writer: typeof appendAuditLog = appendAuditLog,
) {
  try {
    writer({
      ts: new Date().toISOString(),
      user: identity.email?.trim().toLowerCase() || identity.id || 'unknown',
      action,
      detail,
    })
  } catch {
    // Audit I/O must not prevent authentication from completing.
  }
}

export function logSuccessfulSignIn(identity: AuthAuditIdentity) {
  appendAuthAuditSafely(identity, 'auth.login', 'Credentials sign-in')
}

export function logSignOut(identity: AuthAuditIdentity) {
  appendAuthAuditSafely(identity, 'auth.logout', 'Session signed out')
}

export function logFailedSignIn(identity?: AuthAuditIdentity) {
  const limiterKey = identity?.id || 'unknown'
  if (!failedSignInLimit(limiterKey).ok) return
  appendAuthAuditSafely(identity ?? {}, 'auth.login_failed', 'Credentials rejected')
}
