/**
 * POST /api/security/fix
 *
 * Applies a single security hardening patch to the live cluster.
 * All operations are targeted and reversible (deployment rollback restores prior state).
 *
 * Fix types:
 *   set_no_priv_esc   — sets allowPrivilegeEscalation: false on a container
 *   remove_host_network — sets hostNetwork: false on a deployment
 *   add_psa_label     — adds pod-security.kubernetes.io/enforce: baseline label to a namespace
 *   add_resource_limits — sets default CPU+memory limits on a container
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth }                      from '@/lib/auth'
import { resolveK8sUrl, K8S_TIMEOUT_MS } from '@/lib/cluster'
import { appendAuditLog }            from '@/app/api/settings/config/shared'
import type { FixType }              from '@/app/api/security/fix/shared'

interface FixRequest {
  type:           FixType
  namespace:      string
  podName?:       string
  containerName?: string
  containerType?: 'containers' | 'initContainers'
}

async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  if (!K8S) return null
  const r = await fetch(`${K8S}${path}`, {
    headers: { Accept: 'application/json' },
    signal:  AbortSignal.timeout(K8S_TIMEOUT_MS),
  })
  return r.ok ? r.json() : null
}

async function k8sMergePatch(path: string, body: unknown) {
  const K8S = await resolveK8sUrl()
  if (!K8S) throw new Error('K8s API not configured')
  const r = await fetch(`${K8S}${path}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(K8S_TIMEOUT_MS),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`K8s ${r.status}: ${txt.slice(0, 200)}`)
  }
  return r.json()
}

async function k8sStrategicPatch(path: string, body: unknown) {
  const K8S = await resolveK8sUrl()
  if (!K8S) throw new Error('K8s API not configured')
  const r = await fetch(`${K8S}${path}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(K8S_TIMEOUT_MS),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`K8s ${r.status}: ${txt.slice(0, 200)}`)
  }
  return r.json()
}

type WorkloadTarget = { resource: 'deployments' | 'statefulsets' | 'daemonsets'; name: string }

const WORKLOAD_RESOURCE: Record<string, WorkloadTarget['resource']> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
}

function workloadPath(namespace: string, target: WorkloadTarget): string {
  return `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/${target.resource}/${encodeURIComponent(target.name)}`
}

async function resolveWorkload(podName: string, namespace: string): Promise<WorkloadTarget | null> {
  const pod = await k8sGet(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`)
  const owners = pod?.metadata?.ownerReferences ?? []
  const owner = owners.find((item: any) => item.controller !== false && (WORKLOAD_RESOURCE[item.kind] || item.kind === 'ReplicaSet')) ?? owners[0]

  if (owner?.kind === 'ReplicaSet') {
    const replicaSet = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets/${encodeURIComponent(owner.name)}`)
    const deployment = (replicaSet?.metadata?.ownerReferences ?? []).find((item: any) => item.kind === 'Deployment')
    if (deployment?.name) return { resource: 'deployments', name: deployment.name }
  } else if (owner?.name && WORKLOAD_RESOURCE[owner.kind]) {
    return { resource: WORKLOAD_RESOURCE[owner.kind], name: owner.name }
  }

  for (const resource of ['deployments', 'statefulsets', 'daemonsets'] as const) {
    const workload = await k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/${resource}/${encodeURIComponent(podName)}`)
    if (workload) return { resource, name: podName }
  }
  return null
}

// ── Fix handlers ──────────────────────────────────────────────────────────────

async function fixNoPrivEsc(namespace: string, podName: string, containerName: string, containerType: 'containers' | 'initContainers') {
  const workload = await resolveWorkload(podName, namespace)
  if (!workload) throw new Error(`Could not resolve a supported workload from pod ${podName}`)

  // Strategic merge patch — uses container.name as merge key
  await k8sStrategicPatch(
    workloadPath(namespace, workload),
    {
      spec: {
        template: {
          spec: {
            [containerType]: [{
              name: containerName,
              securityContext: { allowPrivilegeEscalation: false },
            }],
          },
        },
      },
    },
  )
  return { workload: workload.name, applied: `securityContext.allowPrivilegeEscalation: false on container ${containerName}` }
}

async function fixHostNetwork(namespace: string, podName: string) {
  const workload = await resolveWorkload(podName, namespace)
  if (!workload) throw new Error(`Could not resolve a supported workload from pod ${podName}`)

  await k8sMergePatch(
    workloadPath(namespace, workload),
    { spec: { template: { spec: { hostNetwork: false } } } },
  )
  return { workload: workload.name, applied: 'spec.template.spec.hostNetwork: false' }
}

async function fixPsaLabel(namespace: string) {
  await k8sMergePatch(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}`,
    {
      metadata: {
        labels: { 'pod-security.kubernetes.io/enforce': 'baseline' },
      },
    },
  )
  return { namespace, applied: 'pod-security.kubernetes.io/enforce: baseline' }
}

async function fixResourceLimits(namespace: string, podName: string, containerName: string, containerType: 'containers' | 'initContainers') {
  const workload = await resolveWorkload(podName, namespace)
  if (!workload) throw new Error(`Could not resolve a supported workload from pod ${podName}`)

  // Read current spec to check what limits (if any) exist
  const dep = await k8sGet(workloadPath(namespace, workload))
  const containers: any[] = dep?.spec?.template?.spec?.[containerType] ?? []
  const container = containers.find((c: any) => c.name === containerName)
  if (!container) throw new Error(`Container ${containerName} not found in ${workload.name}`)
  const existing  = container?.resources?.limits ?? {}

  const newLimits = {
    cpu:    existing.cpu    ?? '500m',
    memory: existing.memory ?? '256Mi',
  }

  await k8sStrategicPatch(
    workloadPath(namespace, workload),
    {
      spec: {
        template: {
          spec: {
            [containerType]: [{
              name: container?.name ?? containerName,
              resources: { limits: newLimits },
            }],
          },
        },
      },
    },
  )
  return { workload: workload.name, applied: `resources.limits: {cpu: ${newLimits.cpu}, memory: ${newLimits.memory}} on container ${container.name}` }
}

async function fixReadOnlyRootFs(namespace: string, podName: string, containerName: string, containerType: 'containers' | 'initContainers') {
  const workload = await resolveWorkload(podName, namespace)
  if (!workload) throw new Error(`Could not resolve a supported workload from pod ${podName}`)
  const current = await k8sGet(workloadPath(namespace, workload))
  const containers: any[] = current?.spec?.template?.spec?.[containerType] ?? []
  if (!containers.some((container: any) => container.name === containerName)) {
    throw new Error(`Container ${containerName} not found in ${workload.name}`)
  }
  await k8sStrategicPatch(workloadPath(namespace, workload), {
    spec: { template: { spec: { [containerType]: [{ name: containerName, securityContext: { readOnlyRootFilesystem: true } }] } } },
  })
  return { workload: workload.name, applied: `securityContext.readOnlyRootFilesystem: true on container ${containerName}` }
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = (session.user as any)?.role ?? ''
  if (role !== 'admin' && role !== 'operator') {
    return NextResponse.json({ error: 'Forbidden — operator or admin role required' }, { status: 403 })
  }

  let body: FixRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { type, namespace, podName = '', containerName = '', containerType = 'containers' } = body

  if (!type || !namespace) {
    return NextResponse.json({ error: 'type and namespace are required' }, { status: 400 })
  }
  if (containerType !== 'containers' && containerType !== 'initContainers') {
    return NextResponse.json({ error: 'containerType must be containers or initContainers' }, { status: 400 })
  }

  const K8S = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8s API not configured' }, { status: 503 })

  try {
    let result: Record<string, string>

    switch (type) {
      case 'set_no_priv_esc':
        if (!podName || !containerName) return NextResponse.json({ error: 'podName and containerName required' }, { status: 400 })
        result = await fixNoPrivEsc(namespace, podName, containerName, containerType)
        break
      case 'remove_host_network':
        if (!podName) return NextResponse.json({ error: 'podName required' }, { status: 400 })
        result = await fixHostNetwork(namespace, podName)
        break
      case 'add_psa_label':
        result = await fixPsaLabel(namespace)
        break
      case 'add_resource_limits':
        if (!podName || !containerName) return NextResponse.json({ error: 'podName and containerName required' }, { status: 400 })
        result = await fixResourceLimits(namespace, podName, containerName, containerType)
        break
      case 'set_read_only_root_fs':
        if (!podName || !containerName) return NextResponse.json({ error: 'podName and containerName required' }, { status: 400 })
        result = await fixReadOnlyRootFs(namespace, podName, containerName, containerType)
        break
      default:
        return NextResponse.json({ error: `Unknown fix type: ${type}` }, { status: 400 })
    }

    appendAuditLog({
      ts:     new Date().toISOString(),
      user:   (session.user as any)?.email ?? 'unknown',
      action: `security.fix.${type}`,
      detail: `ns=${namespace} pod=${podName || '-'} container=${containerName || '-'} → ${result.applied}`,
    })

    return NextResponse.json({ ok: true, type, ...result })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Fix failed' }, { status: 500 })
  }
}
