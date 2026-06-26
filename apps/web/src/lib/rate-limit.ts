export interface RateLimitResult {
  ok: boolean
  retryAfterSecs: number
}

/**
 * Creates an in-memory per-key rate limiter.
 * @param max       Maximum requests allowed within the window
 * @param windowMs  Window duration in milliseconds
 */
export function createRateLimiter(max: number, windowMs: number) {
  const map = new Map<string, { n: number; resetAt: number }>()

  return function check(key: string): RateLimitResult {
    const now = Date.now()
    const e   = map.get(key)

    if (!e || e.resetAt < now) {
      map.set(key, { n: 1, resetAt: now + windowMs })
      return { ok: true, retryAfterSecs: 0 }
    }
    if (e.n >= max) {
      return { ok: false, retryAfterSecs: Math.ceil((e.resetAt - now) / 1000) }
    }
    e.n++
    return { ok: true, retryAfterSecs: 0 }
  }
}
