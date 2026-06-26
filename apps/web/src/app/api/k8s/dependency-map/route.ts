import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

const SKIP_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } })
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const [deploysData, stsData, dsData, podsData] = await Promise.all([
    k8sGet('/apis/apps/v1/deployments'),
    k8sGet('/apis/apps/v1/statefulsets'),
    k8sGet('/apis/apps/v1/daemonsets'),
    k8sGet('/api/v1/pods?limit=1000'),
  ])

  const allWorkloads = [
    ...(deploysData.items ?? []).map((w: any) => ({ ...w, _kind: 'Deployment' })),
    ...(stsData.items ?? []).map((w: any) => ({ ...w, _kind: 'StatefulSet' })),
    ...(dsData.items ?? []).map((w: any) => ({ ...w, _kind: 'DaemonSet' })),
  ].filter((w: any) => !SKIP_NS.has(w.metadata?.namespace ?? ''))

  // Build ReplicaSet → Deployment name map
  const rsOwnerMap: Record<string, string> = {}
  const rsList = await k8sGet('/apis/apps/v1/replicasets')
  for (const rs of rsList.items ?? []) {
    const depOwner = (rs.metadata?.ownerReferences ?? []).find((o: any) => o.kind === 'Deployment')
    if (depOwner) rsOwnerMap[`${rs.metadata.namespace}/${rs.metadata.name}`] = depOwner.name
  }

  // Index pods by namespace/workloadName
  type DepEntry = { secrets: Set<string>; configmaps: Set<string>; pvcs: Set<string>; services: Set<string> }
  const depByWorkload: Record<string, DepEntry> = {}

  for (const pod of podsData.items ?? []) {
    const ns: string = pod.metadata?.namespace ?? ''
    if (SKIP_NS.has(ns)) continue
    const owners: any[] = pod.metadata?.ownerReferences ?? []
    const rsOwner = owners.find((o: any) => o.kind === 'ReplicaSet')
    const directOwner = owners.find((o: any) => ['StatefulSet', 'DaemonSet'].includes(o.kind))

    let workloadName = ''
    if (directOwner) {
      workloadName = directOwner.name
    } else if (rsOwner) {
      workloadName = rsOwnerMap[`${ns}/${rsOwner.name}`] ?? rsOwner.name.replace(/-[a-z0-9]+$/, '')
    }
    if (!workloadName) continue

    const key = `${ns}/${workloadName}`
    if (!depByWorkload[key]) depByWorkload[key] = { secrets: new Set(), configmaps: new Set(), pvcs: new Set(), services: new Set() }
    const entry = depByWorkload[key]

    const spec = pod.spec ?? {}

    // Volumes → PVCs, Secrets, ConfigMaps
    for (const vol of spec.volumes ?? []) {
      if (vol.configMap?.name) entry.configmaps.add(vol.configMap.name)
      if (vol.secret?.secretName) entry.secrets.add(vol.secret.secretName)
      if (vol.persistentVolumeClaim?.claimName) entry.pvcs.add(vol.persistentVolumeClaim.claimName)
    }

    // Containers env / envFrom
    for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
      for (const envFrom of c.envFrom ?? []) {
        if (envFrom.configMapRef?.name) entry.configmaps.add(envFrom.configMapRef.name)
        if (envFrom.secretRef?.name) entry.secrets.add(envFrom.secretRef.name)
      }
      for (const env of c.env ?? []) {
        if (env.valueFrom?.configMapKeyRef?.name) entry.configmaps.add(env.valueFrom.configMapKeyRef.name)
        if (env.valueFrom?.secretKeyRef?.name) entry.secrets.add(env.valueFrom.secretKeyRef.name)
      }
    }
  }

  const workloads = allWorkloads.map((w: any) => {
    const ns   = w.metadata?.namespace ?? ''
    const name = w.metadata?.name ?? ''
    const key  = `${ns}/${name}`
    const entry = depByWorkload[key] ?? { secrets: new Set(), configmaps: new Set(), pvcs: new Set(), services: new Set() }
    return {
      name,
      namespace: ns,
      kind:      w._kind,
      deps: {
        secrets:    Array.from(entry.secrets),
        configmaps: Array.from(entry.configmaps),
        pvcs:       Array.from(entry.pvcs),
        services:   Array.from(entry.services),
      },
    }
  }).filter(w => w.deps.secrets.length + w.deps.configmaps.length + w.deps.pvcs.length > 0)
    .sort((a, b) => {
      const total = (w: typeof a) => w.deps.secrets.length + w.deps.configmaps.length + w.deps.pvcs.length
      return total(b) - total(a)
    })

  return NextResponse.json({ workloads })
}