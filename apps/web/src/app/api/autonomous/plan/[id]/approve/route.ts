/**
 * POST /api/autonomous/plan/[id]/approve   ? approve and execute a plan
 * DELETE /api/autonomous/plan/[id]/approve ? dismiss a plan
 * GET    /api/autonomous/plan              ? list all plans (handled by parent route)
 */
import { NextRequest, NextResponse }                     from 'next/server'
import { readPlans, updatePlan, ACTION_VOCAB, INTERNAL_PLAN_SECRET } from '@/app/api/autonomous/plan/shared'
import type { RemediationPlan }                          from '@/app/api/autonomous/plan/shared'
import { resolveK8sUrl, K8S_TIMEOUT_MS }                from '@/lib/cluster'
import { appendAuditLog }                                from '@/app/api/settings/config/shared'
import { auth }                                          from '@/lib/auth'
import { assertOperator }                                from '@/lib/rbac'

const SLACK = process.env.SLACK_WEBHOOK_URL ?? ''

async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  if (!K8S) return null
  const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
  return r.ok ? r.json() : null
}

async function k8sPatch(path: string, body: unknown) {
  const K8S = await resolveK8sUrl()
  if (!K8S) throw new Error('K8S_API_URL not configured')
  const r = await fetch(`${K8S}${path}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(K8S_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`K8s PATCH ${r.status}: ${(await r.text().catch(() => '')).slice(0, 120)}`)
  return r.json()
}

async function executeStep(
  step: RemediationPlan['steps'][number],
  namespace: string,
): Promise<{ ok: boolean; output: string }> {
  const ns     = step.namespace || namespace
  const target = step.target ?? ''

  try {
    switch (step.action) {
      case 'check_pod_status': {
        const pods = await k8sGet(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods`)
        const summary = (pods?.items ?? []).slice(0, 5).map((p: any) => {
          const cs = (p.status?.containerStatuses ?? [])[0]
          return `${p.metadata.name}: restarts=${cs?.restartCount ?? 0} state=${cs?.state?.waiting?.reason ?? 'Running'}`
        }).join('\n') || 'No pods found'
        return { ok: true, output: summary }
      }

      case 'check_pod_logs': {
        if (!target) return { ok: false, output: 'No target specified' }
        const K8S = await resolveK8sUrl()
        if (!K8S) return { ok: false, output: 'K8s unavailable' }
        const r = await fetch(
          `${K8S}/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(target)}/log?tailLines=30`,
          { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) }
        )
        const logs = r.ok ? (await r.text()).slice(0, 800) : '(unavailable)'
        return { ok: true, output: logs || '(empty)' }
      }

      case 'check_rollout_history': {
        if (!target) return { ok: false, output: 'No deployment target' }
        const dep = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}`)
        if (!dep) return { ok: false, output: `Deployment ${target} not found` }
        return { ok: true, output: `${target}: replicas=${dep.spec?.replicas} available=${dep.status?.availableReplicas ?? 0} revision=${dep.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '?'}` }
      }

      case 'check_events': {
        const events = await k8sGet(`/api/v1/namespaces/${encodeURIComponent(ns)}/events?limit=10`)
        const evts = (events?.items ?? [])
          .filter((e: any) => e.type !== 'Normal')
          .slice(0, 5)
          .map((e: any) => `[${e.reason}] ${e.involvedObject?.name}: ${e.message?.slice(0, 80)}`)
          .join('\n') || 'No warning events'
        return { ok: true, output: evts }
      }

      case 'check_resource_usage': {
        if (!target) return { ok: false, output: 'No deployment target' }
        const dep = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}`)
        if (!dep) return { ok: false, output: `Deployment ${target} not found` }
        const c = dep.spec?.template?.spec?.containers?.[0]
        const limits   = c?.resources?.limits   ?? {}
        const requests = c?.resources?.requests ?? {}
        return { ok: true, output: `${target}: limits={cpu:${limits.cpu ?? '?'}, mem:${limits.memory ?? '?'}} requests={cpu:${requests.cpu ?? '?'}, mem:${requests.memory ?? '?'}}` }
      }

      case 'restart_deployment': {
        if (!target) return { ok: false, output: 'No deployment target' }
        await k8sPatch(
          `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}`,
          { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } }
        )
        return { ok: true, output: `Rollout restart triggered on ${ns}/${target}` }
      }

      case 'rollback_deployment': {
        if (!target) return { ok: false, output: 'No deployment target' }
        const dep = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}`)
        if (!dep) return { ok: false, output: `Deployment ${target} not found` }
        const curRevision = parseInt(dep.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '1', 10)
        if (curRevision <= 1) {
          return { ok: false, output: `${target} is at revision 1 ? no previous revision to roll back to` }
        }
        // Find the ReplicaSet owned by this deployment at revision N-1
        const rsList = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/replicasets`)
        const prevRevision = curRevision - 1
        const prevRS = (rsList?.items ?? []).find((rs: any) =>
          rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] === String(prevRevision) &&
          (rs.metadata?.ownerReferences ?? []).some((o: any) => o.kind === 'Deployment' && o.name === target)
        )
        if (!prevRS) {
          return { ok: false, output: `Previous revision (${prevRevision}) ReplicaSet not found for ${target}` }
        }
        const prevTemplate = prevRS.spec?.template
        if (!prevTemplate) return { ok: false, output: 'Previous ReplicaSet has no pod template' }
        await k8sPatch(
          `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}`,
          { spec: { template: prevTemplate } }
        )
        const prevImage = prevTemplate.spec?.containers?.[0]?.image ?? '?'
        return { ok: true, output: `Rolled back ${ns}/${target}: revision ${curRevision} ? ${prevRevision} (image: ${prevImage})` }
      }

      case 'scale_deployment': {
        if (!target) return { ok: false, output: 'No deployment target' }
        const dep = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}`)
        const cur = dep?.spec?.replicas ?? 1
        const next = step.replicas ?? (cur + 1)
        await k8sPatch(
          `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}/scale`,
          { spec: { replicas: next } }
        )
        return { ok: true, output: `Scaled ${ns}/${target}: ${cur} ? ${next} replicas` }
      }

      case 'patch_memory_limit': {
        if (!target) return { ok: false, output: 'No deployment target' }
        const dep = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}`)
        if (!dep) return { ok: false, output: `Deployment ${target} not found` }
        const cur = dep.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? '256Mi'
        const curMi = parseInt(cur) || 256
        const next  = `${curMi + 256}Mi`
        await k8sPatch(
          `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}`,
          { spec: { template: { spec: { containers: [{ name: dep.spec?.template?.spec?.containers?.[0]?.name, resources: { limits: { memory: next } } }] } } } }
        )
        return { ok: true, output: `Memory limit patched ${ns}/${target}: ${cur} ? ${next}` }
      }

      case 'delete_crashed_pod': {
        const pods = await k8sGet(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods`)
        const crashed = (pods?.items ?? []).find((p: any) =>
          (p.status?.containerStatuses ?? []).some((c: any) => c.state?.waiting?.reason === 'CrashLoopBackOff')
        )
        if (!crashed) return { ok: true, output: 'No CrashLoopBackOff pods found' }
        const K8S = await resolveK8sUrl()
        if (!K8S) return { ok: false, output: 'K8s unavailable' }
        const podName = crashed.metadata.name
        await fetch(`${K8S}/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(podName)}`,
          { method: 'DELETE', signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
        return { ok: true, output: `Deleted crashed pod ${ns}/${podName}` }
      }

      case 'verify_health': {
        if (!target) return { ok: false, output: 'No deployment target' }
        const dep = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(target)}`)
        if (!dep) return { ok: false, output: `Deployment ${target} not found` }
        const desired   = dep.spec?.replicas ?? 1
        const available = dep.status?.availableReplicas ?? 0
        const ready     = dep.status?.readyReplicas ?? 0
        const healthy   = available >= Math.ceil(desired * 0.8) && ready >= 1
        return { ok: healthy, output: `${target}: desired=${desired} available=${available} ready=${ready} ? ${healthy ? 'HEALTHY' : 'DEGRADED'}` }
      }

      default:
        return { ok: false, output: `Unknown action: ${step.action}` }
    }
  } catch (e: any) {
    return { ok: false, output: `Error: ${e.message?.slice(0, 200) ?? 'unknown'}` }
  }
}

