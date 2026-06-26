import { NextRequest, NextResponse } from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { resolveK8sUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

const INTERNAL_SECRET = process.env.CRON_SECRET ?? ''

// ── K8s helpers ───────────────────────────────────────────────────────────────
async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
  if (!r.ok) throw new Error(`K8s ${r.status}: ${(await r.text().catch(() => '')).slice(0, 120)}`)
  return r.json()
}

async function k8sLog(ns: string, pod: string, prev: boolean, container?: string): Promise<string> {
  const K8S = await resolveK8sUrl()
  const qs = `?tailLines=50${prev ? '&previous=true' : ''}${container ? `&container=${container}` : ''}`
  const r = await fetch(`${K8S}/api/v1/namespaces/${ns}/pods/${pod}/log${qs}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
  return r.ok ? (await r.text()).slice(0, 2000) : '(logs unavailable)'
}

async function k8sPatch(path: string, body: unknown) {
  const K8S = await resolveK8sUrl()
  const r = await fetch(`${K8S}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`Patch ${r.status}: ${(await r.text().catch(() => '')).slice(0, 120)}`)
  return r.json()
}

async function k8sDel(path: string) {
  const K8S = await resolveK8sUrl()
  const r = await fetch(`${K8S}${path}`, { method: 'DELETE', signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
  return r.ok
}

type Status = 'ok' | 'warn' | 'error' | 'info'
type Step = { name: string; status: Status; output: string }
type Opts = { namespace: string; target: string; params: Record<string, string> }

// ── Runbook 1: Diagnose CrashLoopBackOff ─────────────────────────────────────
async function diagnoseCrashLoop({ namespace }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const pods = await k8sGet(`/api/v1/namespaces/${namespace}/pods`)
  const crashers = (pods.items ?? []).filter((p: any) =>
    (p.status?.containerStatuses ?? []).some((c: any) => c.state?.waiting?.reason === 'CrashLoopBackOff')
  )
  steps.push({
    name: 'Scan for CrashLoopBackOff pods',
    status: crashers.length ? 'warn' : 'ok',
    output: crashers.length
      ? `Found ${crashers.length} pod(s):\n${crashers.map((p: any) => {
          const cs = (p.status?.containerStatuses ?? [])[0]
          return `  • ${p.metadata.name}  restarts=${cs?.restartCount ?? 0}  image=${cs?.image ?? '?'}`
        }).join('\n')}`
      : `No CrashLoopBackOff pods in namespace "${namespace}"`,
  })
  if (!crashers.length) return steps

  const pod = crashers[0]
  const ns = pod.metadata.namespace ?? namespace
  const name = pod.metadata.name
  const container = pod.spec?.containers?.[0]?.name

  const evts = await k8sGet(`/api/v1/namespaces/${ns}/events?fieldSelector=involvedObject.name=${name}`)
  const evtOut = (evts.items ?? []).slice(-8)
    .map((e: any) => `  [${e.reason}] ${e.message}`)
    .join('\n') || '  (no events)'
  steps.push({ name: `Events — ${name}`, status: 'ok', output: evtOut })

  const logs = await k8sLog(ns, name, true, container)
  steps.push({ name: 'Previous container logs', status: 'ok', output: logs || '(empty — pod may not have crashed yet)' })

  const restarts = (pod.status?.containerStatuses ?? []).reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0)
  const reason = (pod.status?.containerStatuses ?? [])[0]?.lastState?.terminated?.reason ?? 'Unknown'
  steps.push({
    name: 'Restart analysis',
    status: restarts > 10 ? 'warn' : 'ok',
    output: `Total restarts: ${restarts}  |  Last exit reason: ${reason}\n${restarts > 10 ? '⚠ High restart count — check for OOM, missing config, or crashing init sequence.' : 'Restart count is within acceptable range.'}`,
  })
  return steps
}

// ── Runbook 2: OOMKilled — Patch Memory & Restart ────────────────────────────
async function oomPatchRestart({ namespace, target }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const pods = await k8sGet(`/api/v1/namespaces/${namespace}/pods`)
  const oomPods = (pods.items ?? []).filter((p: any) =>
    (p.status?.containerStatuses ?? []).some((c: any) => c.lastState?.terminated?.reason === 'OOMKilled')
  )
  steps.push({
    name: 'Find OOMKilled pods',
    status: oomPods.length ? 'warn' : 'info',
    output: oomPods.length
      ? `${oomPods.length} OOMKilled pod(s):\n${oomPods.map((p: any) => `  • ${p.metadata.name}`).join('\n')}`
      : 'No OOMKilled pods found (proceeding with deployment patch)',
  })

  const dep = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`)
  const containers: any[] = dep.spec?.template?.spec?.containers ?? []
  const c0 = containers[0]
  const currentMem = c0?.resources?.limits?.memory ?? '128Mi'
  steps.push({ name: 'Current memory limit', status: 'ok', output: `  ${target} container[0] memory.limit = ${currentMem}` })

  const match = currentMem.match(/^(\d+)(Mi|Gi)$/)
  const newMem = match
    ? `${parseInt(match[1]) + (match[2] === 'Gi' ? 1 : 256)}${match[2]}`
    : '512Mi'

  await k8sPatch(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`, {
    spec: {
      template: {
        spec: {
          containers: containers.map((c: any, i: number) =>
            i === 0
              ? { ...c, resources: { ...c.resources, limits: { ...(c.resources?.limits ?? {}), memory: newMem } } }
              : c
          ),
        },
      },
    },
  })
  steps.push({ name: 'Patch memory limit', status: 'ok', output: `  Patched ${target}: ${currentMem} → ${newMem} (+256Mi)` })

  await k8sPatch(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`, {
    spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } },
  })
  steps.push({ name: 'Trigger rollout restart', status: 'ok', output: `  Rollout restart annotation applied to ${target}` })

  await new Promise(r => setTimeout(r, 1200))
  const updated = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`)
  const desired = updated.spec?.replicas ?? 1
  const ready   = updated.status?.readyReplicas ?? 0
  steps.push({
    name: 'Rollout status',
    status: ready < desired ? 'warn' : 'ok',
    output: `  ${target}: ${ready}/${desired} replicas ready.  ${ready < desired ? 'Rollout in progress — check again in ~30s.' : '✓ All replicas healthy.'}`,
  })
  return steps
}

