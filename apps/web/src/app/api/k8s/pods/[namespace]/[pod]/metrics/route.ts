import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'


async function promRange(query: string, start: number, end: number, step = 30): Promise<number[]> {
  const PROM = await resolvePromUrl()
  if (!PROM) return []
  try {
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${step}`
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    return (j.data?.result?.[0]?.values ?? []).map((v: any[]) => parseFloat(v[1]))
  } catch { return [] }
}

async function promInstant(query: string): Promise<{ metric: Record<string, string>; value: number }[]> {
  const PROM = await resolvePromUrl()
  if (!PROM) return []
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(5000) })
    const j = await r.json()
    return (j.data?.result ?? []).map((x: any) => ({ metric: x.metric, value: parseFloat(x.value[1]) }))
  } catch { return [] }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ namespace: string; pod: string }> },
) {
  const { namespace, pod } = await params

  const now = Math.floor(Date.now() / 1000)
  const start = now - 30 * 60 // last 30 minutes
  const step = 90 // 90s steps → ~20 data points

  // Queries
  const cpuQuery = `rate(container_cpu_usage_seconds_total{namespace="${namespace}",pod="${pod}",container!="",container!="POD"}[5m])`
  const memQuery = `container_memory_working_set_bytes{namespace="${namespace}",pod="${pod}",container!="",container!="POD"}`
  const cpuLimitQuery = `kube_pod_container_resource_limits{namespace="${namespace}",pod="${pod}",resource="cpu",container!=""}`
  const memLimitQuery = `kube_pod_container_resource_limits{namespace="${namespace}",pod="${pod}",resource="memory",container!=""}`

  const [cpuInstant, memInstant, cpuLimits, memLimits] = await Promise.all([
    promInstant(cpuQuery),
    promInstant(memQuery),
    promInstant(cpuLimitQuery),
    promInstant(memLimitQuery),
  ])

  // Build per-container data
  const containerNames = [...new Set([
    ...cpuInstant.map(r => r.metric.container),
    ...memInstant.map(r => r.metric.container),
  ])]

  const metrics = await Promise.all(containerNames.map(async container => {
    const cpuVal = cpuInstant.find(r => r.metric.container === container)?.value ?? 0
    const memVal = memInstant.find(r => r.metric.container === container)?.value ?? 0
    const cpuLim = cpuLimits.find(r => r.metric.container === container)?.value
    const memLim = memLimits.find(r => r.metric.container === container)?.value

    // Sparkline: last 30min range
    const [sparkCpuRaw, sparkMemRaw] = await Promise.all([
      promRange(`rate(container_cpu_usage_seconds_total{namespace="${namespace}",pod="${pod}",container="${container}"}[5m])`, start, now, step),
      promRange(`container_memory_working_set_bytes{namespace="${namespace}",pod="${pod}",container="${container}"}`, start, now, step),
    ])

    return {
      container,
      pod,
      namespace,
      cpuUsageCores: Math.round(cpuVal * 1000) / 1000,
      cpuUsagePct: cpuLim ? Math.round((cpuVal / cpuLim) * 100) : undefined,
      memUsageMiB: Math.round(memVal / (1024 * 1024) * 10) / 10,
      memUsagePct: memLim ? Math.round((memVal / memLim) * 100) : undefined,
      sparkCpu: sparkCpuRaw.map(v => Math.round(v * 1000) / 1000),
      sparkMem: sparkMemRaw.map(v => Math.round(v / (1024 * 1024) * 10) / 10),
    }
  }))

  return NextResponse.json({ metrics, pod, namespace })
}
