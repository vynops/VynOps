import { NextResponse }  from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { readConfig, appendAuditLog } from '@/app/api/settings/config/shared'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  readActions,
  readOutcomes,
  appendOutcome,
  buildPersistedCooldown,
  getEffectiveThreshold,
} from '@/lib/autonomousLearning'
import { resolveK8sUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

const SLACK = (process.env.SLACK_WEBHOOK_URL ?? '')
const BASE  = (process.env.NEXTAUTH_URL      ?? 'http://localhost:3000').replace(/\/$/, '')

const DATA_DIR = join(process.cwd(), 'data')
const LOG_FILE = join(DATA_DIR, 'autonomous.log.jsonl')

const COOLDOWN_MS      = 60 * 60 * 1000
const VERIFY_AFTER_MS  =  5 * 60 * 1000
const VERIFY_BEFORE_MS =  2 * 60 * 60 * 1000

// In-memory cooldown ? hydrated from log on startup/every 5 min (restart-safe)
const actionCooldown     = new Map<string, number>()
let   cooldownHydratedAt = 0

interface AutonomousAction {
  id:          string
  ts:          string
  insightId:   string
  insight:     string
  action:      string
  target:      string
  namespace:   string
  confidence:  number
  dryRun:      boolean
  result:      'ok' | 'failed' | 'dry_run' | 'skipped_cooldown' | 'unresolvable'
  error?:      string
  patternKey?: string
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function derivePatternKey(action: string, title: string): string {
  const t = title.toLowerCase()
  if (action === 'restart_deployment') {
    if (t.includes('oom') || t.includes('kill') || t.includes('memory')) return `${action}:oom`
    if (t.includes('cpu throttl'))                                        return `${action}:throttle`
    return `${action}:crash`
  }
  return `${action}:generic`
}

function appendLog(entry: AutonomousAction) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* non-critical */ }
}

/** Merge persisted cooldown from log into in-memory map (at most every 5 min) */
function hydrateCooldown() {
  const now = Date.now()
  if (now - cooldownHydratedAt < 5 * 60 * 1000) return
  for (const [k, ts] of buildPersistedCooldown(COOLDOWN_MS)) {
    const existing = actionCooldown.get(k) ?? 0
    if (ts > existing) actionCooldown.set(k, ts)
  }
  cooldownHydratedAt = now
}

async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  if (!K8S) return null
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), cache: 'no-store' })
    return r.ok ? r.json() : null
  } catch { return null }
}

async function k8sPatch(path: string, body: unknown) {
  const K8S = await resolveK8sUrl()
  if (!K8S) throw new Error('K8S_API_URL not configured')
  const r = await fetch(`${K8S}${path}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new Error(`K8s PATCH ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}

// Walk pod ? ReplicaSet ? Deployment to resolve the owning deployment name
async function resolveDeployment(podName: string, namespace: string): Promise<string | null> {
  try {
    const pod = await k8sGet(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`)
    if (pod) {
      const rs = pod.metadata?.ownerReferences?.find((o: any) => o.kind === 'ReplicaSet')
      if (rs) {
        const rsData = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets/${encodeURIComponent(rs.name)}`)
        const dep = rsData?.metadata?.ownerReferences?.find((o: any) => o.kind === 'Deployment')
        if (dep?.name) return dep.name
      }
    }
  } catch { /* fall through */ }
  // rawName may already be a deployment name ? verify
  const dep = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(podName)}`)
  return dep ? podName : null
}

async function restartDeployment(name: string, namespace: string) {
  await k8sPatch(
    `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
    { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } },
  )
}

/**
 * Delete the most problematic pod (highest restart count) owned by a deployment.
 * The deployment controller immediately recreates it ? equivalent to kubectl rollout restart
 * but at pod granularity, without touching the deployment spec.
 */
