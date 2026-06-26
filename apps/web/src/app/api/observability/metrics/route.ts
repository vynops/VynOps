import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

async function promInstant(q: string): Promise<number> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    const j = await r.json()
    return parseFloat(j.data?.result?.[0]?.value?.[1] ?? '0')
  } catch { return 0 }
}

async function promRange(q: string, minutes = 60, step = 120): Promise<{ ts: number; value: number }[]> {
  const PROM = await resolvePromUrl()
  try {
    const now     = Math.floor(Date.now() / 1000)
    const start   = now - minutes * 60
    const url     = `${PROM}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${now}&step=${step}`
    // Scale timeout with window size — large range queries over WAN need more time
    const timeoutMs = Math.max(K8S_TIMEOUT_MS, Math.min(60_000, minutes * 4))
    const r     = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const j     = await r.json()
    const vals: [number, string][] = j.data?.result?.[0]?.values ?? []
    return vals.map(([t, v]) => ({ ts: t * 1000, value: parseFloat(parseFloat(v).toFixed(1)) }))
  } catch { return [] }
}

async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    return r.json()
  } catch { return { items: [] } }
}

function fillHistory(pts: { ts: number; value: number }[]): { ts: number; value: number }[] {
  return pts  // return Prometheus data as-is — no synthetic padding
}

