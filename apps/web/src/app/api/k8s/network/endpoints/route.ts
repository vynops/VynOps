import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  try {
    const r = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    return r.json()
  } catch { return null }
}

export async function GET() {
  try {
    const [epsData, svcData] = await Promise.all([
      k8sGet('/api/v1/endpoints'),
      k8sGet('/api/v1/services'),
    ])

    const svcMap: Record<string, any> = {}
    for (const svc of (svcData?.items ?? [])) {
      svcMap[`${svc.metadata.namespace}/${svc.metadata.name}`] = svc
    }

    const services: any[] = []
    for (const ep of (epsData?.items ?? [])) {
      const ns   = ep.metadata.namespace as string
      const name = ep.metadata.name as string
      if (name === 'kubernetes') continue // skip internal

      const svc = svcMap[`${ns}/${name}`]
      if (!svc) continue

      let ready    = 0
      let notReady = 0
      const readyAddresses:    { ip: string; nodeName?: string; targetRef?: string }[] = []
      const notReadyAddresses: { ip: string; nodeName?: string; targetRef?: string }[] = []

      for (const subset of (ep.subsets ?? [])) {
        for (const addr of (subset.addresses ?? [])) {
          ready++
          readyAddresses.push({
            ip: addr.ip,
            nodeName: addr.nodeName,
            targetRef: addr.targetRef?.name,
          })
        }
        for (const addr of (subset.notReadyAddresses ?? [])) {
          notReady++
          notReadyAddresses.push({
            ip: addr.ip,
            nodeName: addr.nodeName,
            targetRef: addr.targetRef?.name,
          })
        }
      }

      const totalPorts = (ep.subsets?.[0]?.ports ?? []).map((p: any) => `${p.name ?? ''}:${p.port}/${p.protocol}`).join(', ')

      // Services with no pod selector and no endpoints are intentional stubs
      // (e.g. kube-prometheus scraping targets for k3s embedded components)
      const hasSelector = svc.spec?.selector && Object.keys(svc.spec.selector).length > 0
      const isHeadlessStub = !hasSelector && ready === 0 && notReady === 0

      const status: 'healthy' | 'degraded' | 'down' | 'headless' =
        isHeadlessStub                ? 'headless' :
        ready === 0 && notReady === 0 ? 'down' :
        notReady > 0 && ready === 0   ? 'down' :
        notReady > 0                  ? 'degraded' : 'healthy'

      services.push({
        name,
        namespace: ns,
        type: svc.spec?.type ?? 'ClusterIP',
        clusterIP: svc.spec?.clusterIP,
        ports: totalPorts,
        ready,
        notReady,
        total: ready + notReady,
        status,
        readyAddresses,
        notReadyAddresses,
      })
    }

    // Sort: down first, then degraded, then healthy, headless last
    services.sort((a, b) => {
      const order: Record<string, number> = { down: 0, degraded: 1, healthy: 2, headless: 3 }
      return (order[a.status] ?? 2) - (order[b.status] ?? 2)
    })

    const stats = {
      total:    services.filter(s => s.status !== 'headless').length,
      healthy:  services.filter(s => s.status === 'healthy').length,
      degraded: services.filter(s => s.status === 'degraded').length,
      down:     services.filter(s => s.status === 'down').length,
    }

    return NextResponse.json({ services, stats })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}