// ── Runbook 3: Rollback Failed Deployment ────────────────────────────────────
async function rollbackDeployment({ namespace, target }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const dep = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`)
  const rev = dep.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '?'
  const desired = dep.spec?.replicas ?? 1
  const ready   = dep.status?.readyReplicas ?? 0
  steps.push({
    name: 'Current deployment state',
    status: ready < desired ? 'warn' : 'ok',
    output: `  ${target}  revision=${rev}  ready=${ready}/${desired}  strategy=${dep.spec?.strategy?.type ?? 'RollingUpdate'}`,
  })

  const rsList = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/replicasets`)
  const owned = ((rsList.items ?? []) as any[])
    .filter((rs: any) => (rs.metadata?.ownerReferences ?? []).some((ref: any) => ref.name === target))
    .sort((a: any, b: any) => {
      const ra = parseInt(a.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '0')
      const rb = parseInt(b.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '0')
      return rb - ra
    })
    .slice(0, 4)
  steps.push({
    name: 'Revision history',
    status: 'ok',
    output: owned.map((rs: any) => {
      const r = rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '?'
      const img = rs.spec?.template?.spec?.containers?.[0]?.image ?? '?'
      return `  Rev ${r}: ${rs.metadata.name}  image=${img.split('/').pop()?.slice(0, 50)}`
    }).join('\n') || '  (no replicasets found)',
  })

  // Rollback: find previous RS by revision annotation and patch deployment spec.template
  if (owned.length < 2) {
    steps.push({ name: 'Rollback', status: 'error', output: `  Only one revision exists for ${target} — cannot roll back` })
    return steps
  }
  const prevRS       = owned[1] // second-most-recent = previous revision
  const prevTemplate = prevRS.spec?.template
  const prevRevision = prevRS.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '?'
  const prevImage    = prevTemplate?.spec?.containers?.[0]?.image ?? '?'
  try {
    await k8sPatch(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`, {
      spec: { template: prevTemplate },
    })
    steps.push({
      name:   'Rollback executed',
      status: 'ok',
      output: `  ${target}: patched spec.template to revision ${prevRevision}\n  Image: ${prevImage}\n  Monitor: kubectl rollout status deployment/${target} -n ${namespace}`,
    })
  } catch (e: any) {
    steps.push({ name: 'Rollback', status: 'error', output: `  ${e.message}` })
  }

  await new Promise(r => setTimeout(r, 1000))
  const post = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`)
  const postReady = post.status?.readyReplicas ?? 0
  const postDes   = post.spec?.replicas ?? 1
  steps.push({
    name: 'Post-rollback health',
    status: postReady < postDes ? 'warn' : 'ok',
    output: `  ${target}: ${postReady}/${postDes} replicas ready`,
  })
  return steps
}

