import { NextResponse } from 'next/server'
import { buildAutoIncidents, reconcileAutoIncidents, manualStore, dispatchIncidentNotification, notificationDue, recordSlaBreaches, writeAtomicJson } from '@/app/api/incidents/shared'
import { POST as escalate } from '@/app/api/incidents/auto-escalate/route'
import { appendAuditLog } from '@/app/api/settings/config/shared'
import { notifyIncident } from '@/lib/notify'
import { join } from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const workerGlobal = globalThis as typeof globalThis & { vynopsIncidentCycle?: Promise<Response>; vynopsWorkerAudit?: { signature: string; at: number }; vynopsBlind?: { since: number | null; notified: boolean } }

// Without Prometheus nothing new is detected and nothing recovers, so tell people instead of staying quiet.
const BLIND_AFTER_MS = 5 * 60_000
async function trackMonitoringHealth(hasPrometheus: boolean) {
  const state = (workerGlobal.vynopsBlind ??= { since: null, notified: false })
  const url = `${(process.env.NEXTAUTH_URL ?? 'http://localhost:3030').replace(/\/$/, '')}/incidents`
  if (hasPrometheus) {
    const wasNotified = state.notified
    state.since = null
    state.notified = false
    if (wasNotified) {
      appendAuditLog({ ts: new Date().toISOString(), user: 'system', action: 'monitoring.restored', detail: 'Prometheus is reachable again' })
      await notifyIncident({ id: 'MONITORING', title: 'Monitoring restored: Prometheus is reachable again', severity: 'info', service: 'prometheus', state: 'restored', url }, 'monitoring.restored')
    }
    return
  }
  state.since ??= Date.now()
  if (!state.notified && Date.now() - state.since >= BLIND_AFTER_MS) {
    state.notified = true
    appendAuditLog({ ts: new Date().toISOString(), user: 'system', action: 'monitoring.unavailable', detail: 'Prometheus unreachable for 5+ minutes' })
    await notifyIncident({ id: 'MONITORING', title: 'Monitoring unavailable: VynOps cannot reach Prometheus, so new alerts and recoveries are not being detected', severity: 'critical', service: 'prometheus', state: 'unavailable', url }, 'monitoring.unavailable')
  }
}

export async function POST(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (workerGlobal.vynopsIncidentCycle) return NextResponse.json({ ok: true, skipped: true, reason: 'Cycle already running' })
  workerGlobal.vynopsIncidentCycle = runCycle(req)
  try {
    return await workerGlobal.vynopsIncidentCycle
  } finally {
    workerGlobal.vynopsIncidentCycle = undefined
  }
}

async function runCycle(req: Request) {
  const startedAt = new Date().toISOString()
  try {
    const detected = await buildAutoIncidents()
    await trackMonitoringHealth(detected.hasPrometheus)
    reconcileAutoIncidents(detected.incidents, detected.hasPrometheus)
    recordSlaBreaches()
    for (const incident of manualStore.values()) {
      if (incident.notificationPending && notificationDue(incident)) await dispatchIncidentNotification(incident)
    }
    const escalation = await escalate(req)
    if (!escalation.ok) throw new Error('Escalation cycle failed')
    const escalationResult = await escalation.json()
    const pending = [...manualStore.values()].filter(incident => incident.notificationPending).length
    const abandoned = [...manualStore.values()].filter(incident => incident.notificationAbandoned).length
    const heartbeat = { startedAt, completedAt: new Date().toISOString(), ok: detected.hasPrometheus && pending === 0 && abandoned === 0 && !escalationResult.failed, hasPrometheus: detected.hasPrometheus, incidents: manualStore.size, pending, abandoned, escalationFailures: escalationResult.failed ?? 0 }
    const file = join(process.cwd(), 'data', 'incident-worker.json')
    writeAtomicJson(file, heartbeat)
    // One audit line per state change, plus an hourly proof of life, instead of one per minute.
    const signature = `${detected.hasPrometheus}|${pending}|${abandoned}|${heartbeat.ok}`
    const last = workerGlobal.vynopsWorkerAudit
    if (!last || last.signature !== signature || Date.now() - last.at > 60 * 60_000) {
      workerGlobal.vynopsWorkerAudit = { signature, at: Date.now() }
      appendAuditLog({ ts: heartbeat.completedAt, user: 'system', action: 'incident.worker.completed', detail: `source=${detected.hasPrometheus ? 'healthy' : 'unavailable'} pending=${pending} abandoned=${abandoned}` })
    }
    return NextResponse.json(heartbeat)
  } catch {
    appendAuditLog({ ts: new Date().toISOString(), user: 'system', action: 'incident.worker.failed', detail: 'Incident cycle failed; inspect server logs and delivery history' })
    return NextResponse.json({ ok: false, error: 'Incident cycle failed' }, { status: 500 })
  }
}