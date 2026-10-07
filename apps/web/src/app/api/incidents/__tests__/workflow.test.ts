import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const sandbox = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vynops-incidents-'))
  fs.mkdirSync(path.join(root, 'data'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  return root
})
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } }) } }))
vi.mock('@/lib/cluster', () => ({ resolvePromUrl: async () => 'https://prometheus.example.invalid', K8S_TIMEOUT_MS: 100 }))
vi.mock('@/lib/rbac', () => ({ assertSession: vi.fn().mockResolvedValue(null), assertOperator: vi.fn().mockResolvedValue(null), getSessionUserId: async () => 'test-operator' }))
vi.mock('@/lib/auth', () => ({ auth: (handler: unknown) => handler }))
vi.mock('next', () => ({ default: () => ({ prepare: async () => {}, getRequestHandler: () => vi.fn() }) }))
vi.mock('http', () => ({ createServer: () => ({ prependListener: vi.fn(), listen: (_port: number, _host: string, ready: () => void) => ready() }) }))
vi.mock('ws', () => ({ WebSocketServer: class {}, WebSocket: class {} }))
vi.mock('@/app/api/settings/config/shared', () => ({ readConfig: () => config.current, appendNotifLog: vi.fn(), appendAuditLog: vi.fn() }))

import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { GET, POST } from '@/app/api/incidents/route'
import { PATCH } from '@/app/api/incidents/[id]/route'
import { POST as worker } from '@/app/api/incidents/worker/route'
import { POST as escalate } from '@/app/api/incidents/auto-escalate/route'
import { POST as manualEscalate } from '@/app/api/settings/oncall/escalate/route'
import { POST as alertWebhook } from '@/app/api/alerts/webhook/route'
import { manualStore, buildAutoIncidents, reconcileAutoIncidents, persistStore } from '@/app/api/incidents/shared'
import { notifyIncident, notifyEscalation } from '@/lib/notify'
import { appendAuditLog, appendNotifLog } from '@/app/api/settings/config/shared'
import { assertOperator } from '@/lib/rbac'
import { resolveEscalationContact } from '@/app/api/settings/oncall/shared'
import proxy from '@/proxy'

const request = (body: unknown) => new Request('http://localhost/api/incidents', { method: 'POST', body: JSON.stringify(body) }) as any
const cronRequest = () => new Request('http://localhost/api/incidents/worker', { method: 'POST', headers: { authorization: 'Bearer test-only' } })
let firing = true
let sourceOk = true
let deliveryOk = true
async function simulatedFetch(input: unknown, _init?: RequestInit) {
  const url = String(input)
  if (url.includes('/api/incidents/worker')) return new Response(JSON.stringify({ ok: true, pending: 0 }))
  if (url.includes('/api/autonomous/loop')) return new Response(JSON.stringify({ skipped: true }))
  if (url.startsWith('https://prometheus.example.invalid')) {
    if (!sourceOk) return new Response(JSON.stringify({ status: 'error' }), { status: 503 })
    const metric = { alertname: 'KubePodCrashLooping', severity: 'critical', job: 'test' }
    const result = firing ? [{ metric, value: [Date.now() / 1000, url.includes('ALERTS_FOR_STATE') ? String(Date.now() / 1000 - 120) : '1'] }] : []
    return new Response(JSON.stringify({ status: 'success', data: url.endsWith('/rules') ? { groups: [] } : { result } }))
  }
  return new Response(deliveryOk ? 'ok' : 'unavailable', { status: deliveryOk ? 200 : 503 })
}
const fetchMock = vi.fn(simulatedFetch)

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation(simulatedFetch)
  vi.stubEnv('CRON_SECRET', 'test-only')
  vi.stubGlobal('fetch', fetchMock)
  config.current = { slack_webhook_url: 'https://hooks.slack.com/services/test-only', auto_escalate_enabled: false }
  firing = sourceOk = deliveryOk = true
  manualStore.clear()
  persistStore()
  vi.mocked(assertOperator).mockResolvedValue(null)
})