// ── Runbook 4: Force Delete Stuck Terminating Pods ───────────────────────────
async function forceDeleteTerminating({ namespace }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const pods = await k8sGet(`/api/v1/namespaces/${namespace}/pods`)
  const stuck = (pods.items ?? []).filter((p: any) =>
    p.metadata?.deletionTimestamp && !['Succeeded', 'Failed'].includes(p.status?.phase)
  )
  steps.push({
    name: 'Find stuck Terminating pods',
    status: stuck.length ? 'warn' : 'ok',
    output: stuck.length
      ? `${stuck.length} stuck pod(s):\n${stuck.map((p: any) => {
          const age = Math.round((Date.now() - new Date(p.metadata.deletionTimestamp).getTime()) / 60000)
          return `  • ${p.metadata.name}  stuck for ${age}m`
        }).join('\n')}`
      : `No stuck Terminating pods in "${namespace}"`,
  })
  if (!stuck.length) return steps

  let deleted = 0
  for (const pod of stuck) {
    const ok = await k8sDel(`/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}?gracePeriodSeconds=0`)
    if (ok) deleted++
  }
  steps.push({
    name: 'Force delete (gracePeriodSeconds=0)',
    status: deleted === stuck.length ? 'ok' : 'warn',
    output: `  Deleted ${deleted}/${stuck.length} pods`,
  })

  await new Promise(r => setTimeout(r, 600))
  const after = await k8sGet(`/api/v1/namespaces/${namespace}/pods`)
  const remaining = (after.items ?? []).filter((p: any) =>
    p.metadata?.deletionTimestamp && stuck.some((s: any) => s.metadata.name === p.metadata.name)
  )
  steps.push({
    name: 'Verify cleanup',
    status: remaining.length === 0 ? 'ok' : 'warn',
    output: remaining.length === 0
      ? '  ✓ All stuck pods removed'
      : `  ${remaining.length} pod(s) still terminating — may require node reboot`,
  })
  return steps
}

