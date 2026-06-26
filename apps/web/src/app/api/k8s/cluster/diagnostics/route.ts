import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function k8sGet(path: string): Promise<any> {
  const K8S = await resolveK8sUrl()
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

async function promScalar(query: string): Promise<number | null> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    const j = await r.json()
    const v = j.data?.result?.[0]?.value?.[1]
    return v !== undefined ? parseFloat(v) : null
  } catch { return null }
}

async function promResults(query: string): Promise<any[]> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    const j = await r.json()
    return j.data?.result ?? []
  } catch { return [] }
}

const ADDON_CHECKS = [
  { key: 'coredns',           label: 'CoreDNS',            match: (n: string) => n.includes('coredns') },
  { key: 'metrics-server',    label: 'Metrics Server',     match: (n: string) => n.includes('metrics-server') },
  { key: 'kube-proxy',        label: 'kube-proxy',         match: (n: string) => n.includes('kube-proxy') },
  { key: 'ingress',           label: 'Ingress Controller', match: (n: string) => n.includes('ingress') },
  { key: 'cluster-autoscaler',label: 'Cluster Autoscaler', match: (n: string) => n.includes('cluster-autoscaler') },
  { key: 'cni',               label: 'CNI / eBPF',         match: (n: string) => n.includes('retina') || n.includes('cilium') || n.includes('calico') || n.includes('flannel') },
]

