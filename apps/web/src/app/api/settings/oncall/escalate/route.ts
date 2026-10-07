import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { OnCallSchedule, OnCallMember } from '@/app/api/settings/oncall/shared'
import { notifyEscalation } from '@/lib/notify'
import { assertOperator } from '@/lib/rbac'
import { getSessionUserId } from '@/lib/rbac'
import { manualStore, buildAutoIncidents, persistStore, escalationLocks } from '@/app/api/incidents/shared'
import { resolveEscalationContact } from '@/app/api/settings/oncall/shared'
import { appendAuditLog } from '@/app/api/settings/config/shared'

const ONCALL_FILE = join(process.cwd(), 'data', 'oncall.json')

function readSchedules(): OnCallSchedule[] {
  try {
    if (!existsSync(ONCALL_FILE)) return []
    return (JSON.parse(readFileSync(ONCALL_FILE, 'utf8')) as { schedules: OnCallSchedule[] }).schedules ?? []
  } catch { return [] }
}

function currentOnCall(sched: OnCallSchedule): OnCallMember | null {
  const now = Date.now()
  if (sched.overrideUntil && sched.overrideMember && new Date(sched.overrideUntil).getTime() > now)
    return sched.overrideMember
  if (!sched.members.length) return null
  const rotMs   = sched.rotationDays * 24 * 60 * 60 * 1000
  const elapsed = now - new Date(sched.rotationStart).getTime()
  const idx     = Math.floor(elapsed / rotMs) % sched.members.length
  return sched.members[Math.max(0, idx)] ?? sched.members[0] ?? null
}

/**
 * POST /api/settings/oncall/escalate
 * Body: { currentLevel: number, checkOnly?: boolean, incidentId?: string, incidentTitle?: string, severity?: string, service?: string, url?: string }
 *
 * checkOnly=true  ? just return next contact + exhaustion status, do NOT send Slack
 * checkOnly=false ? resolve contact AND send Slack message
 */
export async function POST(req: NextRequest) {
  const deny = await assertOperator()
  if (deny) return deny

  let body: { currentLevel?: number; checkOnly?: boolean; incidentId?: string; incidentTitle?: string; severity?: string; service?: string; url?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid escalation body' }, { status: 400 })
  if (body.currentLevel !== undefined && (!Number.isInteger(body.currentLevel) || body.currentLevel < 0)) return NextResponse.json({ error: 'Invalid escalation level' }, { status: 400 })
  const actor = await getSessionUserId() ?? 'authenticated-user'
  let incident = body.incidentId ? manualStore.get(body.incidentId) : undefined
  if (!body.checkOnly && !incident && body.incidentId) {
    const detected = await buildAutoIncidents()
    const found = detected.incidents.find(item => item.id === body.incidentId)
    if (found) { incident = structuredClone(found); manualStore.set(incident.id, incident); persistStore() }
  }
  if (!body.checkOnly && !incident) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  if (incident?.state === 'resolved') return NextResponse.json({ error: 'Incident is resolved' }, { status: 409 })

  const currentLevel = incident?.escalationLevel ?? body.currentLevel ?? 0
  const schedules    = readSchedules()
  const primary      = schedules[0]

  if (!primary) return NextResponse.json({ error: 'No on-call schedule' }, { status: 404 })

  const levels  = primary.escalationLevels ?? []
  const members = primary.members

  // nextIdx is 0-based escalation step
  const nextIdx = currentLevel  // e.g. currentLevel=0 ? index 0 (L1), currentLevel=1 ? index 1 (L2)

  if (nextIdx >= members.length && nextIdx >= levels.length) {
    return NextResponse.json({ exhausted: true, message: 'All escalation levels have been notified' })
  }

  // Resolve contact: use explicit memberId on the level if set, else fall back to index
  const levelDef  = levels[nextIdx]
  const contact = resolveEscalationContact(primary, nextIdx)
  if (!contact) return NextResponse.json({ error: 'No on-call contact available' }, { status: 503 })

  const levelDesc  = levelDef?.description ?? `Level ${nextIdx + 1}`
  const hasMore    = nextIdx + 1 < Math.max(members.length, levels.length)
  const nextLevel  = nextIdx + 1

  if (incident && !body.checkOnly && escalationLocks.has(incident.id)) return NextResponse.json({ error: 'Escalation already running' }, { status: 409 })
  if (incident && !body.checkOnly) escalationLocks.add(incident.id)
  try {

  // Send Slack notification only for real escalations (not probe/check calls)
  const slackSent = body.checkOnly
    ? false
    : await notifyEscalation({
    incidentId:    incident!.id,
    incidentTitle: incident!.title,
    severity:      incident!.severity,
    service:       incident!.service,
    levelDesc,
    nextLevel,
    contactName:   contact.name,
    contactEmail:  contact.email,
    contactSlack:  contact.slack,
    url:           `${(process.env.NEXTAUTH_URL ?? 'http://localhost:3030').replace(/\/$/, '')}/incidents?id=${encodeURIComponent(incident!.id)}`,
  })

  if (incident && !body.checkOnly) {
    const now = new Date().toISOString()
    if (slackSent) incident.escalationLevel = nextLevel
    incident.updatedAt = now
    incident.timeline.push({ id: `tl-${incident.id}-${now}-manual-escalation`, ts: now, type: 'escalation', title: slackSent ? `Escalated to L${nextLevel}` : `L${nextLevel} escalation delivery failed`, description: `${levelDesc}: delivery ${slackSent ? 'accepted' : 'failed; level unchanged'}`, actor, metadata: { level: nextLevel, delivered: slackSent } })
    persistStore()
    appendAuditLog({ ts: now, user: actor, action: slackSent ? 'incident.escalated' : 'incident.escalation.failed', detail: incident.id })
    if (!slackSent) return NextResponse.json({ error: 'Escalation delivery failed', slackSent: false }, { status: 502 })
  }

  return NextResponse.json({
    exhausted:  false,
    nextLevel,
    contact,
    levelDesc,
    hasMore,
    totalLevels: Math.max(members.length, levels.length),
    slackSent,
  })
  } finally {
    if (incident && !body.checkOnly) escalationLocks.delete(incident.id)
  }
}