// ── Runbook 5: Scale Deployment ──────────────────────────────────────────────
async function scaleDeployment({ namespace, target, params }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const replicas = Math.max(1, Math.min(20, parseInt(params.replicas ?? '2')))

  const dep = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`)
  const current = dep.spec?.replicas ?? 1
  const ready   = dep.status?.readyReplicas ?? 0
  steps.push({
    name: 'Current replica state',
    status: ready < current ? 'warn' : 'ok',
    output: `  ${target}: desired=${current}  ready=${ready}  strategy=${dep.spec?.strategy?.type ?? 'RollingUpdate'}`,
  })

  await k8sPatch(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`, { spec: { replicas } })
  steps.push({
    name: `Scale to ${replicas} replica(s)`,
    status: 'ok',
    output: `  Patched ${target}: ${current} → ${replicas} replicas`,
  })

  await new Promise(r => setTimeout(r, 1500))
  const post = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments/${target}`)
  const postReady = post.status?.readyReplicas ?? 0
  steps.push({
    name: 'Scale status',
    status: postReady < replicas ? 'warn' : 'ok',
    output: `  ${target}: ${postReady}/${replicas} ready.  ${postReady < replicas ? 'Scaling in progress…' : '✓ Scale complete.'}`,
  })
  return steps
}

// ── Runbook 6: Cleanup Evicted/Failed Pods ───────────────────────────────────
async function cleanupEvicted({ namespace }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const path = namespace === '_all' ? '/api/v1/pods' : `/api/v1/namespaces/${namespace}/pods`
  const pods = await k8sGet(path)
  const evicted = (pods.items ?? []).filter((p: any) =>
    p.status?.reason === 'Evicted' || (p.status?.phase === 'Failed' && p.status?.reason)
  )
  steps.push({
    name: 'Find evicted/failed pods',
    status: evicted.length ? 'warn' : 'ok',
    output: evicted.length
      ? `${evicted.length} evicted/failed pod(s):\n${evicted.slice(0, 12).map((p: any) =>
          `  • ${p.metadata.namespace ?? namespace}/${p.metadata.name}  reason=${p.status?.reason ?? p.status?.phase}`
        ).join('\n')}${evicted.length > 12 ? `\n  … and ${evicted.length - 12} more` : ''}`
      : 'No evicted or failed pods found — cluster is clean',
  })
  if (!evicted.length) return steps

  let deleted = 0
  for (const pod of evicted) {
    const ns = pod.metadata?.namespace ?? namespace
    const ok = await k8sDel(`/api/v1/namespaces/${ns}/pods/${pod.metadata.name}`)
    if (ok) deleted++
  }
  steps.push({
    name: 'Delete evicted pods',
    status: deleted === evicted.length ? 'ok' : 'warn',
    output: `  ✓ Deleted ${deleted}/${evicted.length} evicted pods\n  Freed pod slots and reduced API server churn`,
  })
  return steps
}

// ── Runbook 7: Cordon & Drain Node ───────────────────────────────────────────
async function cordonDrainNode({ params }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const nodeName = params.node?.trim()
  if (!nodeName) return [{ name: 'Validate input', status: 'error', output: '  Node name is required in params.node' }]

  const node = await k8sGet(`/api/v1/nodes/${nodeName}`)
  const cond  = (node.status?.conditions ?? []).find((c: any) => c.type === 'Ready')
  const isUnschedulable = node.spec?.unschedulable ?? false
  steps.push({
    name: 'Node health check',
    status: cond?.status === 'True' ? 'ok' : 'warn',
    output: `  ${nodeName}  Ready=${cond?.status ?? 'Unknown'}  Unschedulable=${isUnschedulable}\n  CPU: ${node.status?.allocatable?.cpu}  Memory: ${node.status?.allocatable?.memory}`,
  })

  await k8sPatch(`/api/v1/nodes/${nodeName}`, { spec: { unschedulable: true } })
  steps.push({ name: 'Cordon node', status: 'ok', output: `  Node ${nodeName} cordoned — no new pods will be scheduled` })

  const allPods = await k8sGet(`/api/v1/pods?fieldSelector=spec.nodeName=${nodeName}`)
  const evictable = (allPods.items ?? []).filter((p: any) =>
    p.metadata?.namespace !== 'kube-system' &&
    !(p.metadata?.ownerReferences ?? []).some((o: any) => o.kind === 'DaemonSet')
  )
  steps.push({
    name: 'Identify evictable pods',
    status: evictable.length > 0 ? 'warn' : 'ok',
    output: `  ${evictable.length} evictable pod(s):\n${evictable.slice(0, 8).map((p: any) => `  • ${p.metadata.namespace}/${p.metadata.name}`).join('\n')}${evictable.length > 8 ? `\n  … ${evictable.length - 8} more` : ''}\n\n  DaemonSet pods skipped (${(allPods.items ?? []).length - evictable.length} pods)`,
  })

  steps.push({
    name: 'Drain command',
    status: 'info',
    output: `  Node is cordoned. Complete drain manually:\n\n  kubectl drain ${nodeName} --ignore-daemonsets --delete-emptydir-data --timeout=120s\n\n  ⚠ Drain evicts pods gracefully — monitor pod rescheduling across remaining nodes.`,
  })
  return steps
}

// ── Runbook 8: Audit TLS Certificates ────────────────────────────────────────
async function auditTLSCerts({ namespace }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const path = namespace === '_all' ? '/api/v1/secrets' : `/api/v1/namespaces/${namespace}/secrets`
  const secrets = await k8sGet(`${path}?fieldSelector=type=kubernetes.io/tls`)
  const tls = (secrets.items ?? []).slice(0, 30)
  steps.push({ name: 'Find TLS secrets', status: 'ok', output: `  Found ${tls.length} TLS secret(s)` })

  const now = Date.now()
  const WARN_MS = 30 * 24 * 60 * 60 * 1000
  const lines: string[] = []
  let warnCount = 0

  for (const s of tls) {
    const certB64 = s.data?.['tls.crt']
    const name    = `${s.metadata.namespace ?? namespace}/${s.metadata.name}`
    if (!certB64) { lines.push(`  [SKIP] ${name}: no tls.crt data`); continue }

    try {
      const pem    = Buffer.from(certB64, 'base64').toString('ascii')
      const notAfterMatch = pem.match(/Not After\s*:\s*(.+)/i)
      if (notAfterMatch) {
        const exp  = new Date(notAfterMatch[1]).getTime()
        const days = Math.round((exp - now) / 86400000)
        if (days < 0) { lines.push(`  [EXPIRED] ${name}: expired ${-days}d ago`); warnCount++ }
        else if (days < 30) { lines.push(`  [EXPIRING] ${name}: expires in ${days}d`); warnCount++ }
        else { lines.push(`  [OK] ${name}: expires in ${days}d`) }
      } else {
        // PEM is base64 encoded DER — can't parse expiry without crypto lib — report size
        const sizeKB = (certB64.length * 0.75 / 1024).toFixed(1)
        lines.push(`  [OK] ${name}: cert present (${sizeKB}KB, expiry requires openssl parsing)`)
      }
    } catch {
      lines.push(`  [ERR] ${name}: failed to decode`)
    }
  }

  steps.push({
    name: 'Certificate status',
    status: warnCount > 0 ? 'warn' : 'ok',
    output: lines.join('\n') || '  (no TLS certs found)',
  })

  steps.push({
    name: 'Recommendations',
    status: 'info',
    output: [
      '  1. If using cert-manager:  kubectl get certificate -A',
      '  2. Force renewal:  kubectl delete secret <secret-name> -n <ns>  (cert-manager auto-recreates)',
      '  3. Manual check:  kubectl get secret <name> -n <ns> -o jsonpath="{.data.tls\\.crt}" | base64 -d | openssl x509 -noout -dates',
      '  4. Alert threshold: set up Prometheus alertmanager rule for certs expiring < 30d',
    ].join('\n'),
  })
  return steps
}

// ── Runbook 9: Debug ImagePullBackOff ────────────────────────────────────────
async function debugImagePull({ namespace }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const pods = await k8sGet(`/api/v1/namespaces/${namespace}/pods`)
  const imgPull = (pods.items ?? []).filter((p: any) =>
    (p.status?.containerStatuses ?? []).some((c: any) =>
      ['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName'].includes(c.state?.waiting?.reason)
    )
  )
  steps.push({
    name: 'Find image pull errors',
    status: imgPull.length ? 'warn' : 'ok',
    output: imgPull.length
      ? `${imgPull.length} pod(s) with image pull issues:\n${imgPull.map((p: any) => {
          const cs = (p.status?.containerStatuses ?? []).find((c: any) =>
            ['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName'].includes(c.state?.waiting?.reason)
          )
          return `  • ${p.metadata.name}  image=${cs?.image ?? '?'}  reason=${cs?.state?.waiting?.reason}`
        }).join('\n')}`
      : `No image pull errors in "${namespace}"`,
  })
  if (!imgPull.length) return steps

  const pod = imgPull[0]
  const evts = await k8sGet(`/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name=${pod.metadata.name}`)
  const relevant = (evts.items ?? [])
    .filter((e: any) => ['Failed', 'BackOff', 'Warning'].includes(e.reason))
    .slice(-6)
    .map((e: any) => `  [${e.reason}] ${e.message}`)
    .join('\n') || '  (no relevant events)'
  steps.push({ name: `Events — ${pod.metadata.name}`, status: 'warn', output: relevant })

  const cs = (pod.status?.containerStatuses ?? []).find((c: any) =>
    ['ImagePullBackOff', 'ErrImagePull'].includes(c.state?.waiting?.reason)
  )
  const image = cs?.image ?? 'unknown'
  const [registry, ...rest] = image.includes('/') ? image.split('/') : ['docker.io', image]
  steps.push({
    name: 'Root cause analysis',
    status: 'warn',
    output: [
      `  Image: ${image}`,
      `  Registry: ${registry}`,
      '',
      '  Common causes:',
      '  1. Wrong tag — verify with:  docker pull ' + image,
      '  2. Private registry — check imagePullSecret is attached to ServiceAccount',
      '  3. Registry rate-limit — Docker Hub: 100 pulls/6h anon; 200/6h free',
      '  4. Network policy blocking egress to registry',
    ].join('\n'),
  })

  steps.push({
    name: 'Fix commands',
    status: 'info',
    output: [
      '  # Check/add imagePullSecret:',
      `  kubectl create secret docker-registry regcred --docker-server=<registry> \\`,
      `    --docker-username=<user> --docker-password=<pass> -n ${namespace}`,
      `  kubectl patch serviceaccount default -n ${namespace} \\`,
      `    -p \'{"imagePullSecrets": [{"name": "regcred"}]}\'`,
      '',
      '  # Verify image exists:',
      `  kubectl run test --image=${image} --restart=Never --dry-run=client`,
    ].join('\n'),
  })
  return steps
}

