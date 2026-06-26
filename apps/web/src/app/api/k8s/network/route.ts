import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'

// Per-request helpers that receive a shared AbortSignal so the entire route
// times out as a unit (prevents request pile-up under load).

async function promQuery(q: string, promUrl: string, signal: AbortSignal) {
  if (!promUrl) return []
  try {
    const res = await fetch(
      `${promUrl}/api/v1/query?query=${encodeURIComponent(q)}`,
      { headers: { Accept: 'application/json' }, signal },
    )
    const json = await res.json()
    return json?.data?.result ?? []
  } catch { return [] }
}

async function promRange(q: string, start: number, end: number, promUrl: string, signal: AbortSignal, step = 60): Promise<{ ts: number; value: number }[]> {
  if (!promUrl) return []
  try {
    const url = `${promUrl}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`
    const res = await fetch(url, { signal })
    const json = await res.json()
    return (json.data?.result?.[0]?.values ?? []).map((v: any[]) => ({ ts: v[0] * 1000, value: parseFloat(v[1]) }))
  } catch { return [] }
}

async function promRangeByLabel(q: string, label: string, start: number, end: number, promUrl: string, signal: AbortSignal, step = 60): Promise<Record<string, { ts: number; value: number }[]>> {
  if (!promUrl) return {}
  try {
    const url = `${promUrl}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`
    const res = await fetch(url, { signal })
    const json = await res.json()
    const out: Record<string, { ts: number; value: number }[]> = {}
    for (const r of (json.data?.result ?? [])) {
      const key = r.metric[label] ?? 'unknown'
      out[key] = (r.values ?? []).map((v: any[]) => ({ ts: v[0] * 1000, value: parseFloat(v[1]) }))
    }
    return out
  } catch { return {} }
}

async function k8sGet(path: string, k8sUrl: string, signal: AbortSignal) {
  if (!k8sUrl) return { items: [] }
  try {
    const res = await fetch(`${k8sUrl}${path}`, { headers: { Accept: 'application/json' }, signal })
    return res.json()
  } catch { return { items: [] } }
}

