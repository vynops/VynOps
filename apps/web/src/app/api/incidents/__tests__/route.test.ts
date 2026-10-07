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
  notifyIncident: vi.fn().mockResolvedValue({ ok: true, channels: ['slack'], status: 'delivered' }),
}))

vi.mock('@/lib/rbac', () => ({ assertSession: vi.fn().mockResolvedValue(null), assertOperator: vi.fn().mockResolvedValue(null), getSessionUserId: vi.fn().mockResolvedValue('test-operator') }))
vi.mock('@/app/api/settings/config/shared', () => ({ appendAuditLog: vi.fn() }))

vi.mock('@/app/api/incidents/shared', () => ({
  manualStore: new Map(),
  persistStore: vi.fn(),
  getSlaMinutes: () => ({ critical: 30, high: 120, medium: 480, low: 2880 }),
  SEV_ORDER: { critical: 4, high: 3, medium: 2, low: 1 },
  buildAutoIncidents: vi.fn().mockResolvedValue({ incidents: [], totalAlerts: 0, hasPrometheus: false }),
  reconcileAutoIncidents: vi.fn(),
  dispatchIncidentNotification: async (incident: unknown) => {
    const { notifyIncident } = await import('@/lib/notify')
    await notifyIncident(incident as any)
  },
}))

import { GET, POST } from '@/app/api/incidents/route'
import { notifyIncident } from '@/lib/notify'
import { manualStore } from '@/app/api/incidents/shared'

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/incidents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/incidents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    manualStore.clear()
  })

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

  it('does not turn a timely resolution into an SLA breach as time passes', async () => {
    const response = await POST(makeRequest({ title: 'Resolved test', severity: 'critical' }) as any)
    const created = await response.json()
    const incident = manualStore.get(created.id)!
    incident.createdAt = new Date(Date.now() - 120 * 60000).toISOString()
    incident.slaDeadline = new Date(Date.now() - 90 * 60000).toISOString()
    incident.resolvedAt = new Date(Date.now() - 100 * 60000).toISOString()
    incident.state = 'resolved'
    const result = await (await GET()).json()
    expect(result.incidents[0].slaBreached).toBe(false)
    expect(result.metrics.slaCompliancePct).toBe(100)
  })
})