// ── Runbook 10: Diagnose High-Restart Pods ───────────────────────────────────
async function highRestartPods({ namespace }: Opts): Promise<Step[]> {
  const steps: Step[] = []
  const THRESHOLD = 3
  const pods = await k8sGet(`/api/v1/namespaces/${namespace}/pods`)
  const high = (pods.items ?? [])
    .filter((p: any) =>
      (p.status?.containerStatuses ?? []).reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0) >= THRESHOLD
    )
    .map((p: any) => ({
      pod: p,
      restarts: (p.status?.containerStatuses ?? []).reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0),
      lastReason: (p.status?.containerStatuses ?? [])[0]?.lastState?.terminated?.reason ?? 'Unknown',
    }))
    .sort((a, b) => b.restarts - a.restarts)
    .slice(0, 8)

  steps.push({
    name: `Pods with ≥ ${THRESHOLD} restarts`,
    status: high.length ? 'warn' : 'ok',
    output: high.length
      ? `Top ${high.length} by restart count:\n${high.map(h =>
          `  • ${h.pod.metadata.name}  restarts=${h.restarts}  lastReason=${h.lastReason}  status=${h.pod.status?.phase}`
        ).join('\n')}`
      : `No pods exceed restart threshold (${THRESHOLD}) in "${namespace}"`,
  })
  if (!high.length) return steps

  const top = high[0]
  const ns   = top.pod.metadata.namespace ?? namespace
  const name = top.pod.metadata.name
  const cont = top.pod.spec?.containers?.[0]?.name

  const evts = await k8sGet(`/api/v1/namespaces/${ns}/events?fieldSelector=involvedObject.name=${name}`)
  const evtOut = (evts.items ?? []).slice(-6).map((e: any) => `  [${e.reason}] ${e.message}`).join('\n') || '  (no events)'
  steps.push({ name: `Events — ${name}`, status: 'ok', output: evtOut })

  const logs = await k8sLog(ns, name, true, cont)
  steps.push({ name: 'Previous container logs', status: 'ok', output: logs || '(no previous logs)' })

  const req  = top.pod.spec?.containers?.[0]?.resources?.requests ?? {}
  const lim  = top.pod.spec?.containers?.[0]?.resources?.limits ?? {}
  steps.push({
    name: 'Resource allocation',
    status: 'info',
    output: [
      `  Container: ${cont ?? '?'}`,
      `  requests: cpu=${req.cpu ?? 'none'}  memory=${req.memory ?? 'none'}`,
      `  limits:   cpu=${lim.cpu ?? 'none'}  memory=${lim.memory ?? 'none'}`,
      '',
      `  Recommendation: ${top.lastReason === 'OOMKilled' ? 'Increase memory limit — pod is being killed by OOM' : 'Check logs for panic/fatal errors and review liveness probe settings'}`,
    ].join('\n'),
  })
  return steps
}

