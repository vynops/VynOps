import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { assertOperator, assertSession, getSessionUserId } from '@/lib/rbac'
import { appendAuditLog } from '@/app/api/settings/config/shared'
import {
  type IncidentDoc,
  SEV_ORDER,
  getSlaMinutes,
  manualStore,
  persistStore,
  buildAutoIncidents,
  dispatchIncidentNotification,
} from '@/app/api/incidents/shared'

export async function GET() {
  const deny = await assertSession()
  if (deny) return deny
  const now = Date.now()
  const { incidents: autoIncidents, totalAlerts, hasPrometheus } = await buildAutoIncidents()

  // Merge: manualStore entries override auto-incidents with the same ID (don't duplicate)
  const manualEntries = Array.from(manualStore.values()).map(i => ({
    ...i,
    slaBreached: (i.state === 'resolved' && i.resolvedAt ? new Date(i.resolvedAt).getTime() : now) > new Date(i.slaDeadline).getTime(),
    durationMinutes: Math.round(((i.state === 'resolved' && i.resolvedAt ? new Date(i.resolvedAt).getTime() : now) - new Date(i.createdAt).getTime()) / 60000),
  }))
  const manualIds = new Set(manualEntries.map(i => i.id))

  const all: IncidentDoc[] = [
    ...autoIncidents.filter(i => !manualIds.has(i.id)),
    ...manualEntries,
  ].sort((a, b) => {
    if (a.state === 'resolved' && b.state !== 'resolved') return 1
    if (b.state === 'resolved' && a.state !== 'resolved') return -1
    const sb = (b.slaBreached ? 1 : 0) - (a.slaBreached ? 1 : 0)
    if (sb !== 0) return sb
    const sv = (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0)
    if (sv !== 0) return sv
    return b.durationMinutes - a.durationMinutes
  })

  const nonResolved = all.filter(i => i.state !== 'resolved')
  const open = nonResolved.length
  const critical = nonResolved.filter(i => i.severity === 'critical').length
  const slaBreachedCnt = all.filter(i => i.slaBreached).length
  const slaBreachingCnt = nonResolved.filter(i => {
    if (i.slaBreached) return false
    return new Date(i.slaDeadline).getTime() - now < 30 * 60 * 1000
  }).length

  const resolved = all.filter(i => i.state === 'resolved' && i.resolvedAt)
  const avgMttrMinutes = resolved.length > 0
    ? Math.round(
        resolved.reduce(
          (s, i) => s + (new Date(i.resolvedAt!).getTime() - new Date(i.createdAt).getTime()) / 60000,
          0,
        ) / resolved.length,
      )
    : null

  const slaCompliancePct = all.length > 0
    ? Math.round(((all.length - slaBreachedCnt) / all.length) * 100)
    : 100

  return NextResponse.json({
    incidents: all,
    metrics: {
      open,
      critical,
      slaBreached: slaBreachedCnt,
      slaBreaching: slaBreachingCnt,
      avgMttrMinutes,
      slaCompliancePct,
      totalAlerts,
    },
    source: hasPrometheus ? 'prometheus' : 'unavailable',
  })
}

export async function POST(req: NextRequest) {
  const deny = await assertOperator()
  if (deny) return deny
  const actor = await getSessionUserId() ?? 'authenticated-user'
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid incident body' }, { status: 400 })

  const title = (body.title ?? '').toString().trim()
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 })

  const now = Date.now()
  const severity = ['critical', 'high', 'medium', 'low'].includes(body.severity)
    ? (body.severity as string)
    : 'medium'
  const slaMins = getSlaMinutes()[severity]
  const id = `INC-${randomUUID().toUpperCase()}`

  const doc: IncidentDoc = {
    id,
    title,
    description: (body.description ?? '').toString().trim(),
    severity,
    state: 'open',
    owner: (body.owner ?? '').toString().trim() || 'Unassigned',
    team: (body.team ?? '').toString().trim() || 'Platform Engineering',
    service: (body.service ?? '').toString().trim() || 'unknown',
    environment: typeof body.environment === 'string' ? body.environment : 'production',
    labels: body.labels != null && typeof body.labels === 'object' ? body.labels : {},
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    slaDeadline: new Date(now + slaMins * 60 * 1000).toISOString(),
    slaBreached: false,
    alertCount: 0,
    alerts: [],
    timeline: [
      {
        id: `tl-${id}-0`,
        ts: new Date(now).toISOString(),
        type: 'user_action',
        title: 'Incident declared',
        description: 'Incident declared manually via Incident Command Center',
        actor,
      },
    ],
    blastRadius: {
      affectedServices: (body.service ?? '').toString().trim() ? [(body.service as string).trim()] : [],
      affectedUsers: 0,
      affectedRegions: [],
      slaBreached: false,
      dependentServices: [],
    },
    runbookUrls: [],
    linkedDeployments: [],
    source: 'manual',
    durationMinutes: 0,
    escalationLevel: 0,
    notificationPending: true,
    notificationEvent: 'incident.created',
  }

  manualStore.set(id, doc)
  persistStore()
  appendAuditLog({ ts: doc.createdAt, user: actor, action: 'incident.created', detail: id })
  await dispatchIncidentNotification(doc)

  return NextResponse.json(doc, { status: 201 })
}