export async function GET() {
  const [
    componentStatuses,
    kubeSystemPods,
    allNodes,
    nodeInfoResults,
    schedActiveResult,
    schedBackoffResult,
    schedGatedResult,
    schedUnschedResult,
    apiserverRate,
    apiserverP99,
    apiserverErrPct,
    recentEvents,
  ] = await Promise.all([
    k8sGet('/api/v1/componentstatuses'),
    k8sGet('/api/v1/namespaces/kube-system/pods'),
    k8sGet('/api/v1/nodes'),

    promResults('kube_node_info'),
    promScalar('max(scheduler_pending_pods{queue="active"})'),
    promScalar('max(scheduler_pending_pods{queue="backoff"})'),
    promScalar('max(scheduler_pending_pods{queue="gated"})'),
    promScalar('max(scheduler_pending_pods{queue="unschedulable"})'),

    promScalar('round(sum(rate(apiserver_request_total[5m])),0.01)'),
    promScalar('round(histogram_quantile(0.99,sum(rate(apiserver_request_duration_seconds_bucket{subresource!="log",verb!~"WATCH|CONNECT"}[5m]))by(le))*1000,0.1)'),
    promScalar('round(sum(rate(apiserver_request_total{code=~"5.."}[5m]))/sum(rate(apiserver_request_total[5m]))*100,0.01)'),

    k8sGet('/api/v1/events?fieldSelector=type!=Normal&limit=30'),
  ])

  // ── Component statuses ────────────────────────────────────────────────────────
  const components = (componentStatuses.items ?? []).map((c: any) => {
    const cond = (c.conditions ?? []).find((x: any) => x.type === 'Healthy')
    return {
      name:    c.metadata?.name ?? 'unknown',
      healthy: cond?.status === 'True',
      message: cond?.message ?? '',
      error:   cond?.error   ?? '',
    }
  })

  // ── Node version skew (from kube-state-metrics) ───────────────────────────────
  const nodeVersions: { node: string; kubeletVersion: string; kernelVersion: string; osImage: string }[] = []
  const kubeletVersionSet = new Set<string>()

  for (const r of nodeInfoResults) {
    const m = r.metric ?? {}
    nodeVersions.push({
      node:           m.node ?? '?',
      kubeletVersion: m.kubelet_version ?? '?',
      kernelVersion:  m.kernel_version ?? '?',
      osImage:        m.os_image ?? '?',
    })
    if (m.kubelet_version) kubeletVersionSet.add(m.kubelet_version)
  }
  // ── Fallback: use the already-fetched allNodes for version skew if Prometheus empty ──
  if (nodeVersions.length === 0) {
    for (const n of (allNodes.items ?? [])) {
      const v = n.status?.nodeInfo?.kubeletVersion ?? '?'
      nodeVersions.push({
        node:           n.metadata?.name ?? '?',
        kubeletVersion: v,
        kernelVersion:  n.status?.nodeInfo?.kernelVersion ?? '?',
        osImage:        n.status?.nodeInfo?.osImage ?? '?',
      })
      if (v !== '?') kubeletVersionSet.add(v)
    }
  }
  const versionSkew = kubeletVersionSet.size > 1

  // ── Node conditions ────────────────────────────────────────────────────────────
  type NodeCondition = { node: string; condition: string; status: boolean; reason: string; message: string }
  const BAD_CONDITIONS = ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable']
  const nodeConditions: NodeCondition[] = []
  for (const n of (allNodes.items ?? [])) {
    const nodeName: string = n.metadata?.name ?? '?'
    for (const cond of (n.status?.conditions ?? [])) {
      if (!BAD_CONDITIONS.includes(cond.type)) continue
      const active = cond.status === 'True'
      if (active) {
        nodeConditions.push({
          node:      nodeName,
          condition: cond.type,
          status:    true,
          reason:    cond.reason ?? '',
          message:   cond.message ?? '',
        })
      }
    }
  }

  // ── Node taints ─────────────────────────────────────────────────────────────────
  type NodeTaint = { node: string; key: string; effect: string; value?: string }
  const nodeTaints: NodeTaint[] = []
  for (const n of (allNodes.items ?? [])) {
    const nodeName: string = n.metadata?.name ?? '?'
    for (const t of (n.spec?.taints ?? [])) {
      nodeTaints.push({ node: nodeName, key: t.key, effect: t.effect, value: t.value })
    }
  }

  // ── Cluster-level warning events ─────────────────────────────────────────────
  type K8sEvent = { namespace: string; name: string; kind: string; reason: string; message: string; count: number; lastTime: string; firstTime: string }
  const events: K8sEvent[] = (recentEvents.items ?? [])
    .sort((a: any, b: any) => {
      const at = a.lastTimestamp ?? a.eventTime ?? ''
      const bt = b.lastTimestamp ?? b.eventTime ?? ''
      return bt.localeCompare(at)
    })
    .slice(0, 20)
    .map((e: any) => ({
      namespace: e.metadata?.namespace ?? '',
      name:      e.involvedObject?.name ?? '',
      kind:      e.involvedObject?.kind ?? '',
      reason:    e.reason ?? '',
      message:   (e.message ?? '').slice(0, 200),
      count:     e.count ?? 1,
      lastTime:  e.lastTimestamp ?? e.eventTime ?? '',
      firstTime: e.firstTimestamp ?? e.eventTime ?? '',
    }))

  // ── Addon detection from kube-system pods ─────────────────────────────────────
  const sysPods: string[] = (kubeSystemPods.items ?? []).map((p: any) => p.metadata?.name ?? '')
  const sysPodFull: { name: string; phase: string; ready: boolean }[] = (kubeSystemPods.items ?? []).map((p: any) => ({
    name:  p.metadata?.name ?? '',
    phase: p.status?.phase ?? 'Unknown',
    ready: (p.status?.conditions ?? []).find((c: any) => c.type === 'Ready')?.status === 'True',
  }))

  const addons = ADDON_CHECKS.map(a => {
    const pod = sysPodFull.find(p => a.match(p.name))
    return {
      key:    a.key,
      label:  a.label,
      found:  !!pod,
      ready:  pod?.ready ?? false,
      podName: pod?.name ?? null,
    }
  })

  // ── Scheduler pending ─────────────────────────────────────────────────────────
  const schedulerPending = {
    active:        schedActiveResult  ?? 0,
    backoff:       schedBackoffResult ?? 0,
    gated:         schedGatedResult   ?? 0,
    unschedulable: schedUnschedResult ?? 0,
  }

  return NextResponse.json({
    apiServer: {
      requestRatePerSec: apiserverRate  ?? null,
      p99LatencyMs:      apiserverP99   ?? null,
      errorRatePct:      apiserverErrPct ?? null,
    },
    components,
    nodeVersions,
    versionSkew,
    addons,
    schedulerPending,
    nodeConditions,
    nodeTaints,
    events,
  })
}