export async function GET(req: Request) {
  const PROMETHEUS_URL = await resolvePromUrl()
  if (!PROMETHEUS_URL) return NextResponse.json({ error: 'PROMETHEUS_URL not configured' }, { status: 503 })
  const K8S_URL = await resolveK8sUrl()

  const url = new URL(req.url)
  const windowMin = Math.min(Math.max(parseInt(url.searchParams.get('window') ?? '360'), 15), 43200) // max 30d
  const windowSec = windowMin * 60

  // Adaptive step: target ~120 data points across the window
  const bwStep = Math.max(60, Math.round(windowSec / 120))

  // Single AbortController for the entire route — prevents fetch pile-up when
  // the client fires repeated requests before previous ones complete.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20000)
  const signal = ac.signal

  const now = Math.floor(Date.now() / 1000)
  const start1h   = now - 3600   // sparklines
  const start30m  = now - 1800   // DNS error spike detection

  try {
    const [
      rxRaw, txRaw, rxDropRaw, txDropRaw, nodeInfo, svcData, epData,
      // CoreDNS live metrics
      dnsQpsRaw, dnsErrRaw, dnsLatRaw, dnsCacheHitsRaw, dnsCacheMissRaw,
      // Network sparklines per node (1h)
      rxSparkRaw, txSparkRaw,
      // DNS error spike (last 30min range)
      dnsErrRangeRaw,
      // DNS by type breakdown
      dnsByTypeRaw,
      // TCP socket states
      tcpInuseRaw, tcpTimewaitRaw, tcpAllocRaw,
      // NGINX ingress request metrics (empty if not installed)
      nginxReqRaw,
      // Per-namespace bandwidth
      nsRxRaw, nsTxRaw,
      // Bandwidth history using selected window
      rxHistRaw, txHistRaw,
      // Retina eBPF metrics (graceful if not installed)
      retinaBytesRaw, retinaTcpStatsRaw, retinaTcpStateRaw, retinaDnsRaw,
      // Packet counts for accurate drop rate
      rxPktRaw, txPktRaw,
    ] = await Promise.all([
      promQuery('sum by(instance) (rate(node_network_receive_bytes_total{device!~"lo|docker.*|br-.*|veth.*|flannel.*"}[5m]))', PROMETHEUS_URL, signal),
      promQuery('sum by(instance) (rate(node_network_transmit_bytes_total{device!~"lo|docker.*|br-.*|veth.*|flannel.*"}[5m]))', PROMETHEUS_URL, signal),
      promQuery('sum by(instance) (rate(node_network_receive_drop_total[5m]))', PROMETHEUS_URL, signal),
      promQuery('sum by(instance) (rate(node_network_transmit_drop_total[5m]))', PROMETHEUS_URL, signal),
      promQuery('kube_node_info', PROMETHEUS_URL, signal),
      k8sGet('/api/v1/services', K8S_URL, signal),
      k8sGet('/api/v1/endpoints', K8S_URL, signal),
      // CoreDNS
      promQuery('sum(rate(coredns_dns_requests_total[2m]))', PROMETHEUS_URL, signal),
      promQuery('sum(rate(coredns_dns_responses_total{rcode!="NOERROR"}[2m])) / sum(rate(coredns_dns_responses_total[2m]))', PROMETHEUS_URL, signal),
      promQuery('histogram_quantile(0.99, sum(rate(coredns_dns_request_duration_seconds_bucket[2m])) by (le))', PROMETHEUS_URL, signal),
      promQuery('sum(rate(coredns_cache_hits_total[2m]))', PROMETHEUS_URL, signal),
      promQuery('sum(rate(coredns_cache_misses_total[2m]))', PROMETHEUS_URL, signal),
      // Network per-node sparklines — uses the requested window so popup time-range buttons work
      promRangeByLabel('sum by(instance) (rate(node_network_receive_bytes_total{device!~"lo|docker.*|br-.*|veth.*|flannel.*"}[5m]))', 'instance', now - windowSec, now, PROMETHEUS_URL, signal, bwStep),
      promRangeByLabel('sum by(instance) (rate(node_network_transmit_bytes_total{device!~"lo|docker.*|br-.*|veth.*|flannel.*"}[5m]))', 'instance', now - windowSec, now, PROMETHEUS_URL, signal, bwStep),
      // DNS error rate 30min trend
      promRange('sum(rate(coredns_dns_responses_total{rcode!="NOERROR"}[2m])) / sum(rate(coredns_dns_responses_total[2m]))', start30m, now, PROMETHEUS_URL, signal, 120),
      // DNS query breakdown by type
      promQuery('sort_desc(sum by(type) (rate(coredns_dns_requests_total[2m])))', PROMETHEUS_URL, signal),
      // TCP socket states
      promQuery('sum(node_sockstat_TCP_inuse)', PROMETHEUS_URL, signal),
      promQuery('sum(node_sockstat_TCP_tw)', PROMETHEUS_URL, signal),
      promQuery('sum(node_sockstat_TCP_alloc)', PROMETHEUS_URL, signal),
      // NGINX ingress (graceful if not installed)
      promQuery('sort_desc(sum by(ingress,namespace) (rate(nginx_ingress_controller_requests[2m])))', PROMETHEUS_URL, signal),
      // Per-namespace bandwidth
      promQuery('sort_desc(sum by(namespace) (rate(container_network_receive_bytes_total{namespace!=""}[5m])))', PROMETHEUS_URL, signal),
      promQuery('sort_desc(sum by(namespace) (rate(container_network_transmit_bytes_total{namespace!=""}[5m])))', PROMETHEUS_URL, signal),
      // Bandwidth history using selected window
      promRange('sum(rate(node_network_receive_bytes_total{device!~"lo|docker.*|br-.*|veth.*|flannel.*"}[5m]))', now - windowSec, now, PROMETHEUS_URL, signal, bwStep),
      promRange('sum(rate(node_network_transmit_bytes_total{device!~"lo|docker.*|br-.*|veth.*|flannel.*"}[5m]))', now - windowSec, now, PROMETHEUS_URL, signal, bwStep),
      // Retina eBPF metrics (graceful if not installed)
      promQuery('sum by(direction) (rate(networkobservability_forward_bytes[2m]))', PROMETHEUS_URL, signal),
      promQuery('sum by(statistic_name) (rate(networkobservability_tcp_connection_stats[2m]))', PROMETHEUS_URL, signal),
      promQuery('sum by(state) (networkobservability_tcp_state)', PROMETHEUS_URL, signal),
      promQuery('sum(rate(networkobservability_dns_request_count[2m]))', PROMETHEUS_URL, signal),
      // Packet counts for accurate drop rate (drops/total_packets)
      promQuery('sum by(instance) (rate(node_network_receive_packets_total{device!~"lo|docker.*|br-.*|veth.*|flannel.*"}[5m]))', PROMETHEUS_URL, signal),
      promQuery('sum by(instance) (rate(node_network_transmit_packets_total{device!~"lo|docker.*|br-.*|veth.*|flannel.*"}[5m]))', PROMETHEUS_URL, signal),
    ])

    // Build instance -> node name map
    const instanceToNode: Record<string, string> = {}
    for (const r of nodeInfo) {
      if (r.metric.internal_ip) instanceToNode[r.metric.internal_ip] = r.metric.node
    }

    const toMbps = (bps: number) => Math.round(bps * 8 / 1_000_000 * 100) / 100

    const mapByNode = (results: any[]) => {
      const m: Record<string, number> = {}
      for (const r of results) {
        const ip = r.metric.instance?.split(':')[0]
        const node = instanceToNode[ip] ?? ip
        m[node] = (m[node] ?? 0) + parseFloat(r.value?.[1] ?? 0)
      }
      return m
    }

    const rxMap = mapByNode(rxRaw)
    const txMap = mapByNode(txRaw)
    const rxDropMap = mapByNode(rxDropRaw)
    const txDropMap = mapByNode(txDropRaw)
    const rxPktMap  = mapByNode(rxPktRaw)
    const txPktMap  = mapByNode(txPktRaw)

    // Resolve sparklines instance key ? node name
    const resolveSparkline = (byInstance: Record<string, { ts: number; value: number }[]>) => {
      const out: Record<string, number[]> = {}
      for (const [inst, pts] of Object.entries(byInstance)) {
        const ip = inst.split(':')[0]
        const node = instanceToNode[ip] ?? ip
        out[node] = pts.map(p => toMbps(p.value))
      }
      return out
    }
    const rxSparklines = resolveSparkline(rxSparkRaw)
    const txSparklines = resolveSparkline(txSparkRaw)

    const nodes = Object.keys({ ...rxMap, ...txMap }).map(node => {
      const rxBps = rxMap[node] ?? 0
      const txBps = txMap[node] ?? 0
      const totalDrop = (rxDropMap[node] ?? 0) + (txDropMap[node] ?? 0)
      const totalPkt  = (rxPktMap[node] ?? 0) + (txPktMap[node] ?? 0)
      const dropRate  = totalPkt > 0 ? totalDrop / (totalDrop + totalPkt) : 0
      return {
        name: node,
        networkInMbps: toMbps(rxBps),
        networkOutMbps: toMbps(txBps),
        networkBandwidthMbps: null, // NIC speed not available from node_exporter by default
        packetDropRate: Math.min(dropRate, 1),
        sparkIn: rxSparklines[node] ?? [],
        sparkOut: txSparklines[node] ?? [],
      }
    })

    // CoreDNS live metrics
    const dnsQps = parseFloat(dnsQpsRaw[0]?.value?.[1] ?? '0')
    const dnsErrRateRaw = parseFloat(dnsErrRaw[0]?.value?.[1] ?? '0')
    const dnsErrRate = (isNaN(dnsErrRateRaw) ? 0 : dnsErrRateRaw) * 100
    const dnsP99Ms = parseFloat(dnsLatRaw[0]?.value?.[1] ?? '0') * 1000
    const cacheHits = parseFloat(dnsCacheHitsRaw[0]?.value?.[1] ?? '0')
    const cacheMisses = parseFloat(dnsCacheMissRaw[0]?.value?.[1] ?? '0')
    const cacheHitRate = (cacheHits + cacheMisses) > 0 ? (cacheHits / (cacheHits + cacheMisses)) * 100 : 0

    // DNS error spike in last 30min (any window > 5%)
    const dnsErrSpike = dnsErrRangeRaw.some(p => p.value > 0.05)

    const coreDNS = {
      qps: Math.round(dnsQps),
      errorRatePct: Math.round(dnsErrRate * 100) / 100,
      p99LatencyMs: Math.round(dnsP99Ms * 10) / 10,
      cacheHitRatePct: Math.round(cacheHitRate * 10) / 10,
      errorSpike: dnsErrSpike,
      errTrend: dnsErrRangeRaw.map(p => p.value * 100),
    }

    // Build endpoints map
    const epMap: Record<string, number> = {}
    for (const ep of (epData.items ?? [])) {
      const key = `${ep.metadata.namespace}/${ep.metadata.name}`
      const ready = (ep.subsets ?? []).reduce((sum: number, s: any) => sum + (s.addresses?.length ?? 0), 0)
      epMap[key] = ready
    }

    const services = (svcData.items ?? []).map((svc: any) => {
      const key = `${svc.metadata.namespace}/${svc.metadata.name}`
      return {
        name: svc.metadata.name,
        namespace: svc.metadata.namespace,
        type: svc.spec.type ?? 'ClusterIP',
        clusterIP: svc.spec.clusterIP ?? 'None',
        externalIPs: [
          ...(svc.status?.loadBalancer?.ingress ?? []).map((lb: any) => lb.ip ?? lb.hostname ?? '').filter(Boolean),
          ...(svc.spec.externalIPs ?? []),
        ],
        externalIP: (svc.status?.loadBalancer?.ingress?.[0]?.ip ?? svc.status?.loadBalancer?.ingress?.[0]?.hostname ?? svc.spec.externalIPs?.[0]) ?? null,
        ports: (svc.spec.ports ?? []).map((p: any) => `${p.port}${p.protocol !== 'TCP' ? '/'+p.protocol : ''}`).join(', '),
        portDetails: (svc.spec.ports ?? []).map((p: any) => ({
          name: p.name,
          port: p.port,
          targetPort: p.targetPort,
          protocol: p.protocol ?? 'TCP',
          nodePort: p.nodePort,
        })),
        selector: svc.spec.selector ? Object.entries(svc.spec.selector).map(([k, v]) => `${k}=${v}`).join(', ') : null,
        readyEndpoints: epMap[key] ?? 0,
        sessionAffinity: svc.spec.sessionAffinity ?? 'None',
        externalTrafficPolicy: svc.spec.externalTrafficPolicy,
        createdAt: svc.metadata.creationTimestamp,
      }
    })

    // DNS by type
    const dnsByType: Record<string, number> = {}
    for (const r of dnsByTypeRaw) {
      dnsByType[r.metric.type ?? 'OTHER'] = Math.round(parseFloat(r.value?.[1] ?? '0') * 100) / 100
    }

    // TCP states
    const tcpStates = {
      inuse:    parseInt(tcpInuseRaw[0]?.value?.[1] ?? '0'),
      timeWait: parseInt(tcpTimewaitRaw[0]?.value?.[1] ?? '0'),
      alloc:    parseInt(tcpAllocRaw[0]?.value?.[1] ?? '0'),
    }

    // NGINX ingress metrics
    const ingressMetrics = nginxReqRaw.map((r: any) => ({
      ingress:   r.metric.ingress ?? '',
      namespace: r.metric.namespace ?? '',
      rps:       Math.round(parseFloat(r.value?.[1] ?? '0') * 100) / 100,
    }))

    // Per-namespace bandwidth
    const nsRxMap: Record<string, number> = {}
    const nsTxMap: Record<string, number> = {}
    for (const r of nsRxRaw) nsRxMap[r.metric.namespace ?? ''] = toMbps(parseFloat(r.value?.[1] ?? '0'))
    for (const r of nsTxRaw) nsTxMap[r.metric.namespace ?? ''] = toMbps(parseFloat(r.value?.[1] ?? '0'))
    const allNs = Array.from(new Set([...Object.keys(nsRxMap), ...Object.keys(nsTxMap)]))
    const nsBandwidth = allNs
      .map(ns => ({ namespace: ns, rxMbps: nsRxMap[ns] ?? 0, txMbps: nsTxMap[ns] ?? 0, totalMbps: (nsRxMap[ns] ?? 0) + (nsTxMap[ns] ?? 0) }))
      .sort((a, b) => b.totalMbps - a.totalMbps)

    // 6h bandwidth history
    const bwHistory = {
      rx: rxHistRaw.map(p => ({ ts: p.ts, v: toMbps(p.value) })),
      tx: txHistRaw.map(p => ({ ts: p.ts, v: toMbps(p.value) })),
    }

    // Retina eBPF metrics
    const retinaForward = { ingressMbps: 0, egressMbps: 0 }
    for (const r of retinaBytesRaw) {
      const dir = r.metric.direction ?? ''
      const bps = parseFloat(r.value?.[1] ?? '0')
      if (dir === 'ingress') retinaForward.ingressMbps = toMbps(bps)
      else if (dir === 'egress') retinaForward.egressMbps = toMbps(bps)
    }
    const retinaTcpStats: Record<string, number> = {}
    let retinaTcpRetransmitRate = 0
    for (const r of retinaTcpStatsRaw) {
      const stat = r.metric.statistic_name ?? r.metric.statistic ?? ''
      if (!stat) continue
      const val = parseFloat(r.value?.[1] ?? '0')
      retinaTcpStats[stat] = Math.round(val * 1000) / 1000
      if (stat.toLowerCase().includes('retransmit')) retinaTcpRetransmitRate += val
    }
    const retinaTcpStateEbpf: Record<string, number> = {}
    for (const r of retinaTcpStateRaw) {
      retinaTcpStateEbpf[r.metric.state ?? 'unknown'] = parseInt(r.value?.[1] ?? '0')
    }
    const retinaMetrics = {
      available: retinaBytesRaw.length > 0 || retinaTcpStatsRaw.length > 0 || retinaTcpStateRaw.length > 0,
      forwardIngressMbps: retinaForward.ingressMbps,
      forwardEgressMbps: retinaForward.egressMbps,
      tcpStats: retinaTcpStats,
      tcpRetransmitRate: Math.round(retinaTcpRetransmitRate * 1000) / 1000,
      tcpStateEbpf: retinaTcpStateEbpf,
      dnsRate: Math.round(parseFloat(retinaDnsRaw[0]?.value?.[1] ?? '0') * 100) / 100,
    }

    return NextResponse.json({ nodes, services, coreDNS, dnsByType, tcpStates, ingressMetrics, nsBandwidth, bwHistory, retinaMetrics })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  } finally {
    clearTimeout(timer)
  }
}