export async function GET(req: Request) {
  const PROM = await resolvePromUrl()
  const { searchParams } = new URL(req.url)
  const window = searchParams.get('window') ?? '60'   // minutes
  const winMin  = parseInt(window)
  // Target ~150 visible points; step = window_seconds / 150, rounded to a clean interval
  const rawStep = Math.ceil((winMin * 60) / 150)
  const step    = rawStep < 60 ? 60 : rawStep < 120 ? 120 : rawStep < 300 ? 300 : rawStep < 600 ? 600 : rawStep < 1800 ? 1800 : 3600

  console.log(`[metrics] window=${winMin}min step=${step}s timeout=${Math.max(K8S_TIMEOUT_MS, Math.min(60_000, winMin * 4))}ms`)

  const [
    cpuNow, memNow, cpuHist, memHist,
    reqNow, reqHist, errNow, errHist,
    p50Now, p99Now, p99Hist,
    deployData, restartData,
  ] = await Promise.all([
    promInstant('sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100'),
    promInstant('(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100'),
    promRange('sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100', parseInt(window), step),
    promRange('(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100', parseInt(window), step),
    // Nginx Ingress request rate (exists if ingress-nginx is installed)
    promInstant('sum(rate(nginx_ingress_controller_requests[5m]))'),
    promRange('sum(rate(nginx_ingress_controller_requests[5m]))', parseInt(window), step),
    // Error rate % from nginx
    promInstant('sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) / sum(rate(nginx_ingress_controller_requests[5m])) * 100'),
    promRange('sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) / clamp_min(sum(rate(nginx_ingress_controller_requests[5m])),1) * 100', parseInt(window), step),
    // Latency percentiles from nginx
    promInstant('histogram_quantile(0.50, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le)) * 1000'),
    promInstant('histogram_quantile(0.99, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le)) * 1000'),
    promRange('histogram_quantile(0.99, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le)) * 1000', parseInt(window), step),
    k8sGet('/apis/apps/v1/deployments'),
    fetch(`${PROM}/api/v1/query?query=${encodeURIComponent('sum by (namespace) (kube_pod_container_status_restarts_total)')}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      .then(r => r.json()).then(j => j.data?.result ?? []).catch(() => []),
  ])

  console.log(`[metrics] cpuHist=${cpuHist.length}pts span=${cpuHist.length > 1 ? Math.round((cpuHist[cpuHist.length-1].ts - cpuHist[0].ts)/3600000*10)/10 : 0}h`)
  const restartByNs: Record<string, number> = {}
  for (const r of restartData as any[]) {
    const ns = r.metric?.namespace
    if (ns) restartByNs[ns] = parseFloat(r.value?.[1] ?? '0')
  }

  // Per-service request/error/latency from nginx ingress — try both common label names
  const [svcReqData, svcErrData, svcP50Data, svcP99Data] = await Promise.all([
    fetch(`${PROM}/api/v1/query?query=${encodeURIComponent('sum by (service,exported_service,ingress,namespace) (rate(nginx_ingress_controller_requests[5m]))')}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      .then(r => r.json()).then(j => j.data?.result ?? []).catch(() => []),
    fetch(`${PROM}/api/v1/query?query=${encodeURIComponent('sum by (service,exported_service,ingress,namespace) (rate(nginx_ingress_controller_requests{status=~"5.."}[5m]))')}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      .then(r => r.json()).then(j => j.data?.result ?? []).catch(() => []),
    fetch(`${PROM}/api/v1/query?query=${encodeURIComponent('histogram_quantile(0.50, sum by (service,exported_service,le) (rate(nginx_ingress_controller_request_duration_seconds_bucket[5m]))) * 1000')}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      .then(r => r.json()).then(j => j.data?.result ?? []).catch(() => []),
    fetch(`${PROM}/api/v1/query?query=${encodeURIComponent('histogram_quantile(0.99, sum by (service,exported_service,le) (rate(nginx_ingress_controller_request_duration_seconds_bucket[5m]))) * 1000')}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      .then(r => r.json()).then(j => j.data?.result ?? []).catch(() => []),
  ])

  // Build lookup maps — match by service, exported_service, or ingress name
  function buildSvcMap(results: any[]): Record<string, number> {
    const map: Record<string, number> = {}
    for (const r of results) {
      const val = parseFloat(r.value?.[1] ?? '0')
      const keys = [r.metric?.service, r.metric?.exported_service, r.metric?.ingress].filter(Boolean)
      for (const k of keys) map[k] = (map[k] ?? 0) + val
    }
    return map
  }
  const svcReqMap  = buildSvcMap(svcReqData)
  const svcErrMap  = buildSvcMap(svcErrData)
  const svcP50Map  = buildSvcMap(svcP50Data)
  const svcP99Map  = buildSvcMap(svcP99Data)

  // Build serviceMetrics from live deployments
  const deploys: any[] = deployData.items ?? []
  const serviceMetrics = deploys.map(d => {
    const name      = d.metadata.name
    const ns        = d.metadata.namespace
    const desired   = d.spec.replicas ?? 1
    const ready     = d.status.readyReplicas ?? 0
    const avail     = desired > 0 ? (ready / desired) * 100 : 0
    const restarts  = restartByNs[ns] ?? 0
    // Use nginx per-service metrics if available, fall back to restart-derived estimate
    // Try name alone, ns/name, and name without common suffixes (e.g. "-svc", "-service")
    const nameBase  = name.replace(/-(svc|service|app)$/, '')
    const reqRate   = svcReqMap[name] ?? svcReqMap[`${ns}/${name}`] ?? svcReqMap[nameBase] ?? 0
    const errReqs   = svcErrMap[name] ?? svcErrMap[`${ns}/${name}`] ?? svcErrMap[nameBase] ?? 0
    const errorRate = reqRate > 0
      ? parseFloat(((errReqs / reqRate) * 100).toFixed(2))
      : parseFloat(Math.min(restarts / 5, 20).toFixed(2))
    const p50Latency = parseFloat((svcP50Map[name] ?? svcP50Map[`${ns}/${name}`] ?? svcP50Map[nameBase] ?? 0).toFixed(1))
    const p99Latency = parseFloat((svcP99Map[name] ?? svcP99Map[`${ns}/${name}`] ?? svcP99Map[nameBase] ?? 0).toFixed(1))
    const status: 'healthy' | 'degraded' | 'critical' =
      avail >= 100 ? 'healthy' : avail > 0 ? 'degraded' : 'critical'

    return {
      name,
      namespace:    ns,
      requestRate:  parseFloat(reqRate.toFixed(2)),
      errorRate,
      p50Latency,
      p99Latency,
      availability: parseFloat(avail.toFixed(2)),
      status,
      dependsOn:    [],
      history:      [{ ts: Date.now(), value: parseFloat(avail.toFixed(1)) }],
    }
  })

  const clusterMetrics = {
    cpuUsage:       parseFloat(cpuNow.toFixed(1)),
    memoryUsage:    parseFloat(memNow.toFixed(1)),
    networkInBytes: 0,
    networkOutBytes:0,
    diskReadBytes:  0,
    diskWriteBytes: 0,
    podRestartRate: Object.values(restartByNs).reduce((a, b) => a + b, 0),
    errorRate:      parseFloat(errNow.toFixed(2)),
    p99Latency:     parseFloat(p99Now.toFixed(1)),
    p50Latency:     parseFloat(p50Now.toFixed(1)),
    requestRate:    parseFloat(reqNow.toFixed(2)),
    history: {
      cpu:      fillHistory(cpuHist),
      memory:   fillHistory(memHist),
      requests: fillHistory(reqHist),
      errors:   fillHistory(errHist),
      latency:  fillHistory(p99Hist),
    },
  }

  // Namespace-level actual resource usage from cAdvisor (Prometheus)
  const [nsCpuData, nsMemData, nsTotalCpuData] = await Promise.all([
    fetch(`${PROM}/api/v1/query?query=${encodeURIComponent('sum by (namespace) (rate(container_cpu_usage_seconds_total{container!="",namespace!=""}[5m]))')}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      .then(r => r.json()).then(j => j.data?.result ?? []).catch(() => []),
    fetch(`${PROM}/api/v1/query?query=${encodeURIComponent('sum by (namespace) (container_memory_working_set_bytes{container!="",namespace!=""})')}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      .then(r => r.json()).then(j => j.data?.result ?? []).catch(() => []),
    // Total allocatable CPU across all nodes (for % calculation)
    fetch(`${PROM}/api/v1/query?query=${encodeURIComponent('sum(kube_node_status_allocatable{resource="cpu"})')}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      .then(r => r.json()).then(j => parseFloat(j.data?.result?.[0]?.value?.[1] ?? '0')).catch(() => 0),
  ])

  const nsCpuMap: Record<string, number> = {}
  for (const r of nsCpuData as any[]) {
    const ns = r.metric?.namespace; if (ns) nsCpuMap[ns] = parseFloat(r.value?.[1] ?? '0')
  }
  const nsMemMap: Record<string, number> = {}
  for (const r of nsMemData as any[]) {
    const ns = r.metric?.namespace; if (ns) nsMemMap[ns] = parseFloat(r.value?.[1] ?? '0') / (1024 ** 3) // bytes → GiB
  }
  const allNs = [...new Set([...Object.keys(nsCpuMap), ...Object.keys(nsMemMap)])]
  const namespaceUsage = allNs
    .map(ns => ({
      namespace: ns,
      cpuCores:   parseFloat((nsCpuMap[ns] ?? 0).toFixed(4)),
      memGiB:     parseFloat((nsMemMap[ns] ?? 0).toFixed(3)),
      restarts:   restartByNs[ns] ?? 0,
    }))
    .filter(ns => ns.cpuCores > 0 || ns.memGiB > 0)
    .sort((a, b) => b.cpuCores - a.cpuCores)

  return NextResponse.json({ clusterMetrics, serviceMetrics, namespaceUsage, clusterCpuCores: nsTotalCpuData as number })
}