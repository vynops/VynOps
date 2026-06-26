/**
 * Direct logic test for auto-escalation (bypasses HTTP auth).
 * Exercises the cumulative delay + SLA threshold maths inline.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir    = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(__dir, '..')
const CFG_FILE = join(WEB_ROOT, 'config.runtime.json')
const INC_FILE = join(WEB_ROOT, 'data', 'incidents-manual.json')
const ONC_FILE = join(WEB_ROOT, 'data', 'oncall.json')

function readJson(f) { try { return existsSync(f) ? JSON.parse(readFileSync(f,'utf8')) : {} } catch { return {} } }
function writeJson(f, d) { writeFileSync(f, JSON.stringify(d,null,2),'utf8') }
function pass(m) { console.log(`  ✅  ${m}`) }
function fail(m) { console.error(`  ❌  ${m}`); process.exitCode = 1 }
function section(t) { console.log(`\n── ${t} ──`) }

// ── inline replication of auto-escalate logic ─────────────────────────────
function getSlaMinutes(cfg) {
  return {
    critical: cfg.sla_minutes_critical  ?? 30,
    high:     cfg.sla_minutes_high      ?? 120,
    medium:   cfg.sla_minutes_medium    ?? 480,
    low:      cfg.sla_minutes_low       ?? 2880,
  }
}

function runAutoEscalate(cfg, incidents, schedules) {
  if (!cfg.auto_escalate_enabled) return { skipped: true, reason: 'disabled' }

  const primary = schedules[0]
  if (!primary?.escalationLevels?.length) return { skipped: true, reason: 'no levels' }

  const levels  = primary.escalationLevels
  const members = primary.members

  // cumulative delay thresholds
  const cumDelays = []
  let running = 0
  for (const lvl of levels) { running += lvl.delayMins; cumDelays.push(running) }

  const now    = Date.now()
  const nowIso = new Date(now).toISOString()
  const fired  = []

  for (const inc of incidents.filter(i => i.state !== 'resolved')) {
    const elapsedMins  = (now - new Date(inc.createdAt).getTime()) / 60000
    const currentLevel = inc.escalationLevel ?? 0

    let nextLevelIdx = null
    for (let i = 0; i < levels.length; i++) {
      const levelN = i + 1
      if (currentLevel >= levelN) continue
      if (elapsedMins >= cumDelays[i]) { nextLevelIdx = i; break }
    }
    if (nextLevelIdx === null) continue

    const nextLevel = nextLevelIdx + 1
    const levelDef  = levels[nextLevelIdx]
    const contact   = (levelDef?.memberId ? members.find(m => m.id === levelDef.memberId) : undefined)
                      ?? members[nextLevelIdx % members.length]
    if (!contact) continue

    const levelDesc = levelDef?.description ?? `Level ${nextLevel}`
    inc.escalationLevel = nextLevel
    inc.timeline.push({
      id: `tl-${inc.id}-${now}-autoesc`, ts: nowIso, type: 'escalation',
      title: `Auto-escalated to L${nextLevel}`,
      description: `${levelDesc} — ${contact.name} (${contact.email}) · elapsed ${Math.round(elapsedMins)}min`,
      actor: 'system',
    })
    fired.push({ id: inc.id, level: nextLevel, contact: contact.name, elapsedMins: Math.round(elapsedMins) })
  }

  return { skipped: false, checked: incidents.length, fired: fired.length, escalations: fired }
}

// ── Setup ─────────────────────────────────────────────────────────────────
const originalCfg = readJson(CFG_FILE)
const originalInc = readJson(INC_FILE)
const originalOnc = readJson(ONC_FILE)

// Ensure on-call schedule has escalation levels
const testSchedule = {
  id: 'primary', name: 'Platform Engineering', rotationDays: 7,
  rotationStart: '2026-06-01T00:00:00Z',
  members: [
    { id: 'm1', name: 'Alice Chen',   email: 'alice@vynops.io'   },
    { id: 'm2', name: 'Bob Patel',    email: 'bob@vynops.io'     },
    { id: 'm3', name: 'Carol Singh',  email: 'carol@vynops.io'   },
  ],
  escalationLevels: [
    { level: 1, delayMins:  0, description: 'Primary on-call' },
    { level: 2, delayMins: 15, description: 'Secondary (wake-up)' },
    { level: 3, delayMins: 30, description: 'Engineering Lead' },
  ],
}
writeJson(ONC_FILE, { schedules: [testSchedule] })

// ────────────────────────────────────────────────────────────────────────────
section('1. SLA maths: default windows')
const defaultSla = getSlaMinutes({})
defaultSla.critical === 30   ? pass('critical = 30 min')  : fail(`critical = ${defaultSla.critical}`)
defaultSla.high     === 120  ? pass('high = 120 min')      : fail(`high = ${defaultSla.high}`)
defaultSla.medium   === 480  ? pass('medium = 480 min')    : fail(`medium = ${defaultSla.medium}`)
defaultSla.low      === 2880 ? pass('low = 2880 min')      : fail(`low = ${defaultSla.low}`)

section('2. SLA maths: custom windows from config')
const customSla = getSlaMinutes({ sla_minutes_critical: 20, sla_minutes_high: 90 })
customSla.critical === 20  ? pass('critical overridden to 20 min') : fail(`critical = ${customSla.critical}`)
customSla.high     === 90  ? pass('high overridden to 90 min')     : fail(`high = ${customSla.high}`)
customSla.medium   === 480 ? pass('medium still default 480 min')  : fail(`medium = ${customSla.medium}`)

section('3. Cumulative delay logic (L1=0, L2=15, L3=30)')
// Cumulative: L1 at 0min, L2 at 15min, L3 at 45min
const levels = testSchedule.escalationLevels
const cumDelays = []; let r = 0
for (const l of levels) { r += l.delayMins; cumDelays.push(r) }
cumDelays[0] === 0  ? pass('L1 cumDelay = 0 min (fires immediately)') : fail(`L1 = ${cumDelays[0]}`)
cumDelays[1] === 15 ? pass('L2 cumDelay = 15 min')                    : fail(`L2 = ${cumDelays[1]}`)
cumDelays[2] === 45 ? pass('L3 cumDelay = 45 min')                    : fail(`L3 = ${cumDelays[2]}`)

section('4. Auto-escalate disabled → skipped')
const cfg_off = { auto_escalate_enabled: false }
const r4 = runAutoEscalate(cfg_off, [], [testSchedule])
r4.skipped ? pass('skipped=true when flag off') : fail('should have been skipped')

section('5. Incident 2min old → only L1 fires (cumDelay[0]=0)')
const inc_2min = [{
  id: 'INC-T1', title: 'Test', severity: 'critical', state: 'open',
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  escalationLevel: 0, timeline: [],
}]
const r5 = runAutoEscalate({ auto_escalate_enabled: true }, inc_2min, [testSchedule])
r5.fired === 1 ? pass(`L1 fired after 2 min (contact: ${r5.escalations[0].contact})`) : fail(`fired=${r5.fired}, expected 1`)
r5.escalations[0]?.level === 1 ? pass('escalated to level 1') : fail(`level = ${r5.escalations[0]?.level}`)

section('6. Incident 20min old, L1 already done → L2 fires')
const inc_20min = [{
  id: 'INC-T2', title: 'Test', severity: 'critical', state: 'open',
  createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  escalationLevel: 1, timeline: [],      // L1 already done
}]
const r6 = runAutoEscalate({ auto_escalate_enabled: true }, inc_20min, [testSchedule])
r6.fired === 1 ? pass(`L2 fired after 20 min (contact: ${r6.escalations[0].contact})`) : fail(`fired=${r6.fired}, expected 1`)
r6.escalations[0]?.level === 2 ? pass('escalated to level 2') : fail(`level = ${r6.escalations[0]?.level}`)

section('7. Incident 50min old, L1+L2 done → L3 fires')
const inc_50min = [{
  id: 'INC-T3', title: 'Test', severity: 'critical', state: 'open',
  createdAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
  escalationLevel: 2, timeline: [],
}]
const r7 = runAutoEscalate({ auto_escalate_enabled: true }, inc_50min, [testSchedule])
r7.fired === 1 ? pass(`L3 fired after 50 min (contact: ${r7.escalations[0].contact})`) : fail(`fired=${r7.fired}, expected 1`)
r7.escalations[0]?.level === 3 ? pass('escalated to level 3') : fail(`level = ${r7.escalations[0]?.level}`)

section('8. Incident 50min old, all levels exhausted → nothing fires')
const inc_done = [{
  id: 'INC-T4', title: 'Test', severity: 'critical', state: 'open',
  createdAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
  escalationLevel: 3, timeline: [],      // all 3 levels done
}]
const r8 = runAutoEscalate({ auto_escalate_enabled: true }, inc_done, [testSchedule])
r8.fired === 0 ? pass('0 fired when all levels exhausted') : fail(`fired=${r8.fired}, expected 0`)

section('9. Resolved incident → skipped')
const inc_res = [{
  id: 'INC-T5', title: 'Test', severity: 'critical', state: 'resolved',
  createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  escalationLevel: 0, timeline: [],
}]
const r9 = runAutoEscalate({ auto_escalate_enabled: true }, inc_res, [testSchedule])
r9.fired === 0 ? pass('resolved incident not escalated') : fail(`fired=${r9.fired}, expected 0`)

section('10. L3 should not fire at 20min (threshold=45min)')
const inc_20min_0 = [{
  id: 'INC-T6', title: 'Test', severity: 'critical', state: 'open',
  createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  escalationLevel: 0, timeline: [],
}]
const r10 = runAutoEscalate({ auto_escalate_enabled: true }, inc_20min_0, [testSchedule])
// L1 fires (0min threshold), then stops — only one level per cycle
r10.fired === 1 && r10.escalations[0]?.level === 1
  ? pass('Only L1 fires at 20min (one level per cycle)')
  : fail(`fired=${r10.fired} level=${r10.escalations[0]?.level}`)

section('11. Timeline [auto] event shape')
const tlEv = r5.escalations[0] // from test 5
// Re-run and check the actual incident object
const inc_tl = [{
  id: 'INC-T7', title: 'Test', severity: 'critical', state: 'open',
  createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  escalationLevel: 0, timeline: [],
}]
runAutoEscalate({ auto_escalate_enabled: true }, inc_tl, [testSchedule])
const ev = inc_tl[0].timeline[0]
ev?.actor === 'system'         ? pass('timeline event actor = "system"')      : fail(`actor = ${ev?.actor}`)
ev?.type  === 'escalation'     ? pass('timeline event type = "escalation"')   : fail(`type = ${ev?.type}`)
ev?.title?.includes('Auto-escalated') ? pass('title contains "Auto-escalated"') : fail(`title = ${ev?.title}`)

// ── Restore ───────────────────────────────────────────────────────────────
section('12. Restore original data')
writeJson(CFG_FILE, originalCfg); pass('config.runtime.json restored')
if (Object.keys(originalOnc).length) { writeJson(ONC_FILE, originalOnc); pass('oncall.json restored') }
else { import('fs').then(({unlinkSync}) => { try { unlinkSync(ONC_FILE) } catch {} }) }

console.log('\n── Done ──')