afterAll(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(sandbox, { recursive: true, force: true })
})

describe('isolated incident workflow', () => {
  it('persists creation, ownership, notes, resolution and reopening with trusted actors', async () => {
    const incident = await (await POST(request({ title: 'Test incident', severity: 'high' }))).json()
    const context = { params: Promise.resolve({ id: incident.id }) }
    await PATCH(request({ owner: 'test-owner', note: 'triaged', actor: 'spoofed' }), context)
    await PATCH(request({ state: 'resolved', actor: 'spoofed' }), context)
    expect(manualStore.get(incident.id)!.resolvedAt).toBeTruthy()
    await PATCH(request({ state: 'investigating' }), context)
    const stored = JSON.parse(readFileSync(join(sandbox, 'data/incidents-manual.json'), 'utf8'))[incident.id]
    expect(stored.resolvedAt).toBeUndefined()
    expect(stored.owner).toBe('test-owner')
    expect(stored.timeline.filter((event: any) => event.type === 'user_action').every((event: any) => event.actor === 'test-operator')).toBe(true)
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'incident.created', user: 'test-operator' }))
    expect(stored.notificationPending).toBe(true)
  })

  it('rejects viewer creation and invalid lifecycle state', async () => {
    vi.mocked(assertOperator).mockResolvedValueOnce(new Response('Forbidden', { status: 403 }) as any)
    expect((await POST(request({ title: 'denied' }))).status).toBe(403)
    expect(manualStore.size).toBe(0)
    const created = await (await POST(request({ title: 'valid' }))).json()
    expect((await PATCH(request({ state: 'made-up' }), { params: Promise.resolve({ id: created.id }) })).status).toBe(400)
  })

  it('runs without browser or healing enabled, deduplicates notifications and preserves recovery history', async () => {
    expect((await worker(cronRequest())).status).toBe(200)
    const incident = [...manualStore.values()][0]
    expect(incident.source).toBe('auto')
    expect(incident.notificationPending).toBe(false)
    const deliveries = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com')).length
    expect(deliveries()).toBe(1)
    await worker(cronRequest())
    expect(deliveries()).toBe(1)
    firing = false
    await worker(cronRequest())
    expect(incident.state).toBe('resolved')
    expect(deliveries()).toBe(2)
    firing = true
    await worker(cronRequest())
    expect(incident.state).toBe('investigating')
    expect(incident.timeline.some(event => event.title === 'Alerts recovered')).toBe(true)
    expect(incident.timeline.some(event => event.title === 'Alerts firing again')).toBe(true)
    const heartbeat = JSON.parse(readFileSync(join(sandbox, 'data/incident-worker.json'), 'utf8'))
    expect(heartbeat.ok).toBe(true)
    expect(heartbeat.completedAt).toBeTruthy()
  })

  it('does not recover incidents on source failure', async () => {
    await worker(cronRequest())
    sourceOk = false
    const response = await (await worker(cronRequest())).json()
    expect(response.hasPrometheus).toBe(false)
    expect([...manualStore.values()][0].state).not.toBe('resolved')
  })

  it('retains pending delivery after bounded retries and retries on a later cycle', async () => {
    deliveryOk = false
    await worker(cronRequest())
    const incident = [...manualStore.values()][0]
    expect(incident.notificationPending).toBe(true)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com'))).toHaveLength(3)
    deliveryOk = true
    await worker(cronRequest())
    expect(incident.notificationPending).toBe(false)
    expect(incident.timeline.some(event => event.title === 'Notification failed')).toBe(true)
    expect(incident.timeline.some(event => event.title === 'Notification delivered')).toBe(true)
  })

  it('rejects cron calls without the matching secret', async () => {
    expect((await worker(request({}))).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not advance failed escalation and records successful retry exactly once', async () => {
    config.current.auto_escalate_enabled = true
    writeFileSync(join(sandbox, 'data/oncall.json'), JSON.stringify({ schedules: [{ members: [{ id: 'test-member', name: 'test-contact', email: 'test@example.invalid', slack: 'U123TEST' }], escalationLevels: [{ level: 1, delayMins: 0, description: 'Primary' }] }] }))
    const detected = await buildAutoIncidents()
    reconcileAutoIncidents(detected.incidents, detected.hasPrometheus)
    deliveryOk = false
    await escalate(cronRequest())
    const incident = [...manualStore.values()][0]
    expect(incident.escalationLevel).toBe(0)
    expect(incident.timeline.at(-1)?.title).toContain('failed')
    deliveryOk = true
    await escalate(cronRequest())
    expect(incident.escalationLevel).toBe(1)
    const count = incident.timeline.length
    await escalate(cronRequest())
    expect(incident.timeline).toHaveLength(count)
  })

  it('reports disabled and unconfigured channels without claiming delivery', async () => {
    config.current = { notify_on: { critical_incidents: false } }
    const payload = { id: 'test', title: 'test', severity: 'critical', service: 'test', state: 'open' }
    expect((await notifyIncident(payload)).status).toBe('disabled')
    expect(fetchMock).not.toHaveBeenCalled()
    config.current = {}
    vi.stubEnv('SLACK_WEBHOOK_URL', '')
    vi.stubEnv('ALERT_WEBHOOK_URL', '')
    vi.stubEnv('TEAMS_WEBHOOK_URL', '')
    expect((await notifyIncident(payload)).status).toBe('unconfigured')
    expect(appendNotifLog).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, status: 'unconfigured' }))
  })

  it('uses Slack user ID mention syntax', async () => {
    await notifyEscalation({ incidentId: 'test', incidentTitle: 'test', severity: 'high', service: 'test', levelDesc: 'Primary', nextLevel: 1, contactName: 'test-contact', contactEmail: 'test@example.invalid', contactSlack: 'U123TEST' })
    expect(appendNotifLog).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, incidentId: 'test' }))
    expect(fetchMock.mock.calls.at(-1)?.[1]?.body).toContain('<@U123TEST>')
  })

  it('persists real manual escalation and leaves failure retryable', async () => {
    writeFileSync(join(sandbox, 'data/oncall.json'), JSON.stringify({ schedules: [{ members: [{ id: 'test', name: 'test-contact', email: 'test@example.invalid' }], escalationLevels: [{ delayMins: 0, description: 'Primary' }] }] }))
    const incident = await (await POST(request({ title: 'manual test' }))).json()
    deliveryOk = false
    expect((await manualEscalate(request({ incidentId: incident.id, currentLevel: 99 }))).status).toBe(502)
    expect(manualStore.get(incident.id)!.escalationLevel).toBe(0)
    deliveryOk = true
    expect((await manualEscalate(request({ incidentId: incident.id }))).status).toBe(200)
    expect(manualStore.get(incident.id)!.escalationLevel).toBe(1)
    expect(appendAuditLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'incident.escalated', user: 'test-operator' }))
  })

  it('rejects malformed and unauthenticated webhooks, and exposes delivery failure for upstream retry', async () => {
    vi.stubEnv('ALERTMANAGER_SECRET', 'test-only')
    expect((await alertWebhook(request({}))).status).toBe(401)
    const send = (body: unknown) => new Request('http://localhost/api/alerts/webhook', { method: 'POST', headers: { 'x-alertmanager-secret': 'test-only' }, body: JSON.stringify(body) })
    expect((await alertWebhook(send({}))).status).toBe(400)
    const payload = { status: 'firing', commonLabels: { alertname: 'test', severity: 'high' }, groupLabels: {}, alerts: [{ status: 'firing', labels: { alertname: 'test' }, annotations: {}, startsAt: new Date().toISOString() }] }
    deliveryOk = false
    expect((await alertWebhook(send(payload))).status).toBe(502)
    expect(appendNotifLog).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'alert.firing', ok: false }))
  })

  it('starts and repeats the incident timer without a browser', async () => {
    vi.useFakeTimers()
    try {
      await import('../../../../../server.mjs')
      await vi.advanceTimersByTimeAsync(10000)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/incidents/worker'))).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(50000)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/incidents/worker'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates unique IDs even within the same millisecond', async () => {
    const responses = await Promise.all([POST(request({ title: 'one' })), POST(request({ title: 'two' }))])
    const incidents = await Promise.all(responses.map(response => response.json()))
    expect(incidents[0].id).not.toBe(incidents[1].id)
  })

  it('records an SLA breach once and freezes it after resolution', async () => {
    const created = await (await POST(request({ title: 'SLA test', severity: 'critical' }))).json()
    const incident = manualStore.get(created.id)!
    incident.slaDeadline = new Date(Date.now() - 60000).toISOString()
    await worker(cronRequest())
    await worker(cronRequest())
    expect(incident.timeline.filter(event => event.title === 'SLA deadline exceeded')).toHaveLength(1)
    expect(incident.notificationEvent).toBe('incident.sla_breached')
    await PATCH(request({ state: 'resolved' }), { params: Promise.resolve({ id: incident.id }) })
    expect((await (await GET()).json()).incidents.find((item: any) => item.id === incident.id).slaBreached).toBe(true)
  })

  it('respects rotation, override and explicit escalation contacts', () => {
    const members = [{ id: 'one', name: 'one', email: 'one@example.invalid' }, { id: 'two', name: 'two', email: 'two@example.invalid' }]
    const now = Date.now()
    const schedule = { id: 'test', name: 'test', members, rotationDays: 1, rotationStart: new Date(now - 86400000).toISOString(), escalationLevels: [{ level: 1, delayMins: 0, description: 'Primary' }] }
    expect(resolveEscalationContact(schedule, 0, now)?.id).toBe('two')
    expect(resolveEscalationContact({ ...schedule, overrideUntil: new Date(now + 1000).toISOString(), overrideMember: members[0] }, 0, now)?.id).toBe('one')
    expect(resolveEscalationContact({ ...schedule, escalationLevels: [{ ...schedule.escalationLevels[0], memberId: 'one' }] }, 0, now)?.id).toBe('one')
  })

  it('allows only exact cron paths with the matching secret through middleware', async () => {
    const call = (pathname: string, authorization: string) => proxy({ auth: null, nextUrl: { pathname }, headers: new Headers({ authorization }) } as any, {} as any)
    expect(await call('/api/incidents/worker', 'Bearer test-only')).toBeUndefined()
    expect((await call('/api/incidents/worker', 'Bearer wrong') as Response).status).toBe(401)
    expect((await call('/api/settings/config', 'Bearer test-only') as Response).status).toBe(401)
  })

  it('retries only undelivered channels after partial delivery', async () => {
    config.current.teams_webhook_url = 'https://teams.example.invalid/test-only'
    fetchMock.mockImplementation(async input => new Response(String(input).includes('teams.example.invalid') ? 'unavailable' : 'ok', { status: String(input).includes('teams.example.invalid') ? 503 : 200 }))
    const payload = { id: 'partial', title: 'partial', severity: 'high', service: 'test', state: 'open' }
    const first = await notifyIncident(payload)
    expect(first.channels).toEqual(['slack'])
    expect(first.ok).toBe(false)
    fetchMock.mockImplementation(async () => new Response('ok'))
    vi.clearAllMocks()
    const second = await notifyIncident(payload, 'incident.created', first.channels)
    expect(second.ok).toBe(true)
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('teams.example.invalid'))).toBe(true)
  })

  it('reloads persisted incident history and delivery state after module restart', async () => {
    const created = await (await POST(request({ title: 'restart test' }))).json()
    const previous = (globalThis as any).vynopsIncidentStore
    delete (globalThis as any).vynopsIncidentStore
    vi.resetModules()
    try {
      const reloaded = await import('@/app/api/incidents/shared')
      expect(reloaded.manualStore.get(created.id)?.notificationChannels).toEqual(['slack'])
      expect(reloaded.manualStore.get(created.id)?.timeline.some(event => event.title === 'Notification delivered')).toBe(true)
    } finally {
      Object.assign(globalThis, { vynopsIncidentStore: previous })
    }
  })
})