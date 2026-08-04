import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl, resolveClusterMeta, K8S_TIMEOUT_MS } from '@/lib/cluster'

const CPU_PER_CORE_HR  = 0.048
const MEM_PER_GIB_HR   = 0.006
const HOURS_PER_MONTH  = 730
const SKIP_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

// -- Helpers ---------------------------------------------------

async function pq(query: string): Promise<any[]> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    const j = await r.json()
    return j?.data?.result ?? []
  } catch { return [] }
}

async function k8sGet(path: string): Promise<any> {
  const K8S = await resolveK8sUrl()
  try {
    const r = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

function parseCpu(s?: string): number {
  if (!s) return 0
  if (s.endsWith('m')) return parseInt(s) / 1000
  return parseFloat(s)
}

function parseMem(s?: string): number {
  if (!s) return 0
  if (s.endsWith('Ki')) return parseInt(s) / (1024 ** 2)
  if (s.endsWith('Mi')) return parseInt(s) / 1024
  if (s.endsWith('Gi')) return parseFloat(s)
  if (s.endsWith('Ti')) return parseFloat(s) * 1024
  return parseInt(s) / (1024 ** 3)
}

const SEV_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0, info: 0 }

// -- GET -------------------------------------------------------

export async function GET(req: Request) {
  const now = Date.now()
  const url = new URL(req.url)
  const windowMin = Math.max(60, parseInt(url.searchParams.get('window') ?? '10080'))
  const windowMs = windowMin * 60 * 1000
  const sevenDaysAgo = now - windowMs

  const [clusterMeta, [
    versionData, nodesData, podsData, deploysData, rsData,
    alertsFiring, alertsForState,
    cpuRequestedRaw, memRequestedRaw,
    cpuActualRaw, memAvailRaw, memTotalRaw,
  ]] = await Promise.all([
    resolveClusterMeta(),
    Promise.all([
    k8sGet('/version'),
    k8sGet('/api/v1/nodes'),
    k8sGet('/api/v1/pods?limit=500'),
    k8sGet('/apis/apps/v1/deployments?limit=200'),
    k8sGet('/apis/apps/v1/replicasets?limit=500'),
    pq('ALERTS{alertstate="firing"}'),
    pq('ALERTS_FOR_STATE'),
    pq('sum(kube_pod_container_resource_requests{resource="cpu",namespace!=""})'),
    pq('sum(kube_pod_container_resource_requests{resource="memory",namespace!=""})'),
    pq('sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100'),
    pq('node_memory_MemAvailable_bytes'),
    pq('node_memory_MemTotal_bytes'),
  ])])

  // -- 1. Cluster basics -----------------------------------------
  const nodes: any[]   = nodesData?.items ?? []
  const pods: any[]    = podsData?.items  ?? []
  const deploys: any[] = deploysData?.items ?? []
  const rsList: any[]  = rsData?.items ?? []

  const healthyNodes = nodes.filter(n =>
    n.status?.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True'
  ).length

  const workloadPods = pods.filter(p => !SKIP_NS.has(p.metadata?.namespace ?? ''))
  const runningPods  = workloadPods.filter(p => p.status?.phase === 'Running').length
  const crashPods    = workloadPods.filter(p =>
    p.status?.containerStatuses?.some((c: any) => c.state?.waiting?.reason === 'CrashLoopBackOff')
  ).length

  const cluster = {
    name:            clusterMeta?.name     ?? '—',
    provider:        clusterMeta?.provider ?? '—',
    region:          clusterMeta?.region   ?? '',
    version:         (versionData as any)?.gitVersion ?? '—',
    nodeCount:       nodes.length,
    healthyNodes,
    podCount:        pods.length,
    workloadPods:    workloadPods.length,
    runningPods,
    crashPods,
    deploymentCount: deploys.filter(d => !SKIP_NS.has(d.metadata?.namespace ?? '')).length,
  }

  // -- 2. Cost KPI -----------------------------------------------
  const cpuActualPct  = parseFloat(cpuActualRaw[0]?.value?.[1] ?? '0')
  const memAvail      = (memAvailRaw[0]?.value?.[1] ?? '0')
  const memTotal      = (memTotalRaw[0]?.value?.[1] ?? '0')
  const memUsedPct    = parseFloat(memTotal) > 0
    ? (1 - parseFloat(memAvail) / parseFloat(memTotal)) * 100 : 0

  // CPU requested from kube-state-metrics (in cores)
  const cpuReqCores = parseFloat(cpuRequestedRaw[0]?.value?.[1] ?? '0')
  const memReqGiB   = parseFloat(memRequestedRaw[0]?.value?.[1] ?? '0') / (1024 ** 3)
  const cpuActCores = cpuReqCores > 0
    ? cpuReqCores * (cpuActualPct / 100)
    : parseFloat(cpuActualRaw[0]?.value?.[1] ?? '0') / 100

  const computeCostPerMo  = (cpuReqCores * CPU_PER_CORE_HR + memReqGiB * MEM_PER_GIB_HR) * HOURS_PER_MONTH
  const cpuEfficiency     = cpuReqCores > 0 ? Math.min(100, Math.round(cpuActualPct / 100 * cpuReqCores / cpuReqCores * 100)) : Math.round(cpuActualPct)
  const memEfficiency     = memTotal ? Math.round(memUsedPct) : 0
  const cpuWastedCores    = Math.max(0, cpuReqCores - cpuActCores)
  const memWastedGiB      = Math.max(0, memReqGiB * (1 - memUsedPct / 100))
  const wastedPerMo       = (cpuWastedCores * CPU_PER_CORE_HR + memWastedGiB * MEM_PER_GIB_HR) * HOURS_PER_MONTH

  const cost = {
    totalPerMo:     Math.round(computeCostPerMo * 100) / 100,
    wastedPerMo:    Math.round(wastedPerMo * 100) / 100,
    cpuEfficiency:  Math.round(cpuActualPct),
    memEfficiency:  Math.round(memUsedPct),
    cpuPct:         Math.round(cpuActualPct * 10) / 10,
    memPct:         Math.round(memUsedPct * 10) / 10,
  }

  // -- 3. DORA from ReplicaSets ---------------------------------
  const workloadRSes = rsList.filter(rs => {
    const ns = rs.metadata?.namespace ?? ''
    if (SKIP_NS.has(ns)) return false
    const desired = rs.spec?.replicas ?? 0
    return desired > 0
  })

  const recentRSes    = workloadRSes.filter(rs => {
    const t = new Date(rs.metadata?.creationTimestamp ?? 0).getTime()
    return t > sevenDaysAgo
  })

  const windowDays = windowMin / (60 * 24)
  const deployFrequency7d  = windowDays > 0 ? recentRSes.length / windowDays : 0
  const deployFrequency30d = deployFrequency7d  // kept for compat

  const totalWorkloadDeploys = deploys.filter(d => !SKIP_NS.has(d.metadata?.namespace ?? ''))
  const unavailDeploys = totalWorkloadDeploys.filter(d => (d.status?.unavailableReplicas ?? 0) > 0)
  const changeFailureRate = totalWorkloadDeploys.length > 0
    ? Math.round((unavailDeploys.length / totalWorkloadDeploys.length) * 100) : 0
  const successRate = 100 - changeFailureRate

  function doraFreqBand(freq: number): string {
    if (freq >= 1)    return 'elite'
    if (freq >= 1/7)  return 'high'
    if (freq >= 1/30) return 'medium'
    return 'low'
  }
  const frequencyBand = doraFreqBand(deployFrequency7d)

  const dora = {
    deployFrequency7d:  Math.round(deployFrequency7d * 100) / 100,
    deployFrequency30d: Math.round(deployFrequency30d * 100) / 100,
    successRate,
    changeFailureRate,
    totalDeploys:   totalWorkloadDeploys.length,
    recentDeploys:  recentRSes.length,
    frequencyBand,
    cfrBand: changeFailureRate < 5 ? 'elite' : changeFailureRate < 15 ? 'high' : changeFailureRate < 30 ? 'medium' : 'low',
  }

  // -- 4. Alert summary -----------------------------------------
  const realAlerts = alertsFiring.filter(
    r => r.metric?.alertname !== 'Watchdog' && r.metric?.severity !== 'none'
  )
  const criticalAlerts = realAlerts.filter(r => r.metric?.severity === 'critical').length

  // Longest-running alert duration
  const startMap: Record<string, number> = {}
  for (const r of alertsForState) {
    const name = r.metric?.alertname
    if (name && name !== 'Watchdog') startMap[name] = parseFloat(r.value[1]) * 1000
  }
  const oldestAlertMs = Object.values(startMap).length > 0 ? Math.min(...Object.values(startMap)) : 0
  const oldestAlertDays = oldestAlertMs > 0
    ? Math.round((now - oldestAlertMs) / (24 * 3600 * 1000))
    : 0

  // -- 5. Computed insights -------------------------------------
  type Insight = {
    id: string; type: string; title: string; description: string
    severity: 'critical' | 'high' | 'medium' | 'info'; action?: string
  }
  const insights: Insight[] = []

  // Alert duration insight
  if (realAlerts.length > 0 && oldestAlertDays > 0) {
    insights.push({
      id: 'ins-alert-age',
      type: 'alert',
      title: `${criticalAlerts} critical alert${criticalAlerts !== 1 ? 's' : ''} firing for ${oldestAlertDays}+ days`,
      description: `Alerts: ${realAlerts.map(r => r.metric?.alertname).join(', ')}. SLA has been exceeded — investigate Prometheus scrape config for these targets.`,
      severity: 'critical',
      action: '/incidents',
    })
  }

  // CPU efficiency
  const cpuPctVal = Math.round(cpuActualPct)
  if (cpuPctVal < 15) {
    insights.push({
      id: 'ins-cpu-idle',
      type: 'cost',
      title: `CPU utilization: ${cpuPctVal}% — cluster over-provisioned`,
      description: `Only ${cpuPctVal}% of cluster CPU is being used. Review resource requests to reduce waste and lower compute costs.`,
      severity: cpuPctVal < 10 ? 'high' : 'medium',
      action: '/finops',
    })
  } else if (cpuPctVal > 80) {
    insights.push({
      id: 'ins-cpu-high',
      type: 'performance',
      title: `CPU utilization: ${cpuPctVal}% — approaching saturation`,
      description: `High CPU utilization may cause pod throttling or scheduling failures. Consider scaling out nodes.`,
      severity: 'high',
      action: '/kubernetes',
    })
  } else {
    insights.push({
      id: 'ins-cpu-ok',
      type: 'info',
      title: `CPU utilization healthy: ${cpuPctVal}%`,
      description: `CPU usage is within normal operating range with adequate headroom.`,
      severity: 'info',
    })
  }

  // Memory efficiency
  const memPctVal = Math.round(memUsedPct)
  if (memPctVal < 20) {
    insights.push({
      id: 'ins-mem-idle',
      type: 'cost',
      title: `Memory utilization: ${memPctVal}% — significant headroom available`,
      description: `${100 - memPctVal}% of memory is unused. You can increase pod density or reduce node memory allocation.`,
      severity: 'medium',
      action: '/finops',
    })
  } else if (memPctVal > 85) {
    insights.push({
      id: 'ins-mem-pressure',
      type: 'performance',
      title: `Memory pressure: ${memPctVal}% — near capacity`,
      description: `High memory utilization risk causing OOMKill events. Review memory limits and requests.`,
      severity: 'critical',
      action: '/kubernetes',
    })
  }

  // CrashLoopBackOff pods
  if (crashPods > 0) {
    insights.push({
      id: 'ins-crash',
      type: 'reliability',
      title: `${crashPods} pod${crashPods !== 1 ? 's' : ''} in CrashLoopBackOff`,
      description: `Pods are repeatedly failing to start. Check container logs for root cause.`,
      severity: 'high',
      action: '/kubernetes',
    })
  }

  // DORA frequency
  if (frequencyBand === 'medium' || frequencyBand === 'low') {
    insights.push({
      id: 'ins-dora-freq',
      type: 'dora',
      title: `Deploy frequency: ${dora.frequencyBand} (${dora.recentDeploys} in 7d)`,
      description: `Elite teams deploy daily or more. Increase deployment frequency with smaller, incremental changes to improve DORA metrics.`,
      severity: 'medium',
      action: '/deployments',
    })
  } else {
    insights.push({
      id: 'ins-dora-elite',
      type: 'dora',
      title: `Deploy frequency: ${dora.frequencyBand} (${dora.recentDeploys} in 7d)`,
      description: `Good deployment cadence. Maintain small, frequent deployments for optimal DORA performance.`,
      severity: 'info',
    })
  }

  // Sort insights by severity
  insights.sort((a, b) => (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0))

  return NextResponse.json({
    cluster,
    cost,
    dora,
    alertSummary: {
      total: realAlerts.length,
      critical: criticalAlerts,
      oldestAlertDays,
    },
    insights: insights.slice(0, 5),
    lastUpdated: new Date(now).toISOString(),
  })
}
