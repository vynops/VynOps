import { NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { K8sCluster } from '@/types'
import { assertOperator } from '@/lib/rbac'
import { auth } from '@/lib/auth'

const K8S_TIMEOUT_MS = parseInt(process.env.K8S_TIMEOUT_MS ?? '15000', 10)
const DATA_DIR  = join(process.cwd(), 'data')
const DATA_FILE = join(DATA_DIR, 'clusters.json')

function readClusters(): K8sCluster[] {
  try {
    if (!existsSync(DATA_FILE)) return []
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
    return Array.isArray(parsed)
      ? parsed.map(({ couchbaseUrl: _url, couchbaseUser: _user, couchbasePass: _pass, ...cluster }) => cluster)
      : []
  } catch { return [] }
}

function writeClusters(clusters: K8sCluster[]) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(DATA_FILE, JSON.stringify(clusters, null, 2), 'utf8')
}

// ── Resource parsing helpers ─────────────────────────────────────────────
function parseCpu(cpu: string): number {
  if (!cpu) return 0
  if (cpu.endsWith('m')) return parseInt(cpu) / 1000
  return parseFloat(cpu) || 0
}
function parseNanoCores(cpu: string): number {
  if (!cpu) return 0
  if (cpu.endsWith('n')) return parseInt(cpu) / 1e9
  if (cpu.endsWith('m')) return parseInt(cpu) / 1000
  return parseFloat(cpu) || 0
}
function parseMemGiB(mem: string): number {
  if (!mem) return 0
  if (mem.endsWith('Ki')) return parseInt(mem) / (1024 * 1024)
  if (mem.endsWith('Mi')) return parseInt(mem) / 1024
  if (mem.endsWith('Gi')) return parseFloat(mem)
  return parseInt(mem) / (1024 * 1024 * 1024) || 0
}
function round2(n: number) { return Math.round(n * 100) / 100 }

interface ProbeResult {
  version: string; status: 'healthy' | 'unknown'
  nodeCount: number; namespaceCount: number; podCount: number
  cpuCapacity: number; memoryCapacity: number
  cpuUsed: number; memoryUsed: number
  lastProbed: string; lastProbedStatus: 'healthy' | 'unknown'
}