async function deletePod(deploymentName: string, namespace: string): Promise<string> {
  // Try common label selectors ? deployments use app=, app.kubernetes.io/name=, or name=
  let items: any[] = []
  for (const labelKey of ['app', 'app.kubernetes.io/name', 'name']) {
    const pods = await k8sGet(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(`${labelKey}=${deploymentName}`)}`,
    )
    items = pods?.items ?? []
    if (items.length > 0) break
  }
  if (items.length === 0) throw new Error(`No pods found for deployment "${deploymentName}" in "${namespace}"`)

  // Pick the pod with the highest restart count
  const target = items.reduce((worst, p) => {
    const restarts = (p.status?.containerStatuses ?? []).reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0)
    const worstRestarts = (worst.status?.containerStatuses ?? []).reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0)
    return restarts > worstRestarts ? p : worst
  }, items[0])

  const podName = target.metadata.name
  const K8S = await resolveK8sUrl()
  if (!K8S) throw new Error('K8S_API_URL not configured')
  const r = await fetch(
    `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`,
    { method: 'DELETE', signal: AbortSignal.timeout(10000) },
  )
  if (!r.ok) throw new Error(`K8s DELETE pod ${r.status}: ${await r.text().catch(() => '')}`)
  return podName
}

async function scaleDeployment(name: string, namespace: string, replicas: number) {
  await k8sPatch(
    `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}/scale`,
    { spec: { replicas } },
  )
}

/** Parse a target replica count from an insight's suggestedAction or evidence. */
function parseTargetReplicas(ins: any, currentReplicas: number): number {
  const src = [ins.suggestedAction ?? '', ...(ins.evidence ?? [])].join(' ')
  const m = src.match(/(?:scale(?:\s+to)?|replicas?[=:\s]+|--replicas[=\s]+)(\d+)/i)
  if (m) return Math.max(1, parseInt(m[1], 10))
  // No explicit count ? scale up by 2 (minimum meaningful increment)
  return Math.max(1, currentReplicas + 2)
}

async function slackNotify(text: string) {
  if (!SLACK) return
  try {
    await fetch(SLACK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
      signal:  AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
  } catch { /* non-critical */ }
}

// ?? Outcome verification ???????????????????????????????????????????????????????

async function checkDeploymentHealth(
  name: string, namespace: string,
): Promise<'resolved' | 'persisted' | 'unknown'> {
  const dep = await k8sGet(
    `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
  )
  if (!dep) return 'unknown'

  const desired = dep.spec?.replicas ?? 1
  const avail   = dep.status?.availableReplicas ?? 0
  const ready   = dep.status?.readyReplicas ?? 0

  if (avail < Math.ceil(desired * 0.8) || ready < 1) return 'persisted'

  try {
    let crashPods: any[] = []
    for (const labelKey of ['app', 'app.kubernetes.io/name', 'name']) {
      const pods = await k8sGet(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(`${labelKey}=${name}`)}`,
      )
      crashPods = pods?.items ?? []
      if (crashPods.length > 0) break
    }
    const crashLooping = crashPods.some((p: any) =>
      p.status?.containerStatuses?.some((c: any) =>
        c.state?.waiting?.reason === 'CrashLoopBackOff' || (c.restartCount ?? 0) > 5,
      ),
    )
    if (crashLooping) return 'persisted'
  } catch { /* ignore */ }

  return 'resolved'
}

/**
 * Runs at the start of each loop cycle.
 * Verifies 'ok' actions that are ?5 min and ?2 h old and haven't been checked yet.
 * Writes outcome entries that the learning engine reads on the next cycle.
 */
async function runPendingVerifications(): Promise<{ count: number; resolved: number; persisted: number }> {
  const now         = Date.now()
  const actions     = readActions()
  const outcomes    = readOutcomes()
  const verifiedIds = new Set(outcomes.map(o => o.actionId))

  const pending = actions.filter(a => {
    if (!a.id || a.result !== 'ok' || verifiedIds.has(a.id)) return false
    const age = now - new Date(a.ts).getTime()
    return age >= VERIFY_AFTER_MS && age <= VERIFY_BEFORE_MS
  })

  let resolved = 0, persisted = 0

  for (const a of pending) {
    let outcome: 'resolved' | 'persisted' | 'unknown' = 'unknown'
    if (a.action === 'restart_deployment' || a.action === 'scale_deployment') {
      outcome = await checkDeploymentHealth(a.target, a.namespace)
    }
    appendOutcome({ actionId: a.id, ts: new Date().toISOString(), outcome, detail: `${a.namespace}/${a.target}` })
    if (outcome === 'resolved')  resolved++
    if (outcome === 'persisted') persisted++
  }

  return { count: pending.length, resolved, persisted }
}

// ?? POST handler ???????????????????????????????????????????????????????????????

export async function POST(req: Request) {
  // Allow server-side cron calls authenticated via CRON_SECRET header
  const authHeader = req.headers.get('authorization') ?? ''
  const cronSecret = process.env.CRON_SECRET
  const isCronCall = !!(cronSecret && authHeader === `Bearer ${cronSecret}`)

  if (!isCronCall) {
    const deny = await assertOperator()
    if (deny) return deny
  }

  const cfg = readConfig()

  // Auto-escalation: runs every cycle, independent of the healing toggle
  let autoEscResult: any = null
  try {
    const aer = await fetch(`${BASE}/api/incidents/auto-escalate`, {
      method: 'POST',
      headers: { 'x-internal-secret': cronSecret ?? '' },
      signal: AbortSignal.timeout(15000),
    })
    if (aer.ok) autoEscResult = await aer.json()
  } catch { /* non-critical */ }

  // Auto-runbook trigger: runs every cycle, independent of the healing toggle
  let autoRunbookResult: any = null
  try {
    const arr = await fetch(`${BASE}/api/automation/auto-trigger`, {
      method: 'POST',
      headers: { 'x-internal-secret': cronSecret ?? '' },
      signal: AbortSignal.timeout(30000),
    })
    if (arr.ok) autoRunbookResult = await arr.json()
  } catch { /* non-critical */ }

  // L5: AI remediation plan generation
  let autoPlanResult: any = null
  try {
    const apr = await fetch(`${BASE}/api/autonomous/plan`, {
      method: 'POST',
      headers: { 'x-internal-secret': cronSecret ?? '' },
      signal: AbortSignal.timeout(30000),
    })
    if (apr.ok) autoPlanResult = await apr.json()
  } catch { /* non-critical */ }

  const enabled        = !!(cfg as any).autonomous_enabled
  const dryRun         = (cfg as any).autonomous_dry_run !== false
  const baseThreshold  = ((cfg as any).autonomous_confidence_threshold as number) ?? 80
  const allowedActions: string[] = (cfg as any).autonomous_allowed_actions ?? ['restart_deployment']

  if (!enabled) {
    return NextResponse.json({
      ok: true, skipped: true,
      reason: 'Autonomous healing is disabled.',
      autoEscalation: autoEscResult,
      ranAt: new Date().toISOString(),
    })
  }

  // 1. Hydrate cooldown from persisted log (restart-safe)
  hydrateCooldown()

  // 2. Verify outcomes from previous loop runs (feeds learning engine)
  const verification = await runPendingVerifications()

  // 3. Fetch live AI insights
  let insights: any[] = []
  try {
    const r = await fetch(`${BASE}/api/ai/insights`, {
      signal: AbortSignal.timeout(20000),
      cache:  'no-store',
    })
    if (r.ok) insights = (await r.json()).insights ?? []
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `Insights unavailable: ${e.message}` }, { status: 500 })
  }

  // ?? Process predictions ????????????????????????????????????????????????
  const actions: AutonomousAction[] = []
  const processed = new Set<string>()

  for (const ins of insights) {
    if (ins.kind !== 'prediction' && ins.kind !== 'rca') continue
    const confidence: number = ins.confidence ?? 0
    if (ins.severity !== 'critical' && ins.severity !== 'high') continue

    const titleLc = (ins.title ?? '').toLowerCase()
    let action: string | null = null
    if (titleLc.includes('restart') || titleLc.includes('crash') ||
        titleLc.includes('oom')     || titleLc.includes('kill')  ||
        titleLc.includes('memory pressure')) {
      action = 'restart_deployment'
    } else if (
      titleLc.includes('scale') || titleLc.includes('under-provision') ||
      titleLc.includes('replica') || titleLc.includes('traffic spike') ||
      (titleLc.includes('cpu throttl') && titleLc.includes('scale'))
    ) {
      action = 'scale_deployment'
    }
    if (!action || !allowedActions.includes(action)) continue

    // Derive pattern key and apply learning-adjusted threshold
    const patternKey      = derivePatternKey(action, ins.title ?? '')
    const effectiveThresh = getEffectiveThreshold(baseThreshold, patternKey)
    if (confidence < effectiveThresh) continue

    // Extract namespace + target name
    const evidenceNs = (ins.evidence ?? []).find((e: string) => e.startsWith('Namespace:'))
    const namespace  = evidenceNs?.split(':')[1]?.trim() ?? 'default'
    const titleMatch = ins.title?.match(/[:\-]\s*([\w.\-]+)$/)
    const rawName    = titleMatch?.[1]?.trim() ?? ''
    if (!rawName) continue

    const cooldownKey = `${action}:${namespace}/${rawName}`
    if (processed.has(cooldownKey)) continue
    processed.add(cooldownKey)

    // Per-workload cooldown
    const lastRun = actionCooldown.get(cooldownKey) ?? 0
    if (Date.now() - lastRun < COOLDOWN_MS) {
      actions.push({
        id: generateId(), ts: new Date().toISOString(),
        insightId: ins.id, insight: ins.title, action,
        target: rawName, namespace, confidence, dryRun,
        result: 'skipped_cooldown', patternKey,
      })
      continue
    }

    const entry: AutonomousAction = {
      id: generateId(), ts: new Date().toISOString(),
      insightId: ins.id, insight: ins.title, action,
      target: rawName, namespace, confidence, dryRun,
      result: 'dry_run', patternKey,
    }

    if (dryRun) {
      appendLog(entry)
      actions.push(entry)
      continue
    }

    // ?? Live execution ????????????????????????????????????????????????????
    try {
      const deployName = await resolveDeployment(rawName, namespace)
      if (!deployName) {
        entry.result = 'unresolvable'
        entry.error  = `Could not resolve deployment for "${rawName}" in namespace "${namespace}"`
      } else {
        entry.target = deployName
        if (action === 'restart_deployment') {
          await restartDeployment(deployName, namespace)
        } else if (action === 'delete_pod') {
          const deletedPod = await deletePod(deployName, namespace)
          entry.insight = `${entry.insight} (deleted pod: ${deletedPod})`
        } else if (action === 'scale_deployment') {
          const dep = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(deployName)}`)
          const currentReplicas: number = dep?.spec?.replicas ?? 1
          const targetReplicas = parseTargetReplicas(ins, currentReplicas)
          await scaleDeployment(deployName, namespace, targetReplicas)
          ;(entry as any).targetReplicas = targetReplicas
          entry.insight = `${entry.insight} (${currentReplicas}?${targetReplicas} replicas)`
        }
        actionCooldown.set(cooldownKey, Date.now())
        entry.result = 'ok'
        await slackNotify(
          `?? *VynOps Auto-Heal*\n` +
          `? Action: \`${action}\`\n` +
          `? Target: \`${namespace}/${deployName}\`\n` +
          `? Confidence: ${confidence}% (threshold: ${effectiveThresh}%)\n` +
          `? Trigger: ${ins.title}\n` +
          `? Pattern: \`${patternKey}\``,
        )
        appendAuditLog({
          ts:     new Date().toISOString(),
          user:   'autonomous-agent',
          action: `autonomous.${action}`,
          detail: `${namespace}/${deployName} (conf ${confidence}%, eff-threshold ${effectiveThresh}%, pattern ${patternKey})`,
        })
      }
    } catch (e: any) {
      entry.result = 'failed'
      entry.error  = e.message
    }

    appendLog(entry)
    actions.push(entry)
  }

  return NextResponse.json({
    ok:                 true,
    dryRun,
    enabled,
    insightsAnalyzed:   insights.length,
    predictionsMatched: actions.length,
    actionsOk:          actions.filter(a => a.result === 'ok').length,
    actionsDryRun:      actions.filter(a => a.result === 'dry_run').length,
    actionsCooldown:    actions.filter(a => a.result === 'skipped_cooldown').length,
    actionsFailed:      actions.filter(a => a.result === 'failed' || a.result === 'unresolvable').length,
    verificationsRun:   verification.count,
    verificationResult: verification,
    autoEscalation:     autoEscResult,
    autoRunbooks:       autoRunbookResult,
    autoPlans:          autoPlanResult,
    actions,
    ranAt: new Date().toISOString(),
  })
}
