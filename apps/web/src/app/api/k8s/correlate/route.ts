import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()
  if (!K8S) return { items: [] }
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), headers: { Accept: 'application/json' } })
    return r.json()
  } catch { return { items: [] } }
}

async function promQuery(q: string) {
  const PROM = await resolvePromUrl()
  if (!PROM) return []
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    const j = await r.json()
    return j.data?.result ?? []
  } catch { return [] }
}

async function promRange(q: string, start: number, end: number, step = 60): Promise<{ ts: number; value: number }[]> {
  const PROM = await resolvePromUrl()
  if (!PROM) return []
  try {
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`
    const r = await fetch(url, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    const j = await r.json()
    return (j.data?.result?.[0]?.values ?? []).map((v: any[]) => ({ ts: v[0] * 1000, value: parseFloat(v[1]) }))
  } catch { return [] }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const pod = searchParams.get('pod')
  const namespace = searchParams.get('namespace') ?? 'default'
  const window = parseInt(searchParams.get('window') ?? '3600')

  if (!pod) return NextResponse.json({ error: 'pod param required' }, { status: 400 })

  const now = Math.floor(Date.now() / 1000)
  const start = now - window

  // Fetch all signals concurrently
  const [
    cpuHistory,
    memHistory,
    restartIncrease,
    podEvents,
    recentDeployments,
    currentAlerts,
  ] = await Promise.all([
    promRange(`sum(rate(container_cpu_usage_seconds_total{namespace="${namespace}",pod="${pod}",container!="POD"}[5m]))`, start, now),
    promRange(`sum(container_memory_working_set_bytes{namespace="${namespace}",pod="${pod}",container!="POD"})`, start, now),
    promRange(`increase(kube_pod_container_status_restarts_total{namespace="${namespace}",pod="${pod}"}[5m])`, start, now),
    k8sGet(`/api/v1/namespaces/${encodeURIComponent(namespace)}/events?fieldSelector=involvedObject.name=${encodeURIComponent(pod)}`),
    k8sGet(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets`),
    promQuery(`ALERTS{namespace="${namespace}"}`),
  ])

  // Detect anomalies from time-series
  const cpuValues = cpuHistory.map(p => p.value).filter(v => v > 0)
  const memValues = memHistory.map(p => p.value).filter(v => v > 0)
  const avgCpu = cpuValues.length ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length : 0
  const maxCpu = cpuValues.length ? Math.max(...cpuValues) : 0
  const avgMem = memValues.length ? memValues.reduce((a, b) => a + b, 0) / memValues.length : 0
  const maxMem = memValues.length ? Math.max(...memValues) : 0
  const totalRestarts = restartIncrease.reduce((s, p) => s + p.value, 0)

  // Find CPU spike moments
  const cpuSpikes = cpuHistory.filter(p => p.value > avgCpu * 1.5 && avgCpu > 0)
    .map(p => ({ ts: p.ts, value: p.value }))

  // K8s events for this pod
  const events = (podEvents?.items ?? []).map((e: any) => ({
    type: e.type,
    reason: e.reason,
    message: e.message,
    count: e.count ?? 1,
    lastTime: e.lastTimestamp ?? e.eventTime,
  })).sort((a: any, b: any) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime())

  // Find recent owner deployments (RS created at = deployment time)
  const ownerDeployments = (recentDeployments.items ?? [])
    .filter((rs: any) => {
      const createdAt = new Date(rs.metadata.creationTimestamp).getTime()
      return createdAt > (now - window) * 1000
    })
    .map((rs: any) => ({
      name: rs.metadata.ownerReferences?.[0]?.name ?? rs.metadata.name,
      createdAt: rs.metadata.creationTimestamp,
    }))
    .slice(0, 5)

  // Firing alerts in namespace
  const alerts = currentAlerts
    .filter((a: any) => a.metric?.namespace === namespace)
    .map((a: any) => ({ name: a.metric?.alertname, severity: a.metric?.severity, state: a.value?.[1] }))

  // Build correlation summary
  const signals: string[] = []
  if (totalRestarts > 2) signals.push(`⚠ ${Math.round(totalRestarts)} restarts in the last ${Math.round(window / 60)}min`)
  if (maxCpu > 0.8) signals.push(`🔥 CPU spike to ${(maxCpu * 100).toFixed(0)}% (avg ${(avgCpu * 100).toFixed(0)}%)`)
  if (maxMem > 400 * 1024 * 1024) signals.push(`💾 Memory peaked at ${(maxMem / (1024 * 1024)).toFixed(0)}MiB`)
  if (events.filter((e: any) => e.type === 'Warning').length > 0) signals.push(`📋 ${events.filter((e: any) => e.type === 'Warning').length} Warning events on pod`)
  if (ownerDeployments.length > 0) signals.push(`🚀 ${ownerDeployments.length} deployment(s) in window — may be causal`)
  if (alerts.length > 0) signals.push(`🚨 ${alerts.length} active alert(s) in namespace`)

  return NextResponse.json({
    pod,
    namespace,
    window,
    summary: signals.length > 0 ? signals : ['✅ No anomalies detected in window'],
    metrics: {
      avgCpuCores: Math.round(avgCpu * 1000) / 1000,
      maxCpuCores: Math.round(maxCpu * 1000) / 1000,
      avgMemMiB: Math.round(avgMem / (1024 * 1024) * 10) / 10,
      maxMemMiB: Math.round(maxMem / (1024 * 1024) * 10) / 10,
      totalRestarts: Math.round(totalRestarts),
    },
    cpuHistory,
    memHistory,
    cpuSpikes,
    events: events.slice(0, 20),
    deployments: ownerDeployments,
    alerts,
  })
}