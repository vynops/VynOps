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

// CPU milli-cores from K8s quantity string
function parseCpuMillis(s?: string): number {
  if (!s) return 0
  if (s.endsWith('m')) return parseInt(s)
  return Math.round(parseFloat(s) * 1000)
}

// Memory in MiB from K8s quantity string
function parseMemMiB(s?: string): number {
  if (!s) return 0
  if (s.endsWith('Ki')) return Math.round(parseInt(s) / 1024)
  if (s.endsWith('Mi')) return parseInt(s)
  if (s.endsWith('Gi')) return Math.round(parseFloat(s) * 1024)
  if (s.endsWith('Ti')) return Math.round(parseFloat(s) * 1024 * 1024)
  return Math.round(parseInt(s) / (1024 * 1024))
}

// Default cloud cost rates (USD/hr)
const CPU_COST_PER_CORE_HR  = 0.048
const MEM_COST_PER_GIB_HR   = 0.006

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const [podsData, deploysData, stsData] = await Promise.all([
    k8sGet('/api/v1/pods?limit=1000'),
    k8sGet('/apis/apps/v1/deployments'),
    k8sGet('/apis/apps/v1/statefulsets'),
  ])

  const pods: any[] = (podsData.items ?? []).filter((p: any) =>
    !SKIP_NS.has(p.metadata?.namespace ?? '') && p.status?.phase !== 'Succeeded'
  )

  // Build workload → pods map via owner references
  const workloadMap: Record<string, { namespace: string; kind: string; cpuMillis: number; memMiB: number; podCount: number }> = {}

  for (const pod of pods) {
    const ns: string = pod.metadata?.namespace ?? 'default'
    const owners: any[] = pod.metadata?.ownerReferences ?? []
    const rsOwner = owners.find((o: any) => o.kind === 'ReplicaSet')
    const directOwner = owners.find((o: any) => ['StatefulSet','DaemonSet','Job','CronJob'].includes(o.kind))

    let workloadKind = 'Pod'
    let workloadName = pod.metadata?.name ?? ''

    if (directOwner) {
      workloadKind = directOwner.kind
      workloadName = directOwner.name
    } else if (rsOwner) {
      // Find the Deployment that owns this ReplicaSet
      const depName = rsOwner.name.replace(/-[a-z0-9]+$/, '')
      workloadKind = 'Deployment'
      workloadName = depName
    }

    const key = `${ns}/${workloadKind}/${workloadName}`
    const containers: any[] = pod.spec?.containers ?? []
    let cpuMillis = 0, memMiB = 0
    for (const c of containers) {
      cpuMillis += parseCpuMillis(c.resources?.requests?.cpu)
      memMiB    += parseMemMiB(c.resources?.requests?.memory)
    }

    if (!workloadMap[key]) workloadMap[key] = { namespace: ns, kind: workloadKind, cpuMillis: 0, memMiB: 0, podCount: 0 }
    workloadMap[key].cpuMillis += cpuMillis
    workloadMap[key].memMiB    += memMiB
    workloadMap[key].podCount  += 1
  }

  // Build per-namespace totals
  const nsTotals: Record<string, { cpuMillis: number; memMiB: number; workloadCount: number }> = {}

  const byWorkload = Object.entries(workloadMap).map(([key, v]) => {
    const parts = key.split('/')
    const name = parts.slice(2).join('/')
    const cpuCores = v.cpuMillis / 1000
    const memGiB   = v.memMiB / 1024
    const costPerHr = cpuCores * CPU_COST_PER_CORE_HR + memGiB * MEM_COST_PER_GIB_HR
    const costPerMo = Math.round(costPerHr * 730 * 100) / 100

    if (!nsTotals[v.namespace]) nsTotals[v.namespace] = { cpuMillis: 0, memMiB: 0, workloadCount: 0 }
    nsTotals[v.namespace].cpuMillis    += v.cpuMillis
    nsTotals[v.namespace].memMiB       += v.memMiB
    nsTotals[v.namespace].workloadCount += 1

    return {
      namespace: v.namespace,
      kind:      v.kind,
      name,
      podCount:  v.podCount,
      cpuMillis: v.cpuMillis,
      memMiB:    Math.round(v.memMiB),
      cpuCores:  Math.round(cpuCores * 100) / 100,
      memGiB:    Math.round(memGiB * 100) / 100,
      costPerHr: Math.round(costPerHr * 10000) / 10000,
      costPerMo,
    }
  }).sort((a, b) => b.costPerMo - a.costPerMo)

  const byNamespace = Object.entries(nsTotals).map(([ns, v]) => {
    const cpuCores  = v.cpuMillis / 1000
    const memGiB    = v.memMiB / 1024
    const costPerHr = cpuCores * CPU_COST_PER_CORE_HR + memGiB * MEM_COST_PER_GIB_HR
    return {
      namespace:      ns,
      workloadCount:  v.workloadCount,
      cpuCores:       Math.round(cpuCores * 100) / 100,
      memGiB:         Math.round(memGiB * 100) / 100,
      costPerMo:      Math.round(costPerHr * 730 * 100) / 100,
    }
  }).sort((a, b) => b.costPerMo - a.costPerMo)

  const totalCostPerMo = byNamespace.reduce((a, n) => a + n.costPerMo, 0)

  return NextResponse.json({
    byWorkload,
    byNamespace,
    totalCostPerMo: Math.round(totalCostPerMo * 100) / 100,
    ratesUsed: { cpuPerCoreHr: CPU_COST_PER_CORE_HR, memPerGiBHr: MEM_COST_PER_GIB_HR },
  })
}