import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock next/server before importing rbac (which imports NextResponse at module level)
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}))

// Mock auth before importing rbac
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))

import { can, assertOperator } from '@/lib/rbac'
import { auth } from '@/lib/auth'

// ── can() ─────────────────────────────────────────────────────────────────

describe('can()', () => {
  it('admin is granted every action', () => {
    expect(can('admin', 'delete:pod')).toBe(true)
    expect(can('admin', 'view:metrics')).toBe(true)
    expect(can('admin', 'run:automation')).toBe(true)
    expect(can('admin', 'anything:at:all')).toBe(true)
  })

  it('viewer can only view', () => {
    expect(can('viewer', 'view:metrics')).toBe(true)
    expect(can('viewer', 'view:anything')).toBe(true)
    expect(can('viewer', 'run:automation')).toBe(false)
    expect(can('viewer', 'delete:pod')).toBe(false)
    expect(can('viewer', 'resolve:incident')).toBe(false)
  })

  it('operator can perform allowed mutations but not arbitrary ones', () => {
    expect(can('operator', 'run:automation')).toBe(true)
    expect(can('operator', 'acknowledge:incident')).toBe(true)
    expect(can('operator', 'view:anything')).toBe(true)
    expect(can('operator', 'delete:pod')).toBe(false)
    expect(can('operator', 'admin:cluster')).toBe(false)
  })
})

// ── assertOperator() ──────────────────────────────────────────────────────

describe('assertOperator()', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when session is null (unauthenticated)', async () => {
    vi.mocked(auth).mockResolvedValue(null as any)
    const res = await assertOperator()
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
    const body = await res!.json()
    expect(body.error).toMatch(/unauthorized/i)
  })

  it('returns 403 for viewer role', async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: 'viewer' } } as any)
    const res = await assertOperator()
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = await res!.json()
    expect(body.error).toMatch(/forbidden/i)
  })

  it('returns null (pass) for operator role', async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: 'operator' } } as any)
    expect(await assertOperator()).toBeNull()
  })

  it('returns null (pass) for admin role', async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: 'admin' } } as any)
    expect(await assertOperator()).toBeNull()
  })

  it('returns null when role field is missing (non-viewer default)', async () => {
    vi.mocked(auth).mockResolvedValue({ user: {} } as any)
    expect(await assertOperator()).toBeNull()
  })
})
