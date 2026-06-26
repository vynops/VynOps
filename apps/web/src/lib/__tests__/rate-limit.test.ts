import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRateLimiter } from '@/lib/rate-limit'

describe('createRateLimiter()', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('allows requests up to the max limit', () => {
    const check = createRateLimiter(3, 60_000)
    expect(check('user').ok).toBe(true)
    expect(check('user').ok).toBe(true)
    expect(check('user').ok).toBe(true)
  })

  it('blocks the request that exceeds the limit', () => {
    const check = createRateLimiter(3, 60_000)
    check('user'); check('user'); check('user')
    const r = check('user')
    expect(r.ok).toBe(false)
    expect(r.retryAfterSecs).toBeGreaterThan(0)
    expect(r.retryAfterSecs).toBeLessThanOrEqual(60)
  })

  it('tracks different keys independently', () => {
    const check = createRateLimiter(1, 60_000)
    expect(check('alice').ok).toBe(true)
    expect(check('alice').ok).toBe(false)
    expect(check('bob').ok).toBe(true)   // separate counter, unaffected
    expect(check('carol').ok).toBe(true)
  })

  it('resets the counter after the window expires', () => {
    const check = createRateLimiter(1, 60_000)
    check('user')
    expect(check('user').ok).toBe(false)
    vi.advanceTimersByTime(60_001)
    expect(check('user').ok).toBe(true)
  })

  it('does not reset before the window expires', () => {
    const check = createRateLimiter(1, 60_000)
    check('user')
    vi.advanceTimersByTime(59_999)
    expect(check('user').ok).toBe(false)
  })

  it('ai chat limit: allows exactly 20 requests then blocks', () => {
    const check = createRateLimiter(20, 60_000)
    for (let i = 0; i < 20; i++) {
      expect(check('u').ok).toBe(true)
    }
    expect(check('u').ok).toBe(false)
  })
})
