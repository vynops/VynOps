import { NextResponse }                                  from 'next/server'
import { manualStore, buildAutoIncidents, persistStore } from '@/app/api/incidents/shared'
import type { IncidentDoc }                              from '@/app/api/incidents/shared'
import { readFileSync, existsSync }                      from 'fs'
import { join }                                          from 'path'
import type { OnCallSchedule, OnCallMember }             from '@/app/api/settings/oncall/shared'
import { notifyEscalation }                              from '@/lib/notify'
import { readConfig }                                    from '@/app/api/settings/config/shared'
import { assertOperator }                                from '@/lib/rbac'

const ONCALL_FILE = join(process.cwd(), 'data', 'oncall.json')
const BASE        = (process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')

function readSchedules(): OnCallSchedule[] {
  try {
    if (!existsSync(ONCALL_FILE)) return []
    return (JSON.parse(readFileSync(ONCALL_FILE, 'utf8')) as { schedules: OnCallSchedule[] }).schedules ?? []
  } catch { return [] }
}

/**
 * POST /api/incidents/auto-escalate
 *
 * Scans all open incidents and fires the next escalation level when the
 * cumulative delay threshold has been reached. Called every 5 min by the
 * autonomous loop.
 *
 * Escalation fires per level when:
 *   elapsed_minutes >= sum(delayMins[0..levelIndex])
 *
 * e.g. with defaults (0 / 15 / 30):
 *   L1 fires at  0 min (immediately on first loop tick)
 *   L2 fires at 15 min
 *   L3 fires at 45 min
 *
 * Gated by the `auto_escalate_enabled` runtime config flag.
 * Only fires one level per incident per cycle.
 */
export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET
  const isInternal = !!(cronSecret && req.headers.get('x-internal-secret') === cronSecret)
  if (!isInternal) {
    const deny = await assertOperator()
    if (deny) return deny
  }

  const cfg = readConfig()
  if (!cfg.auto_escalate_enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'Auto-escalation disabled in settings' })
  }

  const schedules = readSchedules()
  const primary   = schedules[0]
  if (!primary?.escalationLevels?.length) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'No escalation levels defined' })
  }

  const levels  = primary.escalationLevels
  const members = primary.members

  // Build cumulative delay thresholds ? level i fires when elapsed >= cumDelays[i]
  const cumDelays: number[] = []
  let running = 0
  for (const lvl of levels) {
    running += lvl.delayMins
    cumDelays.push(running)
  }

  // Gather all open incidents (merge Prometheus auto-detected + manual)
  const { incidents: autoIncidents } = await buildAutoIncidents()
  const manualEntries = Array.from(manualStore.values())
  const manualIds     = new Set(manualEntries.map(i => i.id))
  const all: IncidentDoc[] = [
    ...autoIncidents.filter(i => !manualIds.has(i.id)),
    ...manualEntries,
  ]
  const open = all.filter(i => i.state !== 'resolved')

  const now    = Date.now()
  const nowIso = new Date(now).toISOString()
  const fired: { id: string; level: number; contact: string }[] = []

  for (const inc of open) {
    const elapsedMins  = (now - new Date(inc.createdAt).getTime()) / 60000
    const currentLevel = inc.escalationLevel ?? 0

    // Find the next level that should fire by now
    let nextLevelIdx: number | null = null
    for (let i = 0; i < levels.length; i++) {
      const levelN = i + 1
      if (currentLevel >= levelN) continue      // already done for this level
      if (elapsedMins >= cumDelays[i]) {
        nextLevelIdx = i
        break                                   // one level at a time
      }
    }
    if (nextLevelIdx === null) continue

    const nextLevel = nextLevelIdx + 1
    const levelDef  = levels[nextLevelIdx]
    const contact: OnCallMember | undefined =
      (levelDef?.memberId ? members.find(m => m.id === levelDef.memberId) : undefined)
      ?? members[nextLevelIdx % members.length]
    if (!contact) continue

    const levelDesc = levelDef?.description ?? `Level ${nextLevel}`
    const slaMs     = new Date(inc.slaDeadline).getTime()
    const minsLeft  = Math.round((slaMs - now) / 60000)
    const slaInfo   = inc.slaBreached
      ? 'SLA already breached'
      : minsLeft <= 0 ? 'SLA breach imminent' : `SLA breach in ${minsLeft}m`

    // Send Slack notification
    const slackSent = await notifyEscalation({
      incidentId:    inc.id,
      incidentTitle: inc.title,
      severity:      inc.severity,
      service:       inc.service,
      levelDesc,
      nextLevel,
      contactName:   contact.name,
      contactEmail:  contact.email,
      contactSlack:  contact.slack,
      url:           `${BASE}/incidents/${inc.id}`,
      autoTriggered: true,
      slaInfo,
    })

    // Promote to mutable store if auto-incident, then advance escalation level
    if (!manualStore.has(inc.id)) {
      manualStore.set(inc.id, structuredClone(inc))
    }
    const mutableInc          = manualStore.get(inc.id)!
    mutableInc.escalationLevel = nextLevel
    mutableInc.updatedAt       = nowIso
    mutableInc.timeline.push({
      id:          `tl-${inc.id}-${now}-autoesc`,
      ts:          nowIso,
      type:        'escalation',
      title:       `Auto-escalated to L${nextLevel}`,
      description: `${levelDesc} ? ${contact.name} (${contact.email}) notified ? ${slaInfo}${slackSent ? ' ? Slack ?' : ''}`,
      actor:       'system',
    })
    manualStore.set(inc.id, mutableInc)

    fired.push({ id: inc.id, level: nextLevel, contact: contact.name })
  }

  if (fired.length > 0) persistStore()

  return NextResponse.json({
    ok:          true,
    checked:     open.length,
    fired:       fired.length,
    escalations: fired,
    ranAt:       nowIso,
  })
}