async function slackPlanResult(plan: RemediationPlan, results: { step: string; ok: boolean; output: string }[]) {
  if (!SLACK) return
  const passed  = results.filter(r => r.ok).length
  const emoji   = passed === results.length ? '?' : passed > 0 ? '??' : '?'
  try {
    await fetch(SLACK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: `${emoji} AI Plan Executed ? ${plan.incidentTitle}` } },
          { type: 'section', text: { type: 'mrkdwn', text: `*Reasoning:* ${plan.reasoning}\n*Confidence:* ${plan.confidence}%  |  *Steps:* ${results.length}  |  *Passed:* ${passed}/${results.length}` } },
          ...results.map(r => ({
            type: 'section',
            text: { type: 'mrkdwn', text: `${r.ok ? '?' : '?'} \`${r.step}\` ? ${r.output.slice(0, 100)}` },
          })).slice(0, 4),
        ],
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch { /* non-critical */ }
}

// ?? POST ? approve + execute ??????????????????????????????????????????????????
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  let body: any = {}
  try { body = await req.json() } catch {}

  const isAutoApprove = body?.auto === true &&
    req.headers.get('x-internal-secret') === INTERNAL_PLAN_SECRET
  let session: any = null
  if (!isAutoApprove) {
    const deny = await assertOperator()
    if (deny) return deny
    session = await auth()
  }

  const plans = readPlans()
  const plan  = plans.find(p => p.id === id)
  if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
  if (plan.status === 'dismissed') return NextResponse.json({ error: 'Plan was dismissed' }, { status: 400 })
  if (plan.status === 'executing' || plan.status === 'done') {
    return NextResponse.json({ error: `Plan already ${plan.status}` }, { status: 400 })
  }

  const approvedBy = isAutoApprove ? 'system' : ((session?.user as any)?.email ?? 'operator')
  const nowIso     = new Date().toISOString()

  updatePlan(id, { status: 'executing', approvedBy, executedAt: nowIso })

  // Execute steps sequentially
  const results: { step: string; ok: boolean; output: string }[] = []
  let allOk = true

  for (const step of plan.steps) {
    const r = await executeStep(step, plan.namespace)
    results.push({ step: step.action, ok: r.ok, output: r.output })
    if (!r.ok && ACTION_VOCAB[step.action]?.risk !== 'low') {
      allOk = false
      break  // stop on remediation failure, continue through read failures
    }
  }

  const finalStatus: RemediationPlan['status'] = allOk ? 'done' : 'failed'
  updatePlan(id, { status: finalStatus, results })

  appendAuditLog({
    ts:     nowIso,
    user:   approvedBy,
    action: `autonomous.plan.${finalStatus}`,
    detail: `Plan ${id} for ${plan.incidentId}: ${plan.steps.length} steps, ${results.filter(r => r.ok).length} passed`,
  })

  // Notify Slack
  await slackPlanResult({ ...plan, status: finalStatus, results }, results)

  return NextResponse.json({ ok: true, status: finalStatus, results })
}

// ?? DELETE ? dismiss ??????????????????????????????????????????????????????????
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const deny = await assertOperator()
  if (deny) return deny

  const { id } = await context.params

  const plans = readPlans()
  const plan  = plans.find(p => p.id === id)
  if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })

  updatePlan(id, { status: 'dismissed' })
  return NextResponse.json({ ok: true })
}
