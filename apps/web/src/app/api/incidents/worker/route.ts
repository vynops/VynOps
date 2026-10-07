import { NextResponse } from 'next/server'
import { buildAutoIncidents, reconcileAutoIncidents, manualStore, dispatchIncidentNotification, recordSlaBreaches, writeAtomicJson } from '@/app/api/incidents/shared'
import { POST as escalate } from '@/app/api/incidents/auto-escalate/route'
import { appendAuditLog } from '@/app/api/settings/config/shared'
import { join } from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const workerGlobal = globalThis as typeof globalThis & { vynopsIncidentCycle?: Promise<Response> }

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
    reconcileAutoIncidents(detected.incidents, detected.hasPrometheus)
    recordSlaBreaches()
    for (const incident of manualStore.values()) {
      if (incident.notificationPending) await dispatchIncidentNotification(incident)
    }
    const escalation = await escalate(req)
    if (!escalation.ok) throw new Error('Escalation cycle failed')
    const escalationResult = await escalation.json()
    const pending = [...manualStore.values()].filter(incident => incident.notificationPending).length
    const heartbeat = { startedAt, completedAt: new Date().toISOString(), ok: detected.hasPrometheus && pending === 0 && !escalationResult.failed, hasPrometheus: detected.hasPrometheus, incidents: manualStore.size, pending, escalationFailures: escalationResult.failed ?? 0 }
    const file = join(process.cwd(), 'data', 'incident-worker.json')
    writeAtomicJson(file, heartbeat)
    appendAuditLog({ ts: heartbeat.completedAt, user: 'system', action: 'incident.worker.completed', detail: `source=${detected.hasPrometheus ? 'healthy' : 'unavailable'} pending=${pending}` })
    return NextResponse.json(heartbeat)
  } catch {
    appendAuditLog({ ts: new Date().toISOString(), user: 'system', action: 'incident.worker.failed', detail: 'Incident cycle failed; inspect server logs and delivery history' })
    return NextResponse.json({ ok: false, error: 'Incident cycle failed' }, { status: 500 })
  }
}