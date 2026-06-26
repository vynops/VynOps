import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { OnCallSchedule, OnCallMember } from '@/app/api/settings/oncall/shared'
import { notifyEscalation } from '@/lib/notify'
import { assertOperator } from '@/lib/rbac'

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
  try { body = await req.json() } catch { body = {} }

  const currentLevel = body.currentLevel ?? 0
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
  const contact: OnCallMember =
    (levelDef?.memberId ? members.find(m => m.id === levelDef.memberId) : undefined)
    ?? members[nextIdx % members.length]!

  const levelDesc  = levelDef?.description ?? `Level ${nextIdx + 1}`
  const hasMore    = nextIdx + 1 < Math.max(members.length, levels.length)
  const nextLevel  = nextIdx + 1

  // Send Slack notification only for real escalations (not probe/check calls)
  const slackSent = body.checkOnly
    ? false
    : await notifyEscalation({
    incidentId:    body.incidentId    ?? 'INC-???',
    incidentTitle: body.incidentTitle ?? 'Incident',
    severity:      body.severity      ?? 'high',
    service:       body.service       ?? '',
    levelDesc,
    nextLevel,
    contactName:   contact.name,
    contactEmail:  contact.email,
    contactSlack:  contact.slack,
    url:           body.url,
  })

  return NextResponse.json({
    exhausted:  false,
    nextLevel,
    contact,
    levelDesc,
    hasMore,
    totalLevels: Math.max(members.length, levels.length),
    slackSent,
  })
}
