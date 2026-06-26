import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl, resolveClusterMeta, K8S_TIMEOUT_MS } from '@/lib/cluster'
import { readConfig } from '@/app/api/settings/config/shared'

const HOURS_PER_MONTH  = 730
const SKIP_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

// ?? Helpers ??????????????????????????????????????????????????????????????????

function parseCpuMillis(s?: string): number {
  if (!s) return 0
  if (s.endsWith('m')) return parseInt(s)
  return Math.round(parseFloat(s) * 1000)
}

function parseMemMiB(s?: string): number {
  if (!s) return 0
  if (s.endsWith('Ki')) return Math.round(parseInt(s) / 1024)
  if (s.endsWith('Mi')) return parseInt(s)
  if (s.endsWith('Gi')) return Math.round(parseFloat(s) * 1024)
  if (s.endsWith('Ti')) return Math.round(parseFloat(s) * 1024 * 1024)
  return Math.round(parseInt(s) / (1024 * 1024))
}

function parseCapGiB(s?: string): number {
  if (!s) return 0
  if (s.endsWith('Ki')) return parseInt(s) / 1024 / 1024
  if (s.endsWith('Mi')) return parseInt(s) / 1024
  if (s.endsWith('Gi')) return parseFloat(s)
  if (s.endsWith('Ti')) return parseFloat(s) * 1024
  return parseInt(s) / (1024 ** 3)
}

function r2(n: number): number { return Math.round(n * 100) / 100 }
function r1(n: number): number { return Math.round(n * 10) / 10 }

async function k8sGet(path: string): Promise<any> {
  const K8S = await resolveK8sUrl()
  try {
    const res = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    return res.ok ? res.json() : { items: [] }
  } catch { return { items: [] } }
}

async function promQuery(q: string): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  const PROM = await resolvePromUrl()
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    const j = await res.json()
    return j?.data?.result ?? []
  } catch { return [] }
}

// ?? Route ?????????????????????????????????????????????????????????????????????

