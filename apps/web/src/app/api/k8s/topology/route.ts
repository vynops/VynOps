import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


const SYSTEM_NS = new Set([
  'kube-system', 'kube-public', 'kube-node-lease', 'local-path-storage',
  'cert-manager', 'longhorn-system',
])

async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

async function promQuery(q: string): Promise<any[]> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    const j = await r.json()
    return j.data?.result ?? []
  } catch { return [] }
}

/** Hierarchical layout: namespace bands, type tiers within each band */
function layoutNodes(nodes: any[]) {
  const TIER_Y: Record<string, number> = {
    gateway: 90, ingress: 90, service: 230, external: 230, queue: 370, database: 470,
  }
  const namespaces = [...new Set<string>(nodes.map(n => n.namespace))]
  let offsetX = 70

  for (const ns of namespaces) {
    const nsNodes = nodes.filter(n => n.namespace === ns)
    const byTier: Record<string, any[]> = {}
    for (const n of nsNodes) (byTier[n.type] ??= []).push(n)

    const order = ['gateway', 'ingress', 'service', 'external', 'queue', 'database']
    let col = 0
    for (const tier of order) {
      const grp = byTier[tier] ?? []
      for (let i = 0; i < grp.length; i++) {
        grp[i].x = offsetX + col * 175
        grp[i].y = TIER_Y[tier] ?? 230
        col++
      }
    }

    const colCount = Object.values(byTier).reduce((s, g) => s + g.length, 0)
    offsetX += (colCount || 1) * 175 + 60
  }
}

