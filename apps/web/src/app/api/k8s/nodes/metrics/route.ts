// Node-level Prometheus sparklines (30min) + predictive headroom
// Queries node_exporter for CPU, memory, network, disk per node
import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function promRangeByLabel(
  q: string,
  label: string,
  start: number,
  end: number,
  step = 120,
): Promise<Record<string, number[]>> {
  const PROM = await resolvePromUrl()
  if (!PROM) return {}
  try {
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const j = await res.json()
    const out: Record<string, number[]> = {}
    for (const r of j.data?.result ?? []) {
      const key = r.metric[label] ?? 'unknown'
      out[key] = (r.values ?? []).map((v: any[]) => parseFloat(v[1]))
    }
    return out
  } catch { return {} }
}

async function promQuery(q: string): Promise<any[]> {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()
  if (!PROM) return []
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    const j = await res.json()
    return j?.data?.result ?? []
  } catch { return [] }
}

async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return { items: [] }
  try {
    const res = await fetch(`${K8S}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    return res.json()
  } catch { return { items: [] } }
}

function linearTrend(data: number[]): { slope: number; r2: number } {
  // Returns slope per interval and R² goodness-of-fit (0–1)
  if (data.length < 2) return { slope: 0, r2: 0 }
  const n = data.length
  const xMean = (n - 1) / 2
  const yMean = data.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (data[i] - yMean)
    den += (i - xMean) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  // R²: 1 - SS_res / SS_tot
  const ssRes = data.reduce((acc, y, i) => acc + (y - (yMean + slope * (i - xMean))) ** 2, 0)
  const ssTot = data.reduce((acc, y) => acc + (y - yMean) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot
  return { slope, r2 }
}

function etaToThreshold(
  current: number,
  slope: number,
  r2: number,
  threshold: number,
  stepSeconds: number,
  windowSeconds: number,
): number | null {
  // Require a clean trend (R² ≥ 0.75) to avoid noisy/spiky false alarms
  if (r2 < 0.75) return null
  if (slope <= 0) return null
  const stepsNeeded = (threshold - current) / slope
  if (stepsNeeded <= 0) return null
  const etaHours = Math.round((stepsNeeded * stepSeconds) / 3600 * 10) / 10
  // Don't forecast beyond 3× the look-back window — extrapolation too unreliable
  const maxForecastHours = (windowSeconds / 3600) * 3
  return etaHours <= maxForecastHours ? etaHours : null
}

export async function GET(req: Request) {
  const PROM = await resolvePromUrl()
  if (!PROM) return NextResponse.json({ error: 'PROMETHEUS_URL not configured' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const windowParam = searchParams.get('window')
  const windowSeconds = windowParam ? parseInt(windowParam) * 60 : 1800 // default 30 min

  const now = Math.floor(Date.now() / 1000)
  const start = now - windowSeconds
  const step = windowSeconds <= 1800 ? 120 : windowSeconds <= 10800 ? 300 : windowSeconds <= 86400 ? 900 : 3600

  try {
    const [
      cpuSparks, memSparks,
      cpuCurrent, memCurrent, memTotal,
      nodeInfoRaw, nodeCondRaw,
      podCpuRaw, podMemRaw, gpuUtilRaw,
    ] = await Promise.all([
      // CPU usage % per node (100 - idle%)
      promRangeByLabel(
        '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
        'instance', start, now, step,
      ),
      // Memory used % = 1 - MemAvailable/MemTotal
      promRangeByLabel(
        '(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100',
        'instance', start, now, step,
      ),
      // Current CPU % snapshot
      promQuery('100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)'),
      // Current mem used bytes
      promQuery('node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes'),
      // Total mem bytes
      promQuery('node_memory_MemTotal_bytes'),
      // Node info for instance→name mapping
      promQuery('kube_node_info'),
      // Node unschedulable
      promQuery('kube_node_spec_unschedulable'),
      // Top pod CPU consumers per node
      promQuery('sort_desc(sum by(namespace,pod,node) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))'),
      // Top pod memory consumers per node
      promQuery('sort_desc(sum by(namespace,pod,node) (container_memory_working_set_bytes{container!="",container!="POD"}))'),
      // GPU utilization (DCGM — returns empty if not installed)
      promQuery('DCGM_FI_DEV_GPU_UTIL'),
    ])

    // Fetch K8s eviction events (best-effort, last 1h)
    const evictionsRaw = await k8sGet('/api/v1/events?fieldSelector=reason=Evicted').catch(() => null)
    type Eviction = { pod: string; namespace: string; time: string; message: string; node: string }
    const evictionList: Eviction[] = []
    const cutoff = Date.now() - 3600_000
    for (const item of evictionsRaw?.items ?? []) {
      const t = new Date(item.lastTimestamp ?? item.firstTimestamp ?? 0).getTime()
      if (t < cutoff) continue
      evictionList.push({
        pod: item.involvedObject?.name ?? '',
        namespace: item.involvedObject?.namespace ?? '',
        time: item.lastTimestamp ?? item.firstTimestamp ?? '',
        message: (item.message ?? '').slice(0, 120),
        node: item.source?.host ?? '',
      })
    }

    // Build instance IP → node name
    const instanceToNode: Record<string, string> = {}
    for (const r of nodeInfoRaw) {
      if (r.metric.internal_ip) instanceToNode[r.metric.internal_ip] = r.metric.node
    }
    const resolveNode = (inst: string) => {
      const ip = inst.split(':')[0]
      return instanceToNode[ip] ?? ip
    }

    // Build top consumers maps: node -> sorted list
    type PodUsage = { namespace: string; pod: string; value: number }
    const topCpuMap: Record<string, PodUsage[]> = {}
    for (const r of podCpuRaw) {
      const node = r.metric.node ?? ''
      if (!node) continue
      if (!topCpuMap[node]) topCpuMap[node] = []
      topCpuMap[node].push({ namespace: r.metric.namespace ?? '', pod: r.metric.pod ?? '', value: parseFloat(r.value[1]) })
    }
    const topMemMap: Record<string, PodUsage[]> = {}
    for (const r of podMemRaw) {
      const node = r.metric.node ?? ''
      if (!node) continue
      if (!topMemMap[node]) topMemMap[node] = []
      topMemMap[node].push({ namespace: r.metric.namespace ?? '', pod: r.metric.pod ?? '', value: parseFloat(r.value[1]) })
    }

    // GPU map: node -> utilization pct
    const gpuMap: Record<string, number> = {}
    for (const r of gpuUtilRaw) {
      const node = r.metric.node ?? resolveNode(r.metric.instance ?? '')
      if (node) gpuMap[node] = parseFloat(r.value[1])
    }

    // Merge all instance keys
    const allInstances = new Set([...Object.keys(cpuSparks), ...Object.keys(memSparks)])

    const nodes = Array.from(allInstances).map(inst => {
      const nodeName = resolveNode(inst)

      const cpuData = cpuSparks[inst] ?? []
      const memData = memSparks[inst] ?? []

      // Current values
      const cpuCur = cpuCurrent.find(r => resolveNode(r.metric.instance) === nodeName)
      const memCur = memCurrent.find(r => resolveNode(r.metric.instance) === nodeName)
      const memTotR = memTotal.find(r => resolveNode(r.metric.instance) === nodeName)

      const currentCpuPct = parseFloat(cpuCur?.value?.[1] ?? cpuData.at(-1)?.toString() ?? '0')
      const memUsedBytes = parseFloat(memCur?.value?.[1] ?? '0')
      const memTotalBytes = parseFloat(memTotR?.value?.[1] ?? '1')
      const currentMemPct = memTotalBytes > 0 ? (memUsedBytes / memTotalBytes) * 100 : parseFloat(memData.at(-1)?.toString() ?? '0')

      // Predictive headroom via linear regression on sparkline trend
      const { slope: cpuSlope, r2: cpuR2 } = linearTrend(cpuData)
      const { slope: memSlope, r2: memR2 } = linearTrend(memData)
      const cpuEta90 = etaToThreshold(currentCpuPct, cpuSlope, cpuR2, 90, step, windowSeconds)
      const memEta90 = etaToThreshold(currentMemPct, memSlope, memR2, 90, step, windowSeconds)

      const unschedulable = nodeCondRaw.find(r => r.metric.node === nodeName && parseFloat(r.value?.[1]) === 1)

      return {
        name: nodeName,
        instance: inst,
        sparkCpu: cpuData.map(v => Math.round(v * 10) / 10),
        sparkMem: memData.map(v => Math.round(v * 10) / 10),
        currentCpuPct: Math.round(currentCpuPct * 10) / 10,
        currentMemPct: Math.round(currentMemPct * 10) / 10,
        memUsedGiB: Math.round(memUsedBytes / (1024 ** 3) * 10) / 10,
        memTotalGiB: Math.round(memTotalBytes / (1024 ** 3) * 10) / 10,
        // Predictive: hours until 90% threshold; null = not trending there
        cpuHoursTo90: cpuEta90,
        memHoursTo90: memEta90,
        // Trend direction: positive = growing
        cpuTrend: cpuSlope > 0.5 ? 'rising' : cpuSlope < -0.5 ? 'falling' : 'stable',
        memTrend: memSlope > 0.3 ? 'rising' : memSlope < -0.3 ? 'falling' : 'stable',
        unschedulable: !!unschedulable,
        // Top consumers: top 5 pods by CPU cores and memory MiB
        topCpu: (topCpuMap[nodeName] ?? []).slice(0, 5).map(p => ({
          ...p, valueFmt: `${(p.value * 1000).toFixed(0)}m`,
        })),
        topMem: (topMemMap[nodeName] ?? []).slice(0, 5).map(p => ({
          ...p, valueFmt: `${Math.round(p.value / (1024 ** 2))}Mi`,
        })),
        // GPU utilization pct (null if no GPU)
        gpuUtilPct: gpuMap[nodeName] != null ? Math.round(gpuMap[nodeName]) : null,
        // Evictions in last 1h on this node
        recentEvictions: evictionList.filter(e => e.node === nodeName),
      }
    })

    return NextResponse.json({ nodes, windowMinutes: Math.round(windowSeconds / 60), stepSeconds: step })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}