import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl, resolveClusterMeta, K8S_TIMEOUT_MS } from '@/lib/cluster'
import { readConfig } from '@/app/api/settings/config/shared'
import { calculateWeightedEfficiency, getEffectivePodRequests, parseCapGiB } from '../finops-math'

const HOURS_PER_MONTH  = 730
const SKIP_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

// ?? Helpers ??????????????????????????????????????????????????????????????????

function r2(n: number): number { return Math.round(n * 100) / 100 }
function r1(n: number): number { return Math.round(n * 10) / 10 }

async function k8sGet(path: string): Promise<any> {
  const K8S = await resolveK8sUrl()
  if (!K8S) throw new Error('Kubernetes API URL is unavailable')
  const url = new URL(`${K8S}${path}`)
  const items: any[] = []
  for (let page = 0; page < 1000; page++) {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    if (!res.ok) throw new Error(`Kubernetes ${path} returned HTTP ${res.status}`)
    const data = await res.json()
    if (path === '/version') return data
    if (!Array.isArray(data?.items)) throw new Error(`Kubernetes ${path} returned an invalid list`)
    items.push(...data.items)
    const next = data.metadata?.continue
    if (!next) return { ...data, items }
    url.searchParams.set('continue', next)
  }
  throw new Error(`Kubernetes ${path} exceeded the pagination safety limit`)
}

async function promQuery(q: string): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  const PROM = await resolvePromUrl()
  if (!PROM) throw new Error('Prometheus URL is unavailable')
  const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, {
    signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    next: { revalidate: 0 },
  })
  if (!res.ok) throw new Error(`Prometheus query returned HTTP ${res.status}`)
  const body = await res.json()
  if (body?.status !== 'success' || !Array.isArray(body?.data?.result)) throw new Error('Prometheus returned an invalid query response')
  return body.data.result
}

// ?? Route ?????????????????????????????????????????????????????????????????????

