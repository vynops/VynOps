import { NextRequest, NextResponse } from 'next/server'
import { manualStore, buildAutoIncidents, persistStore } from '@/app/api/incidents/shared'
import type { IncidentDoc } from '@/app/api/incidents/shared'
import { assertOperator, assertSession } from '@/lib/rbac'

function rehydrate(inc: IncidentDoc): IncidentDoc {
  const now = Date.now()
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

  const { id } = await context.params
  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ensure mutable copy exists in the manual store
  if (!manualStore.has(id)) {
    const { incidents: all } = await buildAutoIncidents()
    const inc = all.find(i => i.id === id)
    if (!inc) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
    manualStore.set(id, structuredClone(inc))
  }

  const inc = manualStore.get(id)!
  const now    = Date.now()
  const nowIso = new Date(now).toISOString()

  // State change
  if (typeof body.state === 'string' && body.state !== inc.state) {
    const prev = inc.state
    inc.state     = body.state
    inc.updatedAt = nowIso
    if (body.state === 'resolved' && !inc.resolvedAt) inc.resolvedAt = nowIso
    inc.timeline.push({
      id:          `tl-${id}-${now}-state`,
      ts:          nowIso,
      type:        'user_action',
      title:       `Status \u2192 ${body.state}`,
      description: `Transitioned ${prev} \u2192 ${body.state}${typeof body.actor === 'string' && body.actor ? ` by ${body.actor}` : ''}`,
      actor:       typeof body.actor === 'string' ? body.actor : undefined,
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
      actor:       typeof body.actor === 'string' ? body.actor : undefined,
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
      actor:       typeof body.actor === 'string' ? body.actor : undefined,
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
      actor:       typeof body.actor === 'string' ? body.actor : undefined,
    })
  }

  manualStore.set(id, inc)
  persistStore()
  return NextResponse.json(rehydrate(inc))
}
