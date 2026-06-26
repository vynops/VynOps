import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}))

vi.mock('@/lib/notify', () => ({
  notifyIncident: vi.fn().mockResolvedValue(undefined),
}))

import { POST } from '@/app/api/incidents/route'
import { notifyIncident } from '@/lib/notify'

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/incidents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/incidents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when title is missing', async () => {
    const res = await POST(makeRequest({ severity: 'critical' }) as any)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/title/i)
  })

  it('returns 400 when title is empty string', async () => {
    const res = await POST(makeRequest({ title: '   ' }) as any)
    expect(res.status).toBe(400)
  })

  it('returns 400 on invalid JSON body', async () => {
    const req = new Request('http://localhost/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
  })

  it('creates an incident and returns 201 with correct shape', async () => {
    const res = await POST(makeRequest({
      title: 'Database latency spike',
      severity: 'critical',
      service: 'postgres',
    }) as any)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toMatch(/^INC-/)
    expect(body.title).toBe('Database latency spike')
    expect(body.severity).toBe('critical')
    expect(body.state).toBe('open')
    expect(body.source).toBe('manual')
    expect(body.service).toBe('postgres')
  })

  it('defaults severity to medium when invalid value given', async () => {
    const res = await POST(makeRequest({ title: 'Test', severity: 'extreme' }) as any)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.severity).toBe('medium')
  })

  it('calls notifyIncident after creation', async () => {
    await POST(makeRequest({ title: 'Alert fired', severity: 'high', service: 'api' }) as any)
    expect(notifyIncident).toHaveBeenCalledTimes(1)
    const call = vi.mocked(notifyIncident).mock.calls[0]![0]
    expect(call.title).toBe('Alert fired')
    expect(call.severity).toBe('high')
    expect(call.id).toMatch(/^INC-/)
  })

  it('does NOT call notifyIncident when title validation fails', async () => {
    await POST(makeRequest({}) as any)
    expect(notifyIncident).not.toHaveBeenCalled()
  })
})
