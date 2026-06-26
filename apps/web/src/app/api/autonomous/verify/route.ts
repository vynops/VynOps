import { NextResponse }  from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { readActions, readOutcomes, appendOutcome } from '@/lib/autonomousLearning'
import { resolveK8sUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

const VERIFY_AFTER_MS  =  5 * 60 * 1000
const VERIFY_BEFORE_MS =  2 * 60 * 60 * 1000

async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  if (!K8S) return null
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), cache: 'no-store' })
    return r.ok ? r.json() : null
  } catch { return null }
}

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
    const pods = await k8sGet(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=app%3D${encodeURIComponent(name)}`,
    )
    const crashLooping = (pods?.items ?? []).some((p: any) =>
      p.status?.containerStatuses?.some((c: any) =>
        c.state?.waiting?.reason === 'CrashLoopBackOff' || (c.restartCount ?? 0) > 5,
      ),
    )
    if (crashLooping) return 'persisted'
  } catch { /* ignore */ }

  return 'resolved'
}

/**
 * POST /api/autonomous/verify
 * Manually trigger outcome verification for all pending healed actions.
 * Used by the UI "Verify Now" button — the loop also runs this automatically.
 */
export async function POST() {
  const deny = await assertOperator()
  if (deny) return deny

  const now         = Date.now()
  const actions     = readActions()
  const outcomes    = readOutcomes()
  const verifiedIds = new Set(outcomes.map(o => o.actionId))

  const pending = actions.filter(a => {
    if (!a.id || a.result !== 'ok' || verifiedIds.has(a.id)) return false
    const age = now - new Date(a.ts).getTime()
    return age >= VERIFY_AFTER_MS && age <= VERIFY_BEFORE_MS
  })

  const results: Array<{ actionId: string; target: string; outcome: string }> = []

  for (const a of pending) {
    let outcome: 'resolved' | 'persisted' | 'unknown' = 'unknown'
    if (a.action === 'restart_deployment') {
      outcome = await checkDeploymentHealth(a.target, a.namespace)
    }
    appendOutcome({ actionId: a.id, ts: new Date().toISOString(), outcome, detail: `${a.namespace}/${a.target}` })
    results.push({ actionId: a.id, target: `${a.namespace}/${a.target}`, outcome })
  }

  return NextResponse.json({
    ok:       true,
    verified: results.length,
    results,
    checkedAt: new Date().toISOString(),
  })
}