export async function GET() {
  const [
    svcData, deployData, stsData, podData,
    readyMetrics, restartMetrics, netTxMetrics, netRxMetrics, cpuMetrics,
  ] = await Promise.all([
    k8sGet('/api/v1/services'),
    k8sGet('/apis/apps/v1/deployments'),
    k8sGet('/apis/apps/v1/statefulsets'),
    k8sGet('/api/v1/pods'),
    promQuery('kube_deployment_status_replicas_ready / kube_deployment_spec_replicas'),
    promQuery('sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[24h]))'),
    promQuery('sum by (namespace, pod) (rate(container_network_transmit_bytes_total[5m]))'),
    promQuery('sum by (namespace, pod) (rate(container_network_receive_bytes_total[5m]))'),
    promQuery('sum by (namespace, pod) (rate(container_cpu_usage_seconds_total[5m]))'),
  ])

  // ── Health map: ns/name → health ─────────────────────────────────────────
  const healthMap: Record<string, 'healthy' | 'degraded' | 'critical'> = {}

  for (const m of readyMetrics) {
    const ratio = parseFloat(m.value?.[1] ?? '1')
    const ns = m.metric?.namespace; const name = m.metric?.deployment
    if (ns && name) {
      healthMap[`${ns}/${name}`] = ratio >= 1 ? 'healthy' : ratio > 0 ? 'degraded' : 'critical'
    }
  }
  for (const d of (deployData.items ?? []) as any[]) {
    const key = `${d.metadata.namespace}/${d.metadata.name}`
    if (healthMap[key]) continue
    const des = d.spec.replicas ?? 1; const rdy = d.status?.readyReplicas ?? 0
    healthMap[key] = des === 0 ? 'healthy' : rdy >= des ? 'healthy' : rdy > 0 ? 'degraded' : 'critical'
  }
  for (const s of (stsData.items ?? []) as any[]) {
    const key = `${s.metadata.namespace}/${s.metadata.name}`
    if (healthMap[key]) continue
    const des = s.spec.replicas ?? 1; const rdy = s.status?.readyReplicas ?? 0
    healthMap[key] = des === 0 ? 'healthy' : rdy >= des ? 'healthy' : rdy > 0 ? 'degraded' : 'critical'
  }

  // ── Pod-level metrics: key = "ns/pod" ────────────────────────────────────
  const podMet: Record<string, { restarts: number; txBps: number; rxBps: number; cpu: number }> = {}
  const getM = (k: string) => (podMet[k] ??= { restarts: 0, txBps: 0, rxBps: 0, cpu: 0 })

  for (const m of restartMetrics)
    getM(`${m.metric?.namespace}/${m.metric?.pod}`).restarts = Math.max(0, Math.round(parseFloat(m.value?.[1] ?? '0')))
  for (const m of netTxMetrics)
    getM(`${m.metric?.namespace}/${m.metric?.pod}`).txBps = parseFloat(m.value?.[1] ?? '0')
  for (const m of netRxMetrics)
    getM(`${m.metric?.namespace}/${m.metric?.pod}`).rxBps = parseFloat(m.value?.[1] ?? '0')
  for (const m of cpuMetrics)
    getM(`${m.metric?.namespace}/${m.metric?.pod}`).cpu = parseFloat(m.value?.[1] ?? '0')

  // ── Build nodes ───────────────────────────────────────────────────────────
  const pods = (podData.items ?? []) as any[]

  function matchSel(sel: Record<string, string>, labels: Record<string, string>) {
    return Object.entries(sel).every(([k, v]) => labels[k] === v)
  }

  const svcs = ((svcData.items ?? []) as any[]).filter(s => !SYSTEM_NS.has(s.metadata.namespace))
  const seen = new Set<string>()
  const nodes: any[] = []

  for (const svc of svcs) {
    const name = svc.metadata.name
    const ns   = svc.metadata.namespace
    const id   = `${ns}--${name}`
    if (seen.has(id)) continue
    seen.add(id)

    const ln = name.toLowerCase()
    let type = 'service'
    if (ln.includes('ingress') || ln.includes('gateway') || ln.includes('traefik') ||
        ln.includes('nginx') || ln === 'nginx-ingress' || ln.includes('kong') || ln.includes('envoy'))
      type = 'gateway'
    else if (ln.includes('postgres') || ln.includes('mysql') || ln.includes('mongo') ||
             ln.includes('redis') || ln.includes('cache') || ln.includes('elastic') ||
             ln.includes('minio') || ln.includes('cassandra') || ln.includes('clickhouse'))
      type = 'database'
    else if (ln.includes('kafka') || ln.includes('rabbitmq') || ln.includes('nats') ||
             ln.includes('pulsar') || ln.includes('amqp') || ln.includes('activemq'))
      type = 'queue'

    // Match pods to this service via label selector
    const selector = svc.spec?.selector ?? {}
    const hasSel   = Object.keys(selector).length > 0
    const svcPods  = hasSel
      ? pods.filter(p => p.metadata?.namespace === ns && matchSel(selector, p.metadata?.labels ?? {}))
      : []

    const podCount  = svcPods.length
    const readyPods = svcPods.filter((p: any) =>
      (p.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True')
    ).length

    // Aggregate pod-level metrics for this service
    let txBps = 0, rxBps = 0, restarts = 0, cpu = 0
    for (const p of svcPods) {
      const m = podMet[`${ns}/${p.metadata.name}`]
      if (m) { txBps += m.txBps; rxBps += m.rxBps; restarts += m.restarts; cpu += m.cpu }
    }

    const health = healthMap[`${ns}/${name}`]
      ?? (podCount > 0 && readyPods < podCount ? 'degraded' : 'healthy')

    nodes.push({
      id, label: name, type, status: health, namespace: ns,
      podCount, readyPods,
      txKbps:      Math.round(txBps / 1024 * 10) / 10,
      rxKbps:      Math.round(rxBps / 1024 * 10) / 10,
      restarts24h: restarts,
      cpuCores:    Math.round(cpu * 1000) / 1000,
      x: 0, y: 0,
    })
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  layoutNodes(nodes)

  // ── Build edges (inferred from type hierarchy + namespace co-location) ────
  const edges: any[] = []
  let eId = 1

  const byNs: Record<string, { gws: any[]; svcs: any[]; dbs: any[]; queues: any[] }> = {}
  for (const n of nodes) {
    const g = (byNs[n.namespace] ??= { gws: [], svcs: [], dbs: [], queues: [] })
    if (n.type === 'gateway')  g.gws.push(n)
    else if (n.type === 'database') g.dbs.push(n)
    else if (n.type === 'queue')    g.queues.push(n)
    else                            g.svcs.push(n)
  }

  // Derive error rate from actual pod readiness (not magic numbers)
  function podErrRate(n: any): number {
    if (!n.podCount) return 0
    return Math.round((1 - n.readyPods / n.podCount) * 100)
  }

  for (const { gws, svcs: sv, dbs, queues } of Object.values(byNs)) {
    for (const gw of gws) for (const s of sv)
      edges.push({
        id: `e${eId++}`, source: gw.id, target: s.id, protocol: 'HTTP',
        txKbps:    Math.round((gw.txKbps + s.rxKbps) / 2 * 10) / 10,
        errorRate: podErrRate(s),
      })
    for (const s of sv) for (const db of dbs)
      edges.push({
        id: `e${eId++}`, source: s.id, target: db.id, protocol: 'TCP',
        txKbps:    Math.round((s.txKbps + db.rxKbps) / 2 * 10) / 10,
        errorRate: podErrRate(db),
      })
    for (const s of sv) for (const q of queues)
      edges.push({
        id: `e${eId++}`, source: s.id, target: q.id, protocol: 'AMQP',
        txKbps:    Math.round((s.txKbps + q.rxKbps) / 2 * 10) / 10,
        errorRate: podErrRate(q),
      })
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const healthy  = nodes.filter(n => n.status === 'healthy').length
  const degraded = nodes.filter(n => n.status === 'degraded').length
  const critical = nodes.filter(n => n.status === 'critical').length
  const namespaces = [...new Set<string>(nodes.map(n => n.namespace))]
  const totalTxKbps = Math.round(nodes.reduce((s, n) => s + n.txKbps, 0))
  const totalRxKbps = Math.round(nodes.reduce((s, n) => s + n.rxKbps, 0))

  return NextResponse.json({
    topology: { nodes, edges, updatedAt: new Date().toISOString() },
    summary:  { healthy, degraded, critical, totalTxKbps, totalRxKbps, namespaces },
  })
}