async function probeCluster(k8sUrl: string): Promise<ProbeResult> {
  let version = 'unknown', status: 'healthy' | 'unknown' = 'unknown'
  let nodeCount = 0, namespaceCount = 0, podCount = 0
  let cpuCapacity = 0, memoryCapacity = 0, cpuUsed = 0, memoryUsed = 0
  const TO = K8S_TIMEOUT_MS

  try {
    const vr = await fetch(`${k8sUrl}/version`, { signal: AbortSignal.timeout(TO) })
    if (vr.ok) {
      status = 'healthy'
      const vj = await vr.json()
      const maj = String(vj.major ?? '').replace(/\D/g, '')
      const min = String(vj.minor ?? '').replace(/\D/g, '')
      if (maj && min) version = `${maj}.${min}`
    }

    const [nr, nsr, pr] = await Promise.all([
      fetch(`${k8sUrl}/api/v1/nodes`,      { signal: AbortSignal.timeout(TO) }),
      fetch(`${k8sUrl}/api/v1/namespaces`, { signal: AbortSignal.timeout(TO) }),
      fetch(`${k8sUrl}/api/v1/pods`,       { signal: AbortSignal.timeout(TO) }),
    ])

    if (nr.ok) {
      const nodes: any[] = (await nr.json()).items ?? []
      nodeCount = nodes.length
      for (const n of nodes) {
        cpuCapacity    += parseCpu(n.status?.capacity?.cpu    ?? '0')
        memoryCapacity += parseMemGiB(n.status?.capacity?.memory ?? '0Ki')
      }
    }
    if (nsr.ok) namespaceCount = ((await nsr.json()).items ?? []).length
    if (pr.ok) {
      const pods: any[] = (await pr.json()).items ?? []
      podCount = pods.filter(p => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed').length
    }

    // metrics-server (optional — not installed on all clusters)
    try {
      const mr = await fetch(`${k8sUrl}/apis/metrics.k8s.io/v1beta1/nodes`, { signal: AbortSignal.timeout(5000) })
      if (mr.ok) {
        const metrics: any[] = (await mr.json()).items ?? []
        for (const m of metrics) {
          cpuUsed    += parseNanoCores(m.usage?.cpu    ?? '0')
          memoryUsed += parseMemGiB(m.usage?.memory ?? '0Ki')
        }
      }
    } catch { /* metrics-server not installed */ }

  } catch { /* unreachable */ }

  return {
    version, status,
    nodeCount, namespaceCount, podCount,
    cpuCapacity:    round2(cpuCapacity),
    memoryCapacity: round2(memoryCapacity),
    cpuUsed:        round2(cpuUsed),
    memoryUsed:     round2(memoryUsed),
    lastProbed:       new Date().toISOString(),
    lastProbedStatus: status,
  }
}

// ── Auto-discover service URLs from K8s API ──────────────────────────────
interface DiscoveredUrls {
  alertmanagerUrl: string; lokiUrl: string; jaegerUrl: string; grafanaUrl: string
}

async function discoverServiceUrls(k8sUrl: string, TO: number): Promise<DiscoveredUrls> {
  const result: DiscoveredUrls = { alertmanagerUrl: '', lokiUrl: '', jaegerUrl: '', grafanaUrl: '' }

  // Pattern → { key, preferredPort } mapping for well-known monitoring services
  const matchers: Array<{ key: keyof DiscoveredUrls; pattern: RegExp; port: number }> = [
    { key: 'alertmanagerUrl', pattern: /alertmanager/i,              port: 9093 },
    { key: 'lokiUrl',         pattern: /^loki$/i,                    port: 3100 },
    { key: 'grafanaUrl',      pattern: /grafana/i,                   port: 80   },
    { key: 'jaegerUrl',       pattern: /jaeger.*(query|ui|all)/i,    port: 16686 },
  ]

  const namespaces = ['monitoring', 'observability', 'logging', 'tracing']

  for (const ns of namespaces) {
    // Stop early if all four found
    if (Object.values(result).every(Boolean)) break
    try {
      const r = await fetch(`${k8sUrl}/api/v1/namespaces/${ns}/services`, {
        signal: AbortSignal.timeout(TO),
      })
      if (!r.ok) continue
      const services: any[] = (await r.json()).items ?? []

      for (const svc of services) {
        const svcName: string = svc.metadata?.name ?? ''
        const ports: number[] = (svc.spec?.ports ?? []).map((p: any) => Number(p.port))

        for (const m of matchers) {
          if (result[m.key]) continue              // already discovered
          if (!m.pattern.test(svcName)) continue

          // Prefer the well-known port; fall back to the first port the service exposes
          const port = ports.includes(m.port) ? m.port : (ports[0] ?? m.port)
          const proxyUrl = `${k8sUrl}/api/v1/namespaces/${ns}/services/${svcName}:${port}/proxy`

          try {
            const pr = await fetch(proxyUrl, { signal: AbortSignal.timeout(3000) })
            // Accept any response that isn't a 5xx server error (404/302 from the proxied
            // service itself still means the proxy path is valid)
            if (pr.status < 500) result[m.key] = proxyUrl
          } catch { /* proxy path not reachable */ }
        }
      }
    } catch { /* namespace not accessible */ }
  }

  // Jaeger fallback: try the well-known direct port on the same host as k8sUrl
  if (!result.jaegerUrl) {
    try {
      const base = new URL(k8sUrl)
      const jaegerDirect = `${base.protocol}//${base.hostname}:16686`
      const jr = await fetch(`${jaegerDirect}/api/services`, { signal: AbortSignal.timeout(3000) })
      if (jr.ok) result.jaegerUrl = jaegerDirect
    } catch { /* Jaeger not on default port */ }
  }

  return result
}

// ── GET — list all clusters ──────────────────────────────────────────────
export async function GET() {
  return NextResponse.json(readClusters())
}

// ── POST — register a new cluster ────────────────────────────────────────
export async function POST(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny
  const session = await auth()

  const body = await req.json()
  const {
    name, k8sUrl, promUrl, alertmanagerUrl, lokiUrl, jaegerUrl, grafanaUrl,
    provider, region, environment, description, tags,
  } = body as {
    name: string; k8sUrl: string; promUrl?: string
    alertmanagerUrl?: string; lokiUrl?: string; jaegerUrl?: string; grafanaUrl?: string
    provider?: string; region?: string
    environment?: string; description?: string; tags?: string[]
  }

  if (!name?.trim() || !k8sUrl?.trim()) {
    return NextResponse.json({ error: 'name and k8sUrl are required' }, { status: 400 })
  }

  const p   = await probeCluster(k8sUrl.trim())
  const now = new Date().toISOString()

  // Auto-discover service URLs for any fields the user left blank
  const needsDiscovery = !alertmanagerUrl?.trim() || !lokiUrl?.trim() || !jaegerUrl?.trim() || !grafanaUrl?.trim()
  const disc = (p.status === 'healthy' && needsDiscovery)
    ? await discoverServiceUrls(k8sUrl.trim(), K8S_TIMEOUT_MS)
    : { alertmanagerUrl: '', lokiUrl: '', jaegerUrl: '', grafanaUrl: '' }

  const existing = readClusters()
  // First cluster ever becomes the default automatically
  const isFirstCluster = existing.length === 0

  const cluster: K8sCluster = {
    id:               `cluster-${Date.now()}`,
    name:             name.trim(),
    provider:         (provider ?? 'on-prem') as K8sCluster['provider'],
    region:           region ?? '',
    environment:      (environment ?? 'production') as K8sCluster['environment'],
    description:      description ?? '',
    tags:             tags ?? [],
    version:          p.version,
    status:           p.status,
    nodeCount:        p.nodeCount,
    podCount:         p.podCount,
    namespaceCount:   p.namespaceCount,
    cpuCapacity:      p.cpuCapacity,    cpuUsed:      p.cpuUsed,
    memoryCapacity:   p.memoryCapacity, memoryUsed:   p.memoryUsed,
    storageCapacity:  0,                storageUsed:  0,
    networkInMbps:    0,                networkOutMbps: 0,
    createdAt:        now,
    createdBy:        (session?.user as any)?.email ?? 'system',
    updatedAt:        now,
    lastProbed:       p.lastProbed,
    lastProbedStatus: p.lastProbedStatus,
    k8sUrl:           k8sUrl.trim(),
    promUrl:          promUrl?.trim()          ?? '',
    alertmanagerUrl:  alertmanagerUrl?.trim()  || disc.alertmanagerUrl,
    lokiUrl:          lokiUrl?.trim()          || disc.lokiUrl,
    jaegerUrl:        jaegerUrl?.trim()        || disc.jaegerUrl,
    grafanaUrl:       grafanaUrl?.trim()       || disc.grafanaUrl,
    isDefault:        isFirstCluster,
  }

  writeClusters([...existing, cluster])
  return NextResponse.json(cluster, { status: 201 })
}

// ── PATCH — update cluster settings (also handles ?setDefault=1) ────────
export async function PATCH(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny
  const session = await auth()
  const url = new URL(req.url)

  // ── Set-default mode ─────────────────────────────────────────────────
  if (url.searchParams.get('setDefault') === '1') {
    const { id } = await req.json() as { id: string }
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    const clusters = readClusters()
    if (!clusters.find(c => c.id === id)) return NextResponse.json({ error: 'cluster not found' }, { status: 404 })
    const updated = clusters.map(c => ({ ...c, isDefault: c.id === id }))
    writeClusters(updated)
    return NextResponse.json(updated.find(c => c.id === id))
  }

  // ── Normal update mode ────────────────────────────────────────────────
  const body = await req.json() as {
    id: string; name?: string; k8sUrl?: string; promUrl?: string
    alertmanagerUrl?: string; lokiUrl?: string; jaegerUrl?: string; grafanaUrl?: string
    provider?: string; region?: string
    environment?: string; description?: string; tags?: string[]
  }
  const { id } = body
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const clusters = readClusters()
  const existing = clusters.find(c => c.id === id)
  if (!existing) return NextResponse.json({ error: 'cluster not found' }, { status: 404 })

  const newK8sUrl = body.k8sUrl?.trim() ?? existing.k8sUrl ?? ''
  const urlChanged = !!newK8sUrl && newK8sUrl !== existing.k8sUrl

  let probeFields: Partial<K8sCluster> = {}
  if (urlChanged) {
    const p = await probeCluster(newK8sUrl)
    probeFields = {
      version: p.version, status: p.status,
      nodeCount: p.nodeCount, namespaceCount: p.namespaceCount, podCount: p.podCount,
      cpuCapacity: p.cpuCapacity, memoryCapacity: p.memoryCapacity,
      cpuUsed: p.cpuUsed, memoryUsed: p.memoryUsed,
      lastProbed: p.lastProbed, lastProbedStatus: p.lastProbedStatus,
    }
  }

  const updated: K8sCluster = {
    ...existing,
    ...(body.name?.trim()              && { name:        body.name.trim() }),
    ...(body.provider                  && { provider:    body.provider as K8sCluster['provider'] }),
    ...(body.region      !== undefined && { region:      body.region ?? '' }),
    ...(body.environment !== undefined && { environment: body.environment as K8sCluster['environment'] }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.tags        !== undefined && { tags:        body.tags }),
    k8sUrl:          newK8sUrl,
    promUrl:         body.promUrl?.trim()         ?? existing.promUrl         ?? '',
    alertmanagerUrl: body.alertmanagerUrl?.trim() ?? existing.alertmanagerUrl ?? '',
    lokiUrl:         body.lokiUrl?.trim()         ?? existing.lokiUrl         ?? '',
    jaegerUrl:       body.jaegerUrl?.trim()       ?? existing.jaegerUrl       ?? '',
    grafanaUrl:      body.grafanaUrl?.trim()      ?? existing.grafanaUrl      ?? '',
    updatedAt:       new Date().toISOString(),
    updatedBy:       (session?.user as any)?.email ?? 'system',
    ...probeFields,
  }

  writeClusters(clusters.map(c => c.id === id ? updated : c))
  return NextResponse.json(updated)
}

// ── PUT — re-probe a cluster to refresh live stats ───────────────────────
export async function PUT(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny

  const { id } = await req.json() as { id: string }
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const clusters = readClusters()
  const existing = clusters.find(c => c.id === id)
  if (!existing) return NextResponse.json({ error: 'cluster not found' }, { status: 404 })

  const k8sUrl = existing.k8sUrl ?? ''
  if (!k8sUrl) return NextResponse.json({ error: 'cluster has no k8sUrl configured' }, { status: 422 })

  const p = await probeCluster(k8sUrl)

  // Fill in any service URLs that were previously blank
  const needsDiscovery = !existing.alertmanagerUrl || !existing.lokiUrl || !existing.jaegerUrl || !existing.grafanaUrl
  const disc = (p.status === 'healthy' && needsDiscovery)
    ? await discoverServiceUrls(k8sUrl, K8S_TIMEOUT_MS)
    : { alertmanagerUrl: '', lokiUrl: '', jaegerUrl: '', grafanaUrl: '' }

  const updated: K8sCluster = {
    ...existing,
    version:          p.version,
    status:           p.status,
    nodeCount:        p.nodeCount,
    namespaceCount:   p.namespaceCount,
    podCount:         p.podCount,
    cpuCapacity:      p.cpuCapacity,
    memoryCapacity:   p.memoryCapacity,
    cpuUsed:          p.cpuUsed,
    memoryUsed:       p.memoryUsed,
    lastProbed:       p.lastProbed,
    lastProbedStatus: p.lastProbedStatus,
    updatedAt:        new Date().toISOString(),
    alertmanagerUrl:  existing.alertmanagerUrl || disc.alertmanagerUrl,
    lokiUrl:          existing.lokiUrl         || disc.lokiUrl,
    jaegerUrl:        existing.jaegerUrl       || disc.jaegerUrl,
    grafanaUrl:       existing.grafanaUrl      || disc.grafanaUrl,
  }

  writeClusters(clusters.map(c => c.id === id ? updated : c))
  return NextResponse.json(updated)
}

// ── DELETE — remove a cluster ────────────────────────────────────────────
export async function DELETE(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny

  const { id } = await req.json() as { id: string }
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const all = readClusters()
  const wasDefault = all.find(c => c.id === id)?.isDefault ?? false
  const remaining = all.filter(c => c.id !== id)
  // If we deleted the default cluster, promote the first remaining one
  if (wasDefault && remaining.length > 0) {
    const first = remaining[0]!
    remaining[0] = { ...first, isDefault: true }
  }
  writeClusters(remaining)
  return NextResponse.json({ ok: true })
}
