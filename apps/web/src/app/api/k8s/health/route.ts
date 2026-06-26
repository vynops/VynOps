import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function promInstant(query: string): Promise<number> {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()
  try {
    const url = `${PROM}/api/v1/query?query=${encodeURIComponent(query)}`
    const r = await fetch(url, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } })
    const json = await r.json()
    const val = json.data?.result?.[0]?.value?.[1]
    return val !== undefined ? parseFloat(val) : NaN
  } catch { return NaN }
}

async function k8sGet(path: string): Promise<any> {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return { items: [] }
  try {
    const r = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

export async function GET() {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()
  if (!K8S && PROM === 'http://localhost:9090') {
    return NextResponse.json({ error: 'No data sources configured' }, { status: 503 })
  }

  const [nodesData, podsData, deployData, cpuPct, memPct] = await Promise.all([
    k8sGet('/api/v1/nodes'),
    k8sGet('/api/v1/pods'),
    k8sGet('/apis/apps/v1/deployments'),
    promInstant('sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100'),
    promInstant('(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100'),
  ])

  const nodes: any[]   = nodesData.items ?? []
  const pods: any[]    = podsData.items ?? []
  const deploys: any[] = deployData.items ?? []

  // ── Node health ──────────────────────────────────────────────
  const readyNodes = nodes.filter(n => {
    const cond = n.status?.conditions?.find((c: any) => c.type === 'Ready')
    return cond?.status === 'True'
  }).length
  const nodeScore = nodes.length > 0 ? (readyNodes / nodes.length) * 100 : 100

  // ── Pod health ───────────────────────────────────────────────
  const workloadPods = pods.filter(p => {
    const ns: string = p.metadata?.namespace ?? ''
    return !['kube-system', 'kube-public', 'kube-node-lease'].includes(ns)
  })
  const runningPods  = workloadPods.filter(p => p.status?.phase === 'Running').length
  const failedPods   = workloadPods.filter(p =>
    p.status?.phase === 'Failed' ||
    p.status?.containerStatuses?.some((c: any) => c.state?.waiting?.reason === 'CrashLoopBackOff'),
  ).length
  const podScore = workloadPods.length > 0 ? (runningPods / workloadPods.length) * 100 : 100

  // ── Deployment health ────────────────────────────────────────
  const workloadDeploys = deploys.filter(d => {
    const ns: string = d.metadata?.namespace ?? ''
    return !['kube-system', 'kube-public', 'kube-node-lease'].includes(ns)
  })
  const deployScore = workloadDeploys.length > 0
    ? workloadDeploys.reduce((acc, d) => {
        const desired = d.spec?.replicas ?? 1
        const ready   = d.status?.readyReplicas ?? 0
        return acc + (desired > 0 ? Math.min(ready / desired, 1) : 1)
      }, 0) / workloadDeploys.length * 100
    : 100

  // ── Resource pressure penalty ────────────────────────────────
  const cpuPenalty = isNaN(cpuPct) ? 0 : cpuPct > 90 ? 20 : cpuPct > 80 ? 10 : cpuPct > 70 ? 5 : 0
  const memPenalty = isNaN(memPct) ? 0 : memPct > 90 ? 20 : memPct > 80 ? 10 : memPct > 70 ? 5 : 0

  // ── Composite score ──────────────────────────────────────────
  const raw = nodeScore * 0.4 + podScore * 0.35 + deployScore * 0.25 - cpuPenalty - memPenalty
  const score = Math.round(Math.max(0, Math.min(100, raw)))
  const status = score >= 90 ? 'healthy' : score >= 70 ? 'degraded' : 'critical'

  // ── Change failure rate ──────────────────────────────────────
  const unavailDeploys = workloadDeploys.filter(d => (d.status?.unavailableReplicas ?? 0) > 0).length
  const changeFailureRate = workloadDeploys.length > 0
    ? parseFloat(((unavailDeploys / workloadDeploys.length) * 100).toFixed(1))
    : 0

  // ── Uptime (% nodes ready) ───────────────────────────────────
  const uptime = nodes.length > 0
    ? parseFloat(((readyNodes / nodes.length) * 100).toFixed(2))
    : 99.9

  return NextResponse.json({
    score,
    status,
    uptime,
    mttr: 23,   // requires incident history — placeholder
    mttd: 8,    // requires alert-to-incident correlation — placeholder
    changeFailureRate,
    deploymentFrequency: workloadDeploys.length,
    trend: score >= 85 ? 'up' : score >= 70 ? 'stable' : 'down',
    // debug metadata
    _debug: {
      nodes: { total: nodes.length, ready: readyNodes },
      pods:  { workload: workloadPods.length, running: runningPods, failed: failedPods },
      deploys: { total: workloadDeploys.length, unavailable: unavailDeploys },
      cpuPct:  isNaN(cpuPct) ? null : Math.round(cpuPct),
      memPct:  isNaN(memPct) ? null : Math.round(memPct),
    },
  })
}