import { NextResponse } from 'next/server'
import { auth }         from '@/lib/auth'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'

const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

async function timed(url: string, timeout = 6000): Promise<{ ok: boolean; latencyMs: number; data: any; err?: string }> {
  const t0 = Date.now()
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), next: { revalidate: 0 } } as RequestInit)
    const latencyMs = Date.now() - t0
    if (!r.ok) return { ok: false, latencyMs, data: null, err: `HTTP ${r.status}` }
    const data = await r.json()
    return { ok: true, latencyMs, data }
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - t0, data: null, err: e?.message ?? 'timeout' }
  }
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [K8S, PROM] = await Promise.all([resolveK8sUrl(), resolvePromUrl()])

  const NC = { ok: false, latencyMs: 0, data: null, err: 'Not configured' }

  const [k8sVer, k8sNodes, k8sNs, promBuild, promRuntime, promTargets] = await Promise.all([
    K8S  ? timed(`${K8S}/version`)                      : Promise.resolve(NC),
    K8S  ? timed(`${K8S}/api/v1/nodes`)                 : Promise.resolve(NC),
    K8S  ? timed(`${K8S}/api/v1/namespaces`)            : Promise.resolve(NC),
    PROM ? timed(`${PROM}/api/v1/status/buildinfo`)     : Promise.resolve(NC),
    PROM ? timed(`${PROM}/api/v1/status/runtimeinfo`)   : Promise.resolve(NC),
    PROM ? timed(`${PROM}/api/v1/targets`)              : Promise.resolve(NC),
  ])

  const nodeItems: any[]     = k8sNodes.data?.items ?? []
  const nsItems: any[]       = k8sNs.data?.items    ?? []
  const userNs               = nsItems.filter(n => !SYSTEM_NS.has(n.metadata?.name ?? ''))
  const activeTargets: any[] = promTargets.data?.data?.activeTargets ?? []
  const upTargets            = activeTargets.filter(t => t.health === 'up').length
  const downTargets          = activeTargets.length - upTargets

  return NextResponse.json({
    k8s: {
      ok:               k8sVer.ok,
      latencyMs:        k8sVer.latencyMs,
      error:            k8sVer.err ?? null,
      version:          k8sVer.data?.gitVersion    ?? null,
      major:            k8sVer.data?.major         ?? null,
      minor:            k8sVer.data?.minor         ?? null,
      platform:         k8sVer.data?.platform      ?? null,
      nodeCount:        nodeItems.length,
      namespaceCount:   nsItems.length,
      userNsCount:      userNs.length,
      nodes: nodeItems.map(n => ({
        name:    n.metadata?.name,
        ready:   (n.status?.conditions ?? []).find((c: any) => c.type === 'Ready')?.status === 'True',
        version: n.status?.nodeInfo?.kubeletVersion,
        os:      n.status?.nodeInfo?.operatingSystem,
        arch:    n.status?.nodeInfo?.architecture,
        cpu:     n.status?.capacity?.cpu,
        memory:  n.status?.capacity?.memory,
      })),
    },
    prometheus: {
      ok:            promBuild.ok,
      latencyMs:     promBuild.latencyMs,
      error:         promBuild.err ?? null,
      version:       promBuild.data?.data?.version     ?? null,
      goVersion:     promBuild.data?.data?.goVersion   ?? null,
      buildDate:     promBuild.data?.data?.buildDate   ?? null,
      startTime:     promRuntime.data?.data?.startTime ?? null,
      lastConfig:    promRuntime.data?.data?.lastConfigTime ?? null,
      reloadOk:      promRuntime.data?.data?.reloadConfigSuccess ?? null,
      totalTargets:  activeTargets.length,
      upTargets,
      downTargets,
    },
    checkedAt: new Date().toISOString(),
  })
}
