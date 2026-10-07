import { NextRequest, NextResponse } from 'next/server'
import { manualStore, buildAutoIncidents, persistStore } from '@/app/api/incidents/shared'
import type { IncidentDoc } from '@/app/api/incidents/shared'
import { assertOperator, assertSession, getSessionUserId } from '@/lib/rbac'
import { appendAuditLog } from '@/app/api/settings/config/shared'

function rehydrate(inc: IncidentDoc): IncidentDoc {
  const now = inc.state === 'resolved' && inc.resolvedAt ? new Date(inc.resolvedAt).getTime() : Date.now()
  return {
    ...inc,
    slaBreached:     now > new Date(inc.slaDeadline).getTime(),
    durationMinutes: Math.round((now - new Date(inc.createdAt).getTime()) / 60000),
  }
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const deny = await assertSession()
  if (deny) return deny

  const { id } = await context.params

  if (manualStore.has(id)) {
    return NextResponse.json(rehydrate(manualStore.get(id)!))
  }

  // Call buildAutoIncidents directly ? no internal HTTP, uses current request's
  // next/headers() context so X-Prom-Url resolves correctly
  const { incidents: all } = await buildAutoIncidents()
  const inc = all.find(i => i.id === id)
  if (!inc) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  return NextResponse.json(rehydrate(inc))
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const deny = await assertOperator()
  if (deny) return deny
  const actor = await getSessionUserId() ?? 'authenticated-user'

  const { id } = await context.params
  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid incident body' }, { status: 400 })
  if (body.state !== undefined && !['open', 'acknowledged', 'investigating', 'mitigating', 'monitoring', 'resolved'].includes(String(body.state))) return NextResponse.json({ error: 'Invalid incident state' }, { status: 400 })

  // Ensure mutable copy exists in the manual store
  if (!manualStore.has(id)) {
    const { incidents: all } = await buildAutoIncidents()
    const inc = all.find(i => i.id === id)
    if (!inc) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
    manualStore.set(id, structuredClone(inc))
  }

  const inc = manualStore.get(id)!
  if (typeof body.escalationLevel === 'number' && body.escalationLevel > inc.escalationLevel) return NextResponse.json({ error: 'Use the on-call escalation endpoint' }, { status: 400 })
  const historyLength = inc.timeline.length
  const now    = Date.now()
  const nowIso = new Date(now).toISOString()

  // State change
  if (typeof body.state === 'string' && body.state !== inc.state) {
    const prev = inc.state
    inc.state     = body.state
    inc.updatedAt = nowIso
    if (body.state === 'resolved' && !inc.resolvedAt) inc.resolvedAt = nowIso
    if (body.state !== 'resolved') inc.resolvedAt = undefined
    inc.notificationChannels = []
    inc.notificationPending = true
    inc.notificationEvent = body.state === 'resolved' ? 'incident.resolved' : prev === 'resolved' ? 'incident.reopened' : 'incident.updated'
    inc.timeline.push({
      id:          `tl-${id}-${now}-state`,
      ts:          nowIso,
      type:        'user_action',
      title:       `Status \u2192 ${body.state}`,
      description: `Transitioned ${prev} \u2192 ${body.state}${typeof body.actor === 'string' && body.actor ? ` by ${body.actor}` : ''}`,
      actor,
    })
  }

  // Owner change
  if (typeof body.owner === 'string' && body.owner.trim() && body.owner !== inc.owner) {
    const prev = inc.owner
    inc.owner     = body.owner.trim()
    inc.updatedAt = nowIso
    inc.timeline.push({
      id:          `tl-${id}-${now}-owner`,
      ts:          nowIso,
      type:        'user_action',
      title:       `Assigned to ${inc.owner}`,
      description: `Ownership: ${prev} \u2192 ${inc.owner}`,
      actor,
    })
  }

  // Add timeline note
  if (typeof body.note === 'string' && body.note.trim()) {
    inc.timeline.push({
      id:          `tl-${id}-${now}-note`,
      ts:          nowIso,
      type:        'user_action',
      title:       typeof body.noteTitle === 'string' ? body.noteTitle : 'Update',
      description: body.note.trim(),
      actor,
    })
    inc.updatedAt = nowIso
  }

  // Escalation level advance
  if (typeof body.escalationLevel === 'number' && body.escalationLevel > (inc.escalationLevel ?? 0)) {
    const prevLevel  = inc.escalationLevel ?? 0
    inc.escalationLevel = body.escalationLevel
    inc.updatedAt       = nowIso
    inc.timeline.push({
      id:          `tl-${id}-${now}-escalate`,
      ts:          nowIso,
      type:        'escalation',
      title:       `Escalated to L${body.escalationLevel}`,
      description: typeof body.escalationDesc === 'string'
        ? body.escalationDesc
        : `Escalation level ${prevLevel} ? ${body.escalationLevel}`,
      actor,
    })
  }

  manualStore.set(id, inc)
  persistStore()
  if (inc.timeline.length > historyLength) appendAuditLog({ ts: nowIso, user: actor, action: 'incident.updated', fields: Object.keys(body).filter(field => field !== 'actor'), detail: id })
  return NextResponse.json(rehydrate(inc))
}