export async function GET() {
  // Read cost rates from config (user-configurable) with defaults
  const cfg = readConfig()
  const CPU_PER_CORE_HR    = cfg.finops_cpu_per_core_hr    ?? 0.048
  const MEM_PER_GIB_HR     = cfg.finops_mem_per_gib_hr     ?? 0.006
  const STORAGE_PER_GIB_MO = cfg.finops_storage_per_gib_mo ?? 0.05

  let sourceResults: any[]
  try {
    sourceResults = await Promise.all([
      k8sGet('/version'),
      k8sGet('/api/v1/namespaces'),
      k8sGet('/api/v1/nodes'),
      k8sGet('/api/v1/pods?limit=1000'),
      k8sGet('/api/v1/persistentvolumeclaims?limit=500'),
      promQuery('sum by(namespace) (rate(container_cpu_usage_seconds_total{namespace!="",container!="POD",container!=""}[5m]) or rate(container_cpu_usage_seconds_total{namespace!="",container!="POD",image!=""}[5m]))'),
      promQuery('sum by(namespace) (container_memory_working_set_bytes{namespace!="",container!="POD",container!=""} or container_memory_working_set_bytes{namespace!="",container!="POD",image!=""})'),
      promQuery('kube_node_status_allocatable{resource="cpu"}'),
      promQuery('kube_node_status_allocatable{resource="memory"}'),
      promQuery('kube_node_status_condition{condition="Ready",status="true"}'),
      promQuery('node_memory_MemAvailable_bytes'),
      promQuery('node_memory_MemTotal_bytes'),
      promQuery('1 - avg by(node, instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))'),
      promQuery('count by(node) (kube_pod_info{node!=""})'),
      promQuery('kubelet_volume_stats_used_bytes'),
      promQuery('kubelet_volume_stats_capacity_bytes'),
      promQuery('node_time_seconds - node_boot_time_seconds'),
      promQuery('kube_node_status_allocatable{resource="pods"}'),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown FinOps source error'
    return NextResponse.json({ error: `FinOps data unavailable: ${message}`, sourceStatus: 'unavailable' }, { status: 502 })
  }

  const [
    versionData, nsData, nodesData, podsData, pvcData,
    cpuUsageByNs, memUsageByNs,
    cpuAllocatable, memAllocatable,
    nodeConditions, memAvailRaw, memTotalRaw,
    cpuNodeUsage, podCountsRaw,
    volUsedRaw, volCapRaw,
    nodeUptimeRaw,
    podAllocatable,
  ] = sourceResults

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

  const knownNodeNames = new Set(((nodesData as any)?.items ?? []).map((item: any) => item.metadata?.name).filter(Boolean))
  for (const sample of cpuNodeUsage) {
    const nodeFromInstance = sample.metric?.instance ? resolveInst(sample.metric.instance) : ''
    const nodeName = knownNodeNames.has(sample.metric?.node) ? sample.metric.node : nodeFromInstance
    if (nodeName && knownNodeNames.has(nodeName)) cpuUsageByNodeMap[nodeName] = parseFloat(sample.value[1])
  }

  const memAvailByNode: Record<string, number> = {}
  const memTotalByNode: Record<string, number> = {}
  const uptimeByNode:   Record<string, number> = {}
  for (const r of memAvailRaw)  memAvailByNode[resolveInst(r.metric.instance)]  = parseFloat(r.value[1]) / (1024 ** 3)
  for (const r of memTotalRaw)  memTotalByNode[resolveInst(r.metric.instance)]  = parseFloat(r.value[1]) / (1024 ** 3)
  for (const r of nodeUptimeRaw) uptimeByNode[resolveInst(r.metric.instance)]   = parseFloat(r.value[1]) / 3600

  const missingNodeMetrics = ((nodesData as any)?.items ?? []).flatMap((item: any) => {
    const name = item.metadata?.name ?? ''
    const missing: string[] = []
    if (!name || !(cpuAllocByNode[name] > 0)) missing.push('allocatable CPU')
    if (!name || !(memAllocByNode[name] > 0)) missing.push('allocatable memory')
    if (!name || !Object.prototype.hasOwnProperty.call(memAvailByNode, name) || !Object.prototype.hasOwnProperty.call(memTotalByNode, name) || !(memTotalByNode[name] > 0)) missing.push('memory usage')
    return missing.length ? [`${name || 'unnamed node'}: ${missing.join(', ')}`] : []
  })
  if (missingNodeMetrics.length > 0) {
    return NextResponse.json({ error: `Node capacity or memory data is incomplete (${missingNodeMetrics.join('; ')})`, sourceStatus: 'incomplete' }, { status: 502 })
  }
  const missingCpuUsageNodes = ((nodesData as any)?.items ?? [])
    .map((item: any) => item.metadata?.name as string | undefined)
    .filter((name: string | undefined): name is string => !!name && !Object.prototype.hasOwnProperty.call(cpuUsageByNodeMap, name))

  const nodes = ((nodesData as any)?.items ?? []).map((item: any) => {
    const name: string = item.metadata?.name ?? ''
    const labels: Record<string, string> = item.metadata?.labels ?? {}
    const cpuCores  = cpuAllocByNode[name] ?? 0
    const memGiB    = memAllocByNode[name] ?? 0
    const cpuUsageRatio = cpuUsageByNodeMap[name]
    const memTotal  = memTotalByNode[name] ?? memGiB
    const memAvail  = memAvailByNode[name] ?? memGiB
    const cpuUsagePct = cpuCores > 0 && cpuUsageRatio !== undefined ? r1(Math.min(100, cpuUsageRatio * 100)) : null
    const memUsedGiB = Math.max(0, memTotal - memAvail)
    const memUsagePct = memGiB > 0 ? r1(Math.min(100, memUsedGiB / memGiB * 100)) : 0

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
    const { cpuMillis, memMiB } = getEffectivePodRequests(pod)
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
    const cpuActual = Object.prototype.hasOwnProperty.call(cpuActualByNs, ns) ? cpuActualByNs[ns]! : null
    const memActual = Object.prototype.hasOwnProperty.call(memActualByNs, ns) ? memActualByNs[ns]! : null
    const costPerMo = r2((cpuReq * CPU_PER_CORE_HR + memReq * MEM_PER_GIB_HR) * HOURS_PER_MONTH)

    // Missing usage series means unknown, not zero utilization.
    const cpuEfficiency = cpuReq > 0 && cpuActual !== null ? Math.min(100, Math.round(cpuActual / cpuReq * 100)) : null
    const memEfficiency = memReq > 0 && memActual !== null ? Math.min(100, Math.round(memActual / memReq * 100)) : null
    const overallEfficiency = calculateWeightedEfficiency({
      cpuRequested: cpuReq, cpuActual,
      memoryRequestedGiB: memReq, memoryActualGiB: memActual,
      cpuRate: CPU_PER_CORE_HR, memoryRate: MEM_PER_GIB_HR,
    })

    // Waste = requested but not used
    const cpuWastedCores = cpuActual === null ? (cpuReq === 0 ? 0 : null) : cpuReq > 0 ? Math.max(0, cpuReq - cpuActual) : 0
    const memWastedGiB   = memActual === null ? (memReq === 0 ? 0 : null) : memReq > 0 ? Math.max(0, memReq - memActual) : 0
    const wastedPerMo    = cpuWastedCores === null || memWastedGiB === null ? null : r2((cpuWastedCores * CPU_PER_CORE_HR + memWastedGiB * MEM_PER_GIB_HR) * HOURS_PER_MONTH)
    const costSharePct   = totalCostPerMo > 0 ? r1(costPerMo / totalCostPerMo * 100) : 0

    return {
      namespace: ns,
      workloadCount: v.workloadCount,
      podCount: v.podCount,
      cpuRequestedCores: r2(cpuReq),
      memRequestedGiB:   r2(memReq),
      cpuActualCores:    cpuActual === null ? null : r2(cpuActual),
      memActualGiB:      memActual === null ? null : r2(memActual),
      cpuEfficiency,
      memEfficiency,
      overallEfficiency,
      costPerMo,
      wastedPerMo,
      costSharePct,
    }
  }).sort((a, b) => b.costPerMo - a.costPerMo)

  const usageComplete = byNamespace.every(n => n.wastedPerMo !== null)
  const totalWastedPerMo  = usageComplete ? byNamespace.reduce((s, n) => s + (n.wastedPerMo ?? 0), 0) : null
  const nsWithEff         = byNamespace.filter(n => n.overallEfficiency !== null)
  const cpuReqTotal = byNamespace.reduce((sum, ns) => sum + ns.cpuRequestedCores, 0)
  const memReqTotal = byNamespace.reduce((sum, ns) => sum + ns.memRequestedGiB, 0)
  const cpuUsageComplete = byNamespace.every(ns => ns.cpuRequestedCores === 0 || ns.cpuActualCores !== null)
  const memUsageComplete = byNamespace.every(ns => ns.memRequestedGiB === 0 || ns.memActualGiB !== null)
  const overallCpuEff = cpuUsageComplete && cpuReqTotal > 0
    ? Math.min(100, Math.round(byNamespace.reduce((sum, ns) => sum + (ns.cpuActualCores ?? 0), 0) / cpuReqTotal * 100)) : null
  const overallMemEff = memUsageComplete && memReqTotal > 0
    ? Math.min(100, Math.round(byNamespace.reduce((sum, ns) => sum + (ns.memActualGiB ?? 0), 0) / memReqTotal * 100)) : null
  const overallResourceEfficiency = calculateWeightedEfficiency({
    cpuRequested: cpuReqTotal,
    cpuActual: cpuUsageComplete ? byNamespace.reduce((sum, ns) => sum + (ns.cpuActualCores ?? 0), 0) : null,
    memoryRequestedGiB: memReqTotal,
    memoryActualGiB: memUsageComplete ? byNamespace.reduce((sum, ns) => sum + (ns.memActualGiB ?? 0), 0) : null,
    cpuRate: CPU_PER_CORE_HR,
    memoryRate: MEM_PER_GIB_HR,
  })

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
    const status       = pvc.status?.phase ?? 'Unknown'
    const isBound      = status === 'Bound'
    const hasUsage      = Object.prototype.hasOwnProperty.call(volUsedMap, key)
    const usedGiB      = isBound && hasUsage ? r2(volUsedMap[key]!) : null
    const capFromProm  = volCapMap[key] ?? 0
    const usageCapacityGiB = capFromProm > 0 ? capFromProm : capacityGiB
    const usagePct     = usedGiB !== null && usageCapacityGiB > 0 ? Math.min(100, Math.round(usedGiB / usageCapacityGiB * 100)) : null
    const costPerMo    = isBound ? r2(capacityGiB * STORAGE_PER_GIB_MO) : 0
    return {
      name, namespace: ns,
      capacityGiB: r2(capacityGiB),
      usedGiB,
      usagePct,
      storageClass: sc,
      status,
      costPerMo,
    }
  }).sort((a: any, b: any) => b.costPerMo - a.costPerMo)

  const boundPvcs = pvcs.filter((pvc: any) => pvc.status === 'Bound')
  const storageUsageComplete = boundPvcs.every((pvc: any) => pvc.usedGiB !== null)
  const totalStorageCap    = boundPvcs.reduce((s: number, p: any) => s + p.capacityGiB, 0)
  const totalStorageUsed   = storageUsageComplete ? boundPvcs.reduce((s: number, p: any) => s + (p.usedGiB ?? 0), 0) : null
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
    missingCpuRequests?: boolean; missingMemoryRequests?: boolean
    kubectl?: string
    priorityScore?: number  // 0-100, higher = act first
  }
  const optimizations: Opt[] = []

  // ?? Per-namespace: severe over-provisioning ??????????????????????????????
  for (const ns of byNamespace) {
    if (ns.overallEfficiency !== null && ns.cpuActualCores !== null && ns.memActualGiB !== null && ns.wastedPerMo !== null && ns.overallEfficiency < 25 && ns.costPerMo > 3) {
      const sev: 'critical' | 'warning' = ns.overallEfficiency < 10 ? 'critical' : 'warning'
      const cpuWasted  = Math.max(0, ns.cpuRequestedCores - ns.cpuActualCores)
      const memWasted  = Math.max(0, ns.memRequestedGiB   - ns.memActualGiB)
      const cpuSave    = r2(cpuWasted * 0.6 * CPU_PER_CORE_HR * HOURS_PER_MONTH)  // conservative 60% of waste
      const memSave    = r2(memWasted * 0.6 * MEM_PER_GIB_HR  * HOURS_PER_MONTH)
      const totalSave  = r2(cpuSave + memSave)
      const priority   = Math.min(100, Math.round((1 - ns.overallEfficiency / 100) * 80 + (totalSave / Math.max(1, ns.costPerMo)) * 20))
      optimizations.push({
        type: 'over-provisioned', namespace: ns.namespace, workload: '(all workloads)',
        currentCost: ns.costPerMo, savingsPotential: totalSave,
        reason: `Namespace-level requests exceed the current usage sample across ${ns.workloadCount} workloads (${ns.podCount} pods). Estimated request-cost reduction is ${fmt$(totalSave)}/mo; validate peak usage and calculate targets per workload before changing requests.`,
        severity: sev,
        cpuRequested: ns.cpuRequestedCores, cpuActual: r2(ns.cpuActualCores), cpuEfficiency: ns.cpuEfficiency,
        memRequestedGiB: ns.memRequestedGiB, memActualGiB: r2(ns.memActualGiB), memEfficiency: ns.memEfficiency,
        wastedCpuCores: r2(cpuWasted), wastedMemGiB: r2(memWasted),
        rightSizeSavings: totalSave, cpuSavings: cpuSave, memSavings: memSave,
        podCount: ns.podCount, workloadCount: ns.workloadCount,
        priorityScore: priority,
      })
    }

  }

  // ?? Per-namespace: CPU-specific over-provisioning ??????????????????????
  for (const ns of byNamespace) {
    const alreadyFlagged = optimizations.find(o => o.namespace === ns.namespace && o.type === 'over-provisioned')
    if (!alreadyFlagged && ns.cpuEfficiency !== null && ns.cpuActualCores !== null && ns.memActualGiB !== null && ns.cpuEfficiency < 20 && ns.cpuRequestedCores > 1) {
      const cpuWasted  = Math.max(0, ns.cpuRequestedCores - ns.cpuActualCores)
      const saving     = r2(cpuWasted * 0.6 * CPU_PER_CORE_HR * HOURS_PER_MONTH)
      const priority   = Math.min(100, Math.round((1 - ns.cpuEfficiency / 100) * 70 + (saving / Math.max(1, ns.costPerMo)) * 30))
      optimizations.push({
        type: 'cpu-over-provisioned', namespace: ns.namespace, workload: '(all workloads)',
        currentCost: ns.costPerMo, savingsPotential: saving,
        reason: `Namespace CPU requests are ${ns.cpuRequestedCores}c versus a current usage sample of ${r2(ns.cpuActualCores)}c (${ns.cpuEfficiency}% efficiency). Estimated request-cost reduction is ${fmt$(saving)}/mo; validate peak usage and calculate targets per workload before changing requests.`,
        severity: 'warning',
        cpuRequested: ns.cpuRequestedCores, cpuActual: r2(ns.cpuActualCores), cpuEfficiency: ns.cpuEfficiency,
        memRequestedGiB: ns.memRequestedGiB, memActualGiB: r2(ns.memActualGiB), memEfficiency: ns.memEfficiency,
        wastedCpuCores: r2(cpuWasted),
        cpuSavings: saving, rightSizeSavings: saving,
        podCount: ns.podCount, workloadCount: ns.workloadCount,
        priorityScore: priority,
      })
    }
  }

  // ?? Per-namespace: memory-specific over-provisioning ???????????????????
  for (const ns of byNamespace) {
    const alreadyFlagged = optimizations.find(o => o.namespace === ns.namespace && (o.type === 'over-provisioned' || o.type === 'cpu-over-provisioned'))
    if (!alreadyFlagged && ns.memEfficiency !== null && ns.cpuActualCores !== null && ns.memActualGiB !== null && ns.memEfficiency < 20 && ns.memRequestedGiB > 0.5) {
      const memWasted  = Math.max(0, ns.memRequestedGiB - ns.memActualGiB)
      const saving     = r2(memWasted * 0.6 * MEM_PER_GIB_HR * HOURS_PER_MONTH)
      optimizations.push({
        type: 'mem-over-provisioned', namespace: ns.namespace, workload: '(all workloads)',
        currentCost: ns.costPerMo, savingsPotential: saving,
        reason: `Namespace memory requests are ${r1(ns.memRequestedGiB)} GiB versus a current usage sample of ${r2(ns.memActualGiB)} GiB (${ns.memEfficiency}% efficiency). Estimated request-cost reduction is ${fmt$(saving)}/mo; validate peak usage and calculate targets per workload before changing requests.`,
        severity: 'warning',
        cpuRequested: ns.cpuRequestedCores, cpuActual: r2(ns.cpuActualCores), cpuEfficiency: ns.cpuEfficiency,
        memRequestedGiB: ns.memRequestedGiB, memActualGiB: r2(ns.memActualGiB), memEfficiency: ns.memEfficiency,
        wastedMemGiB: r2(memWasted),
        memSavings: saving, rightSizeSavings: saving,
        podCount: ns.podCount, workloadCount: ns.workloadCount,
        priorityScore: Math.min(100, Math.round((1 - ns.memEfficiency / 100) * 60 + (saving / Math.max(1, ns.costPerMo)) * 40)),
      })
    }
  }

  // ?? Storage near full ????????????????????????????????????????????????????
  for (const pvc of pvcs as any[]) {
    if (pvc.status === 'Bound' && pvc.usagePct !== null && pvc.usagePct > 80) {
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

  const missingRequestWorkloads = byWorkload.filter(w => w.podCount > 0 && (w.cpuCores === 0 || w.memGiB === 0))
  for (const workload of missingRequestWorkloads) {
    const missingCpuRequests = workload.cpuCores === 0
    const missingMemoryRequests = workload.memGiB === 0
    optimizations.push({
      type: 'no-requests', namespace: workload.namespace, workload: `${workload.kind}/${workload.name}`,
      currentCost: workload.costPerMo, savingsPotential: 0,
      reason: `Missing ${[missingCpuRequests && 'CPU', missingMemoryRequests && 'memory'].filter(Boolean).join(' and ')} requests on ${workload.kind} "${workload.name}" across ${workload.podCount} pods. Set workload-appropriate values for scheduling, autoscaling, and cost attribution.`,
      severity: 'warning',
      podCount: workload.podCount,
      missingCpuRequests,
      missingMemoryRequests,
      priorityScore: 40,
    })
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
      wastedPerMo:   totalWastedPerMo === null ? null : r2(totalWastedPerMo),
      cpuEfficiency: overallCpuEff,
      memEfficiency: overallMemEff,
      resourceEfficiency: overallResourceEfficiency,
      usageComplete,
      byNamespace,
      byWorkload: byWorkload.slice(0, 25),
      ratesUsed: { cpuPerCoreHr: CPU_PER_CORE_HR, memPerGiBHr: MEM_PER_GIB_HR, storagePerGiBMo: STORAGE_PER_GIB_MO },
    },
    storage: {
      totalPVCs: pvcs.length,
      totalCapacityGiB: r2(totalStorageCap),
      totalUsedGiB:     totalStorageUsed === null ? null : r2(totalStorageUsed),
      usageComplete: storageUsageComplete,
      costPerMo:        r2(totalStorageCostMo),
      pvcs,
    },
    totalPodCount,
    optimizations,
    dataQuality: { scanComplete: true, usageComplete, storageUsageComplete, nodeUsageComplete: missingCpuUsageNodes.length === 0, missingCpuUsageNodes },
  })
}