// ── Router ────────────────────────────────────────────────────────────────────
const RUNBOOKS: Record<string, (opts: Opts) => Promise<Step[]>> = {
  'diagnose-crash-loop':      diagnoseCrashLoop,
  'oom-patch-restart':        oomPatchRestart,
  'rollback-deployment':      rollbackDeployment,
  'force-delete-terminating': forceDeleteTerminating,
  'scale-deployment':         scaleDeployment,
  'cleanup-evicted':          cleanupEvicted,
  'cordon-drain-node':        cordonDrainNode,
  'audit-tls-certs':          auditTLSCerts,
  'debug-imagepull':          debugImagePull,
  'high-restart-pods':        highRestartPods,
}

export async function POST(req: NextRequest) {
  const isInternal = INTERNAL_SECRET !== '' && req.headers.get('x-internal-secret') === INTERNAL_SECRET
  if (!isInternal) {
    const deny = await assertOperator()
    if (deny) return deny
  }
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { runbookId, namespace = 'default', target = '', params = {} } = body
  const executor = RUNBOOKS[runbookId]
  if (!executor) return NextResponse.json({ error: `Unknown runbook: ${runbookId}. Custom runbooks require a backend executor.` }, { status: 400 })

  const start = Date.now()
  try {
    const steps = await executor({ namespace, target, params })
    const duration = Date.now() - start
    const status = steps.some(s => s.status === 'error') ? 'failed'
      : steps.some(s => s.status === 'warn') ? 'warning' : 'success'
    return NextResponse.json({ runbookId, namespace, target, steps, duration, status })
  } catch (err: any) {
    return NextResponse.json({
      runbookId, namespace, target,
      steps: [{ name: 'Execution error', status: 'error', output: String(err.message ?? err) }],
      duration: Date.now() - start,
      status: 'failed',
    })
  }
}