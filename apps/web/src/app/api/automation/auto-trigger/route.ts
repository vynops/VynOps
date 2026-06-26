import { NextResponse }                                  from 'next/server'
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs'
import { join }                                          from 'path'
import { readConfig }                                    from '@/app/api/settings/config/shared'
import { assertOperator }                                from '@/lib/rbac'
import { manualStore, buildAutoIncidents, persistStore } from '@/app/api/incidents/shared'
import type { IncidentDoc }                              from '@/app/api/incidents/shared'
import { resolveK8sUrl, K8S_TIMEOUT_MS }                from '@/lib/cluster'

const BASE     = (process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const DATA_DIR = join(process.cwd(), 'data')
const LOG_FILE = join(DATA_DIR, 'automation.log.jsonl')

// ?? Incident pattern ? runbook tag mapping ???????????????????????????????????
// Each entry: if the incident title/labels match `pattern`, queue runbook `runbookId`
const PATTERN_MAP: { pattern: RegExp; runbookId: string; autoRunAllowedDefault: boolean }[] = [
  { pattern: /CrashLoop|crash.?loop/i,     runbookId: 'diagnose-crash-loop',  autoRunAllowedDefault: true  },
  { pattern: /OOMKill|OOM|out.?of.?memory/i, runbookId: 'oom-patch-restart',  autoRunAllowedDefault: false },
  { pattern: /ImagePull|ErrImage/i,        runbookId: 'debug-imagepull',      autoRunAllowedDefault: true  },
  { pattern: /restart/i,                   runbookId: 'high-restart-pods',    autoRunAllowedDefault: true  },
  { pattern: /Terminating|stuck/i,         runbookId: 'force-delete-terminating', autoRunAllowedDefault: false },
  { pattern: /rollback|failed.?deploy/i,   runbookId: 'rollback-deployment',  autoRunAllowedDefault: false },
  { pattern: /evict/i,                     runbookId: 'cleanup-evicted',      autoRunAllowedDefault: true  },
  { pattern: /tls|cert|expir/i,            runbookId: 'audit-tls-certs',      autoRunAllowedDefault: true  },
  { pattern: /scale|replica|traffic.?spike/i, runbookId: 'scale-deployment',  autoRunAllowedDefault: false },
]

const COOLDOWN_MS = 60 * 60 * 1000  // 1 hour per runbook per incident

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function recentRunKey(incidentId: string, runbookId: string): string {
  return `${incidentId}::${runbookId}`
}

/** Read last-run timestamps from automation log (in-memory for one cycle) */
function buildRecentRuns(): Map<string, number> {
  const map = new Map<string, number>()
  try {
    if (!existsSync(LOG_FILE)) return map
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.triggeredBy === 'incident' && entry.incidentId && entry.runbookId && entry.runAt) {
          const key = recentRunKey(entry.incidentId, entry.runbookId)
          const ts  = new Date(entry.runAt).getTime()
          if ((map.get(key) ?? 0) < ts) map.set(key, ts)
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* non-critical */ }
  return map
}

function appendLog(entry: object) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* non-critical */ }
}

/**
 * POST /api/automation/auto-trigger
 *
 * Scans all open incidents. For each one, maps its title/labels against
 * PATTERN_MAP to find a matching runbook. If:
 *   - `auto_runbook_enabled` is true in config
 *   - the runbook's `autoRunAllowed` is true (per-runbook opt-in stored in config)
 *   - the same runbook hasn't run for this incident in the last hour
 * ? calls /api/automation/execute server-side and logs the result.
 *
 * Called by the autonomous loop every 5 min.
 */