export async function GET() {
  // Read cost rates from config (user-configurable) with defaults
  const cfg = readConfig()
  const CPU_PER_CORE_HR    = cfg.finops_cpu_per_core_hr    ?? 0.048
  const MEM_PER_GIB_HR     = cfg.finops_mem_per_gib_hr     ?? 0.006
  const STORAGE_PER_GIB_MO = cfg.finops_storage_per_gib_mo ?? 0.05

  const [
    versionData, nsData, nodesData, podsData, pvcData,
    cpuUsageByNs, memUsageByNs,
    cpuAllocatable, memAllocatable,
    nodeConditions, memAvailRaw, memTotalRaw,
    cpuNodeUsage, podCountsRaw,
    volUsedRaw, volCapRaw,
    nodeUptimeRaw,
    podAllocatable,
  ] = await Promise.all([
    k8sGet('/version'),
    k8sGet('/api/v1/namespaces'),
    k8sGet('/api/v1/nodes'),
    k8sGet('/api/v1/pods?limit=1000'),
    k8sGet('/api/v1/persistentvolumeclaims?limit=500'),
    promQuery('sum by(namespace) (rate(container_cpu_usage_seconds_total{namespace!="",container!="POD",container!=""}[5m]))'),
    promQuery('sum by(namespace) (container_memory_working_set_bytes{namespace!="",container!="POD",container!=""})'),
    promQuery('kube_node_status_allocatable{resource="cpu"}'),
    promQuery('kube_node_status_allocatable{resource="memory"}'),
    promQuery('kube_node_status_condition{condition="Ready",status="true"}'),
    promQuery('node_memory_MemAvailable_bytes'),
    promQuery('node_memory_MemTotal_bytes'),
    promQuery('1 - avg by(node) (rate(node_cpu_seconds_total{mode="idle"}[5m]))'),
    promQuery('count by(node) (kube_pod_info{node!=""})'),
    promQuery('kubelet_volume_stats_used_bytes'),
    promQuery('kubelet_volume_stats_capacity_bytes'),
    promQuery('node_time_seconds - node_boot_time_seconds'),
    promQuery('kube_node_status_allocatable{resource="pods"}'),
  ])

  // ?? 1. Cluster ????????????????????????????????????????????????????????????
  const clusterMeta = await resolveClusterMeta()
  const cluster = {
    name:     clusterMeta?.name     ?? (versionData as any)?.gitVersion ?? '?',
    provider: clusterMeta?.provider ?? 'on-prem',
    region:   clusterMeta?.region   ?? '?',
    version:  (versionData as any)?.gitVersion ?? '?',
    namespaceCount: ((nsData as any)?.items ?? []).length,
  }

  // ?? 2. Nodes ??????????????????????????????????????????????????????????????
  // Build ready map from Prometheus first; fall back to k8s API conditions
  const readyMap: Record<string, boolean> = {}
  for (const r of nodeConditions) readyMap[r.metric.node] = r.value[1] === '1'
  for (const item of (nodesData as any)?.items ?? []) {
    const name: string = item.metadata?.name ?? ''
    if (name && !(name in readyMap)) {
      const cond = (item.status?.conditions ?? []).find((c: any) => c.type === 'Ready')
      readyMap[name] = cond?.status === 'True'
    }
  }

  const cpuAllocByNode: Record<string, number> = {}
  for (const r of cpuAllocatable) cpuAllocByNode[r.metric.node] = parseFloat(r.value[1])

  const memAllocByNode: Record<string, number> = {}
  for (const r of memAllocatable) memAllocByNode[r.metric.node] = parseFloat(r.value[1]) / (1024 ** 3)

  const cpuUsageByNodeMap: Record<string, number> = {}
  for (const r of cpuNodeUsage) cpuUsageByNodeMap[r.metric.node] = parseFloat(r.value[1])

  const podCountByNode: Record<string, number> = {}
  for (const r of podCountsRaw) podCountByNode[r.metric.node] = parseInt(r.value[1])

  const podCapByNode: Record<string, number> = {}
  for (const r of podAllocatable) podCapByNode[r.metric.node] = parseInt(r.value[1])

  // Build instance ? node map from K8s node addresses
  const instanceToNode: Record<string, string> = {}
  for (const item of (nodesData as any)?.items ?? []) {
    const nodeName: string = item.metadata?.name ?? ''
    const internalIP = ((item.status?.addresses ?? []) as any[]).find((a: any) => a.type === 'InternalIP')?.address ?? ''
    if (internalIP) instanceToNode[internalIP] = nodeName
  }
  function resolveInst(instance: string) {
    return instanceToNode[instance?.split(':')[0]] ?? instance?.split(':')[0]
  }

  const memAvailByNode: Record<string, number> = {}
  const memTotalByNode: Record<string, number> = {}
  const uptimeByNode:   Record<string, number> = {}
  for (const r of memAvailRaw)  memAvailByNode[resolveInst(r.metric.instance)]  = parseFloat(r.value[1]) / (1024 ** 3)
  for (const r of memTotalRaw)  memTotalByNode[resolveInst(r.metric.instance)]  = parseFloat(r.value[1]) / (1024 ** 3)
  for (const r of nodeUptimeRaw) uptimeByNode[resolveInst(r.metric.instance)]   = parseFloat(r.value[1]) / 3600

  const nodes = ((nodesData as any)?.items ?? []).map((item: any) => {
    const name: string = item.metadata?.name ?? ''
    const labels: Record<string, string> = item.metadata?.labels ?? {}
    const cpuCores  = cpuAllocByNode[name] ?? 0
    const memGiB    = memAllocByNode[name] ?? 0
    const cpuUsed   = cpuUsageByNodeMap[name] ?? 0
    const memTotal  = memTotalByNode[name] ?? memGiB
    const memAvail  = memAvailByNode[name] ?? memGiB
    const cpuUsagePct = cpuCores > 0 ? r1(Math.min(100, cpuUsed / cpuCores * 100)) : 0
    const memUsagePct = memTotal > 0 ? r1(Math.min(100, (1 - memAvail / memTotal) * 100)) : 0

    return {
      name,
      status: readyMap[name] === true ? 'ready' : 'not-ready',
      cpuCores:   r1(cpuCores),
      cpuUsagePct,
      memGiB:     r1(memGiB),
      memUsagePct,
      podCount:   podCountByNode[name] ?? 0,
      podCapacity: podCapByNode[name] ?? 110,
      uptimeHours: Math.round(uptimeByNode[name] ?? 0),
      instanceType: labels['node.kubernetes.io/instance-type'] ?? labels['beta.kubernetes.io/instance-type'] ?? 'VM',
      os:   labels['kubernetes.io/os']   ?? 'linux',
      arch: labels['kubernetes.io/arch'] ?? 'amd64',
    }
  })

  // ?? 3. Cost + efficiency ??????????????????????????????????????????????????
  const cpuActualByNs: Record<string, number> = {}
  for (const r of cpuUsageByNs) cpuActualByNs[r.metric.namespace] = parseFloat(r.value[1])

  const memActualByNs: Record<string, number> = {}
  for (const r of memUsageByNs) memActualByNs[r.metric.namespace] = parseFloat(r.value[1]) / (1024 ** 3)

  const allPods: any[] = ((podsData as any)?.items ?? []).filter((p: any) =>
    !SKIP_NS.has(p.metadata?.namespace ?? '') && p.status?.phase !== 'Succeeded'
  )
  const totalPodCount = allPods.length

  // Build workload ? resource-requests aggregation
  type WlEntry = { namespace: string; kind: string; cpuMillis: number; memMiB: number; podCount: number }
  const workloadMap: Record<string, WlEntry> = {}

  for (const pod of allPods) {
    const ns: string = pod.metadata?.namespace ?? 'default'
    const owners: any[] = pod.metadata?.ownerReferences ?? []
    const rsOwner     = owners.find((o: any) => o.kind === 'ReplicaSet')
    const directOwner = owners.find((o: any) => ['StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(o.kind))
    let kind = 'Pod', wlName = pod.metadata?.name ?? ''
    if (directOwner) { kind = directOwner.kind; wlName = directOwner.name }
    else if (rsOwner) { kind = 'Deployment'; wlName = rsOwner.name.replace(/-[a-z0-9]+$/, '') }
    const key = `${ns}/${kind}/${wlName}`
    const containers: any[] = pod.spec?.containers ?? []
    let cpuMillis = 0, memMiB = 0
    for (const c of containers) {
      cpuMillis += parseCpuMillis(c.resources?.requests?.cpu)
      memMiB    += parseMemMiB(c.resources?.requests?.memory)
    }
    if (!workloadMap[key]) workloadMap[key] = { namespace: ns, kind, cpuMillis: 0, memMiB: 0, podCount: 0 }
    workloadMap[key].cpuMillis += cpuMillis
    workloadMap[key].memMiB    += memMiB
    workloadMap[key].podCount  += 1
  }

  // Namespace aggregation
  type NsEntry = { cpuMillis: number; memMiB: number; workloadCount: number; podCount: number }
  const nsTotals: Record<string, NsEntry> = {}

  const byWorkload = Object.entries(workloadMap).map(([key, v]) => {
    const name      = key.split('/').slice(2).join('/')
    const cpuCores  = v.cpuMillis / 1000
    const memGiB    = v.memMiB / 1024
    const costPerMo = r2((cpuCores * CPU_PER_CORE_HR + memGiB * MEM_PER_GIB_HR) * HOURS_PER_MONTH)
    if (!nsTotals[v.namespace]) nsTotals[v.namespace] = { cpuMillis: 0, memMiB: 0, workloadCount: 0, podCount: 0 }
    nsTotals[v.namespace].cpuMillis     += v.cpuMillis
    nsTotals[v.namespace].memMiB        += v.memMiB
    nsTotals[v.namespace].workloadCount += 1
    nsTotals[v.namespace].podCount      += v.podCount
    return { namespace: v.namespace, kind: v.kind, name, podCount: v.podCount, cpuCores: r2(cpuCores), memGiB: r2(memGiB), costPerMo }
  }).sort((a, b) => b.costPerMo - a.costPerMo)

  const totalCostPerMo = byWorkload.reduce((s, w) => s + w.costPerMo, 0)

  const byNamespace = Object.entries(nsTotals).map(([ns, v]) => {
    const cpuReq    = v.cpuMillis / 1000
    const memReq    = v.memMiB / 1024
    const cpuActual = cpuActualByNs[ns] ?? 0
    const memActual = memActualByNs[ns] ?? 0
    const costPerMo = r2((cpuReq * CPU_PER_CORE_HR + memReq * MEM_PER_GIB_HR) * HOURS_PER_MONTH)

    // Efficiency: actual / requested (null if no requests set)
    const cpuEfficiency = cpuReq > 0 ? Math.min(100, Math.round(cpuActual / cpuReq * 100)) : null
    const memEfficiency = memReq > 0 ? Math.min(100, Math.round(memActual / memReq * 100)) : null
    const overallEfficiency = cpuEfficiency !== null && memEfficiency !== null
      ? Math.round((cpuEfficiency * 0.5 + memEfficiency * 0.5))
      : cpuEfficiency ?? memEfficiency ?? null

    // Waste = requested but not used
    const cpuWastedCores = cpuReq > 0 ? Math.max(0, cpuReq - cpuActual) : 0
    const memWastedGiB   = memReq > 0 ? Math.max(0, memReq - memActual) : 0
    const wastedPerMo    = r2((cpuWastedCores * CPU_PER_CORE_HR + memWastedGiB * MEM_PER_GIB_HR) * HOURS_PER_MONTH)
    const costSharePct   = totalCostPerMo > 0 ? r1(costPerMo / totalCostPerMo * 100) : 0

    return {
      namespace: ns,
      workloadCount: v.workloadCount,
      podCount: v.podCount,
      cpuRequestedCores: r2(cpuReq),
      memRequestedGiB:   r2(memReq),
      cpuActualCores:    r2(cpuActual),
      memActualGiB:      r2(memActual),
      cpuEfficiency,
      memEfficiency,
      overallEfficiency,
      costPerMo,
      wastedPerMo,
      costSharePct,
    }
  }).sort((a, b) => b.costPerMo - a.costPerMo)

  const totalWastedPerMo  = byNamespace.reduce((s, n) => s + n.wastedPerMo, 0)
  const nsWithEff         = byNamespace.filter(n => n.overallEfficiency !== null)
  const overallCpuEff     = nsWithEff.length > 0
    ? Math.round(nsWithEff.reduce((s, n) => s + (n.cpuEfficiency ?? 0), 0) / nsWithEff.length) : 0
  const overallMemEff     = nsWithEff.length > 0
    ? Math.round(nsWithEff.reduce((s, n) => s + (n.memEfficiency ?? 0), 0) / nsWithEff.length) : 0

  // ?? 4. Storage ????????????????????????????????????????????????????????????
  const volUsedMap: Record<string, number> = {}
  const volCapMap:  Record<string, number> = {}
  for (const r of volUsedRaw) {
    volUsedMap[`${r.metric.namespace}/${r.metric.persistentvolumeclaim}`] = parseFloat(r.value?.[1] ?? '0') / (1024 ** 3)
  }
  for (const r of volCapRaw) {
    volCapMap[`${r.metric.namespace}/${r.metric.persistentvolumeclaim}`] = parseFloat(r.value?.[1] ?? '0') / (1024 ** 3)
  }

  const pvcs = ((pvcData as any)?.items ?? []).map((pvc: any) => {
    const ns   = pvc.metadata?.namespace ?? ''
    const name = pvc.metadata?.name ?? ''
    const key  = `${ns}/${name}`
    const sc   = pvc.spec?.storageClassName ?? 'local-path'
    const specCapStr   = pvc.spec?.resources?.requests?.storage ?? '0'
    const statusCapStr = pvc.status?.capacity?.storage ?? specCapStr
    const capacityGiB  = parseCapGiB(statusCapStr) || parseCapGiB(specCapStr)
    const usedGiB      = volUsedMap[key] ?? 0
    const capFromProm  = volCapMap[key] ?? 0
    const effectiveCap = capFromProm > 0 ? capFromProm : capacityGiB
    const usagePct     = effectiveCap > 0 ? Math.min(100, Math.round(usedGiB / effectiveCap * 100)) : 0
    const costPerMo    = r2(effectiveCap * STORAGE_PER_GIB_MO)
    return {
      name, namespace: ns,
      capacityGiB: r2(effectiveCap || capacityGiB),
      usedGiB: r2(usedGiB),
      usagePct,
      storageClass: sc,
      status: pvc.status?.phase ?? 'Unknown',
      costPerMo,
    }
  }).sort((a: any, b: any) => b.costPerMo - a.costPerMo)

  const totalStorageCap    = pvcs.reduce((s: number, p: any) => s + p.capacityGiB, 0)
  const totalStorageUsed   = pvcs.reduce((s: number, p: any) => s + p.usedGiB, 0)
  const totalStorageCostMo = pvcs.reduce((s: number, p: any) => s + p.costPerMo, 0)

  // ?? 5. Optimizations ?????????????????????????????????????????????????????
  type Opt = {
    type: string; namespace: string; workload: string
    currentCost: number; savingsPotential: number; reason: string; severity: 'critical' | 'warning' | 'info'
    // enriched fields
    cpuRequested?: number; cpuActual?: number; cpuEfficiency?: number | null
    memRequestedGiB?: number; memActualGiB?: number; memEfficiency?: number | null
    recommendedCpuM?: number; recommendedMemMiB?: number
    wastedCpuCores?: number; wastedMemGiB?: number
    podCount?: number; workloadCount?: number
    rightSizeSavings?: number; cpuSavings?: number; memSavings?: number
    kubectl?: string
    priorityScore?: number  // 0-100, higher = act first
  }
  const optimizations: Opt[] = []

  // ?? Per-namespace: severe over-provisioning ??????????????????????????????
  for (const ns of byNamespace) {
    if (ns.overallEfficiency !== null && ns.overallEfficiency < 25 && ns.costPerMo > 3) {
      const sev: 'critical' | 'warning' = ns.overallEfficiency < 10 ? 'critical' : 'warning'
      const ratio = Math.round(100 / Math.max(1, ns.overallEfficiency))
      const cpuWasted  = Math.max(0, ns.cpuRequestedCores - ns.cpuActualCores)
      const memWasted  = Math.max(0, ns.memRequestedGiB   - ns.memActualGiB)
      // Recommend: 2? actual + 20% headroom, capped at current
      const recCpuM    = Math.round(Math.min(ns.cpuRequestedCores, ns.cpuActualCores * 2.2) * 1000)
      const recMemMiB  = Math.round(Math.min(ns.memRequestedGiB * 1024, ns.memActualGiB * 1024 * 2.2))
      const cpuSave    = r2(cpuWasted * 0.6 * CPU_PER_CORE_HR * HOURS_PER_MONTH)  // conservative 60% of waste
      const memSave    = r2(memWasted * 0.6 * MEM_PER_GIB_HR  * HOURS_PER_MONTH)
      const totalSave  = r2(cpuSave + memSave)
      const priority   = Math.min(100, Math.round((1 - ns.overallEfficiency / 100) * 80 + (totalSave / Math.max(1, ns.costPerMo)) * 20))
      optimizations.push({
        type: 'over-provisioned', namespace: ns.namespace, workload: '(all workloads)',
        currentCost: ns.costPerMo, savingsPotential: totalSave,
        reason: `Overall efficiency ${ns.overallEfficiency}% ? requests are ~${ratio}? actual usage across ${ns.workloadCount} workload${ns.workloadCount !== 1 ? 's' : ''} (${ns.podCount} pods). Right-sizing to 2? peak would reclaim ${fmt$(totalSave)}/mo.`,
        severity: sev,
        cpuRequested: ns.cpuRequestedCores, cpuActual: r2(ns.cpuActualCores), cpuEfficiency: ns.cpuEfficiency,
        memRequestedGiB: ns.memRequestedGiB, memActualGiB: r2(ns.memActualGiB), memEfficiency: ns.memEfficiency,
        wastedCpuCores: r2(cpuWasted), wastedMemGiB: r2(memWasted),
        recommendedCpuM: recCpuM, recommendedMemMiB: recMemMiB,
        rightSizeSavings: totalSave, cpuSavings: cpuSave, memSavings: memSave,
        podCount: ns.podCount, workloadCount: ns.workloadCount,
        kubectl: `kubectl set resources -n ${ns.namespace} deployment --all --requests=cpu=${recCpuM}m,memory=${recMemMiB}Mi`,
        priorityScore: priority,
      })
    }

    // No resource requests (any namespace)
    if (ns.cpuRequestedCores === 0 && ns.podCount > 0) {
      optimizations.push({
        type: 'no-requests', namespace: ns.namespace, workload: '(all workloads)',
        currentCost: 0, savingsPotential: 0,
        reason: `${ns.podCount} pod${ns.podCount !== 1 ? 's' : ''} have no CPU/memory requests set ? cost attribution is impossible and pods may starve during node pressure. Add LimitRange or per-workload requests.`,
        severity: 'warning',
        podCount: ns.podCount, workloadCount: ns.workloadCount,
        kubectl: `kubectl get pods -n ${ns.namespace} -o json | jq '.items[] | select(.spec.containers[].resources.requests == null) | .metadata.name'`,
        priorityScore: 40,
      })
    }
  }

  // ?? Per-namespace: CPU-specific over-provisioning ??????????????????????
  for (const ns of byNamespace) {
    const alreadyFlagged = optimizations.find(o => o.namespace === ns.namespace && o.type === 'over-provisioned')
    if (!alreadyFlagged && ns.cpuEfficiency !== null && ns.cpuEfficiency < 20 && ns.cpuRequestedCores > 1) {
      const cpuWasted  = Math.max(0, ns.cpuRequestedCores - ns.cpuActualCores)
      const saving     = r2(cpuWasted * 0.6 * CPU_PER_CORE_HR * HOURS_PER_MONTH)
      const reducePct  = Math.round((1 - ns.cpuActualCores / ns.cpuRequestedCores) * 75)
      const recCpuM    = Math.round(Math.min(ns.cpuRequestedCores, ns.cpuActualCores * 2.2) * 1000)
      const priority   = Math.min(100, Math.round((1 - ns.cpuEfficiency / 100) * 70 + (saving / Math.max(1, ns.costPerMo)) * 30))
      optimizations.push({
        type: 'cpu-over-provisioned', namespace: ns.namespace, workload: '(all workloads)',
        currentCost: ns.costPerMo, savingsPotential: saving,
        reason: `CPU requests ${ns.cpuRequestedCores}c, actual usage ${r2(ns.cpuActualCores)}c (${ns.cpuEfficiency}% efficiency). Wasting ~${r2(cpuWasted)} cores. Reduce CPU requests by ~${reducePct}% to save ${fmt$(saving)}/mo.`,
        severity: 'warning',
        cpuRequested: ns.cpuRequestedCores, cpuActual: r2(ns.cpuActualCores), cpuEfficiency: ns.cpuEfficiency,
        memRequestedGiB: ns.memRequestedGiB, memActualGiB: r2(ns.memActualGiB), memEfficiency: ns.memEfficiency,
        wastedCpuCores: r2(cpuWasted),
        recommendedCpuM: recCpuM,
        cpuSavings: saving, rightSizeSavings: saving,
        podCount: ns.podCount, workloadCount: ns.workloadCount,
        kubectl: `kubectl set resources -n ${ns.namespace} deployment --all --requests=cpu=${recCpuM}m`,
        priorityScore: priority,
      })
    }
  }

  // ?? Per-namespace: memory-specific over-provisioning ???????????????????
  for (const ns of byNamespace) {
    const alreadyFlagged = optimizations.find(o => o.namespace === ns.namespace && (o.type === 'over-provisioned' || o.type === 'cpu-over-provisioned'))
    if (!alreadyFlagged && ns.memEfficiency !== null && ns.memEfficiency < 20 && ns.memRequestedGiB > 0.5) {
      const memWasted  = Math.max(0, ns.memRequestedGiB - ns.memActualGiB)
      const saving     = r2(memWasted * 0.6 * MEM_PER_GIB_HR * HOURS_PER_MONTH)
      const reducePct  = Math.round((1 - ns.memActualGiB / ns.memRequestedGiB) * 75)
      const recMemMiB  = Math.round(Math.min(ns.memRequestedGiB * 1024, ns.memActualGiB * 1024 * 2.2))
      optimizations.push({
        type: 'mem-over-provisioned', namespace: ns.namespace, workload: '(all workloads)',
        currentCost: ns.costPerMo, savingsPotential: saving,
        reason: `Memory requests ${r1(ns.memRequestedGiB)} GiB, actual usage ${r2(ns.memActualGiB)} GiB (${ns.memEfficiency}% efficiency). Wasting ~${r2(memWasted)} GiB. Reduce memory requests by ~${reducePct}%.`,
        severity: 'warning',
        cpuRequested: ns.cpuRequestedCores, cpuActual: r2(ns.cpuActualCores), cpuEfficiency: ns.cpuEfficiency,
        memRequestedGiB: ns.memRequestedGiB, memActualGiB: r2(ns.memActualGiB), memEfficiency: ns.memEfficiency,
        wastedMemGiB: r2(memWasted),
        recommendedMemMiB: recMemMiB,
        memSavings: saving, rightSizeSavings: saving,
        podCount: ns.podCount, workloadCount: ns.workloadCount,
        kubectl: `kubectl set resources -n ${ns.namespace} deployment --all --requests=memory=${recMemMiB}Mi`,
        priorityScore: Math.min(100, Math.round((1 - ns.memEfficiency / 100) * 60 + (saving / Math.max(1, ns.costPerMo)) * 40)),
      })
    }
  }

  // ?? Per-workload: top 5 individual wasters ??????????????????????????????
  // Build per-workload actual usage from Prometheus namespace totals distributed by cost share
  for (const wl of byWorkload.slice(0, 20)) {
    const ns = byNamespace.find(n => n.namespace === wl.namespace)
    if (!ns || ns.overallEfficiency === null) continue
    // Already covered by namespace-level? Only emit if workload is >30% of ns cost and efficiency < 20%
    const wlShareOfNs = ns.costPerMo > 0 ? wl.costPerMo / ns.costPerMo : 0
    if (wlShareOfNs < 0.3 || wl.costPerMo < 2) continue
    const alreadyCovered = optimizations.find(o => o.namespace === wl.namespace && (o.type === 'over-provisioned' || o.type === 'cpu-over-provisioned'))
    if (!alreadyCovered) continue   // no point duplicating if ns not flagged
    if (ns.overallEfficiency >= 20) continue
    // Workload-specific recommendation using ns efficiency as proxy
    const eff = ns.overallEfficiency / 100
    const wlCpuActual = r2(wl.cpuCores * eff)
    const wlMemActual = r2(wl.memGiB   * eff)
    const recCpuM     = Math.round(wl.cpuCores * Math.min(1, eff * 2.2) * 1000)
    const recMemMiB   = Math.round(wl.memGiB   * Math.min(1, eff * 2.2) * 1024)
    const wlSave      = r2(wl.costPerMo * (1 - eff * 2.2) * 0.6)
    if (wlSave < 0.5) continue
    optimizations.push({
      type: 'workload-rightsizing', namespace: wl.namespace, workload: `${wl.kind}/${wl.name}`,
      currentCost: wl.costPerMo, savingsPotential: wlSave,
      reason: `${wl.kind} "${wl.name}" requests ${wl.cpuCores}c CPU / ${wl.memGiB} GiB mem across ${wl.podCount} pod${wl.podCount !== 1 ? 's' : ''}. Estimated actual: ~${wlCpuActual}c / ~${wlMemActual} GiB. Right-size to save ~${fmt$(wlSave)}/mo.`,
      severity: 'info',
      cpuRequested: wl.cpuCores, cpuActual: wlCpuActual, cpuEfficiency: ns.cpuEfficiency,
      memRequestedGiB: wl.memGiB, memActualGiB: wlMemActual, memEfficiency: ns.memEfficiency,
      recommendedCpuM: recCpuM, recommendedMemMiB: recMemMiB,
      rightSizeSavings: wlSave,
      podCount: wl.podCount,
      kubectl: `kubectl set resources -n ${wl.namespace} ${wl.kind.toLowerCase()} ${wl.name} --requests=cpu=${recCpuM}m,memory=${recMemMiB}Mi`,
      priorityScore: Math.round(wlSave / Math.max(1, wl.costPerMo) * 60 + (1 - eff) * 40),
    })
  }

  // ?? Storage near full ????????????????????????????????????????????????????
  for (const pvc of pvcs as any[]) {
    if (pvc.usagePct > 80) {
      const headroomGiB = r2(pvc.capacityGiB - pvc.usedGiB)
      const expandTo    = Math.ceil(pvc.capacityGiB * (pvc.usagePct > 90 ? 2 : 1.5))
      optimizations.push({
        type: 'storage-full', namespace: pvc.namespace, workload: `PVC/${pvc.name}`,
        currentCost: pvc.costPerMo, savingsPotential: 0,
        reason: `${pvc.usagePct}% full ? only ${headroomGiB} GiB remaining of ${pvc.capacityGiB} GiB (${pvc.storageClass}). Expand to ${expandTo} GiB before write errors occur.`,
        severity: pvc.usagePct > 90 ? 'critical' : 'warning',
        kubectl: `kubectl patch pvc ${pvc.name} -n ${pvc.namespace} -p '{"spec":{"resources":{"requests":{"storage":"${expandTo}Gi"}}}}'`,
        priorityScore: pvc.usagePct,
      })
    }
  }

  // ?? Zero-cost workloads: no requests set ????????????????????????????????
  const noReqWorkloads = byWorkload.filter(w => w.costPerMo === 0 && w.podCount > 0).slice(0, 3)
  for (const w of noReqWorkloads) {
    if (!optimizations.find(o => o.namespace === w.namespace && o.type === 'no-requests')) {
      optimizations.push({
        type: 'no-requests', namespace: w.namespace, workload: `${w.kind}/${w.name}`,
        currentCost: 0, savingsPotential: 0,
        reason: `No resource requests set on ${w.kind} "${w.name}" (${w.podCount} pod${w.podCount !== 1 ? 's' : ''}). Add CPU/memory requests for scheduler decisions, HPA, and cost tracking.`,
        severity: 'info',
        podCount: w.podCount,
        kubectl: `kubectl set resources -n ${w.namespace} ${w.kind.toLowerCase()} ${w.name} --requests=cpu=100m,memory=128Mi --limits=cpu=500m,memory=512Mi`,
        priorityScore: 20,
      })
    }
  }

  const sevOrder = { critical: 0, warning: 1, info: 2 }
  optimizations.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || (b.priorityScore ?? 0) - (a.priorityScore ?? 0) || b.savingsPotential - a.savingsPotential)

  function fmt$(n: number) { return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}` }

  return NextResponse.json({
    cluster,
    nodes,
    cost: {
      totalPerMo:    r2(totalCostPerMo + totalStorageCostMo),
      computePerMo:  r2(totalCostPerMo),
      storagePerMo:  r2(totalStorageCostMo),
      wastedPerMo:   r2(totalWastedPerMo),
      cpuEfficiency: overallCpuEff,
      memEfficiency: overallMemEff,
      byNamespace,
      byWorkload: byWorkload.slice(0, 25),
      ratesUsed: { cpuPerCoreHr: CPU_PER_CORE_HR, memPerGiBHr: MEM_PER_GIB_HR, storagePerGiBMo: STORAGE_PER_GIB_MO },
    },
    storage: {
      totalPVCs: pvcs.length,
      totalCapacityGiB: r2(totalStorageCap),
      totalUsedGiB:     r2(totalStorageUsed),
      costPerMo:        r2(totalStorageCostMo),
      pvcs,
    },
    totalPodCount,
    optimizations,
  })
}
