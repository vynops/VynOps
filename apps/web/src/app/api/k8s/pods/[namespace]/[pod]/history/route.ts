import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'


async function promRange(query: string, start: number, end: number, step = 60): Promise<number[]> {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()
  if (!PROM) return []
  try {
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${step}`
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    return (j.data?.result?.[0]?.values ?? []).map((v: any[]) => parseFloat(v[1]))
  } catch { return [] }
}

async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return null
  try {
    const r = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) return null
    return r.json()
  } catch { return null }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ namespace: string; pod: string }> },
) {
  const { namespace, pod } = await params
  const { searchParams } = new URL(req.url)
  const window = parseInt(searchParams.get('window') ?? '3600') // default 1h

  const now = Math.floor(Date.now() / 1000)
  const start = now - window
  const step = Math.max(60, Math.floor(window / 60))

  // Prometheus range queries
  const [cpuHistory, memHistory, restartHistory, podEvents] = await Promise.all([
    promRange(`rate(container_cpu_usage_seconds_total{namespace="${namespace}",pod="${pod}",container!="",container!="POD"}[5m])`, start, now, step),
    promRange(`container_memory_working_set_bytes{namespace="${namespace}",pod="${pod}",container!="",container!="POD"}`, start, now, step),
    promRange(`increase(kube_pod_container_status_restarts_total{namespace="${namespace}",pod="${pod}"}[5m])`, start, now, step),
    k8sGet(`/api/v1/namespaces/${encodeURIComponent(namespace)}/events?fieldSelector=involvedObject.name=${encodeURIComponent(pod)}`),
  ])

  const events = (podEvents?.items ?? []).map((e: any) => ({
    type: e.type,
    reason: e.reason,
    message: e.message,
    count: e.count,
    lastTime: e.lastTimestamp ?? e.eventTime,
  })).sort((a: any, b: any) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime())

  const tsStep = step * 1000
  const tsStart = start * 1000

  return NextResponse.json({
    pod,
    namespace,
    window,
    cpuHistory: cpuHistory.map((v, i) => ({ ts: tsStart + i * tsStep, value: Math.round(v * 1000) / 1000 })),
    memHistory: memHistory.map((v, i) => ({ ts: tsStart + i * tsStep, value: Math.round(v / (1024 * 1024) * 10) / 10 })),
    restartHistory: restartHistory.map((v, i) => ({ ts: tsStart + i * tsStep, value: Math.round(v) })),
    events,
  })
}