export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET
  const isInternal = !!(cronSecret && req.headers.get('x-internal-secret') === cronSecret)
  if (!isInternal) {
    const deny = await assertOperator()
    if (deny) return deny
  }

  const cfg = readConfig()
  if (!cfg.auto_runbook_enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'Auto-runbook trigger disabled in settings' })
  }

  // Per-runbook opt-in map (keyed by runbookId, value: boolean)
  const allowedMap: Record<string, boolean> = cfg.auto_runbook_allowed ?? {}

  // Gather open incidents
  const { incidents: autoIncidents } = await buildAutoIncidents()
  const manualEntries = Array.from(manualStore.values())
  const manualIds     = new Set(manualEntries.map(i => i.id))
  const all: IncidentDoc[] = [
    ...autoIncidents.filter(i => !manualIds.has(i.id)),
    ...manualEntries,
  ]
  const open = all.filter(i => i.state !== 'resolved')

  const recentRuns = buildRecentRuns()
  const now        = Date.now()
  const triggered: { incidentId: string; runbookId: string; status: string }[] = []

  // Resolve default namespace from K8s (best-effort)
  let defaultNamespace = 'default'
  try {
    const K8S = await resolveK8sUrl()
    if (K8S) {
      const r = await fetch(`${K8S}/api/v1/namespaces`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      if (r.ok) {
        const d = await r.json()
        const ns: string[] = (d.items ?? [])
          .map((n: any) => n.metadata?.name as string)
          .filter((n: string) => n && !['kube-system','kube-public','kube-node-lease'].includes(n))
        if (ns.length) defaultNamespace = ns[0]!
      }
    }
  } catch { /* non-critical ? use default */ }

  for (const inc of open) {
    // Find first matching pattern
    const match = PATTERN_MAP.find(p => p.pattern.test(inc.title) || p.pattern.test(inc.service))
    if (!match) continue

    const { runbookId, autoRunAllowedDefault } = match

    // Check per-runbook opt-in (falls back to autoRunAllowedDefault)
    const allowed = runbookId in allowedMap ? allowedMap[runbookId] : autoRunAllowedDefault
    if (!allowed) continue

    // Cooldown check
    const runKey  = recentRunKey(inc.id, runbookId)
    const lastRun = recentRuns.get(runKey) ?? 0
    if (now - lastRun < COOLDOWN_MS) continue

    // Execute the runbook
    const runAt = new Date(now).toISOString()
    const runId = generateId()
    let execResult: any = null
    let status = 'failed'

    try {
      const res = await fetch(`${BASE}/api/automation/execute`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.CRON_SECRET ?? '',
        },
        body: JSON.stringify({
          runbookId,
          namespace: defaultNamespace,
          target:    '',
          params:    {},
        }),
        signal: AbortSignal.timeout(30_000),
      })
      execResult = await res.json()
      status = execResult?.status ?? 'failed'
    } catch (e: any) {
      execResult = { error: e.message }
    }

    // Append to automation log with trigger metadata
    const logEntry = {
      id:          runId,
      runAt,
      runbookId,
      namespace:   defaultNamespace,
      target:      '',
      triggeredBy: 'incident',
      incidentId:  inc.id,
      incidentTitle: inc.title,
      status,
      steps:       execResult?.steps ?? [],
      duration:    execResult?.duration ?? 0,
    }
    appendLog(logEntry)

    // Mark cooldown in-memory so same incident+runbook can't fire twice this cycle
    recentRuns.set(runKey, now)

    // Append auto-run timeline event to incident
    if (!manualStore.has(inc.id)) {
      manualStore.set(inc.id, structuredClone(inc))
    }
    const mutableInc = manualStore.get(inc.id)!
    mutableInc.timeline.push({
      id:          `tl-${inc.id}-${now}-autorun`,
      ts:          runAt,
      type:        'ai_insight',
      title:       `Auto-ran runbook: ${runbookId.replace(/-/g, ' ')}`,
      description: `Triggered by incident pattern match ? status: ${status}`,
      actor:       'system',
    })
    mutableInc.updatedAt = runAt
    manualStore.set(inc.id, mutableInc)

    triggered.push({ incidentId: inc.id, runbookId, status })
  }

  if (triggered.length > 0) persistStore()

  return NextResponse.json({
    ok:        true,
    checked:   open.length,
    triggered: triggered.length,
    runs:      triggered,
    ranAt:     new Date(now).toISOString(),
  })
}
