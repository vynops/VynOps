import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return { items: [] }
  try {
    const r = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    } as RequestInit)
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

function mapCfg(items: any[], kind: 'Validating' | 'Mutating') {
  return items.map((cfg: any) => ({
    name: cfg.metadata.name,
    kind,
    webhookCount: (cfg.webhooks ?? []).length,
    webhooks: (cfg.webhooks ?? []).map((wh: any) => ({
      name: wh.name,
      failurePolicy: wh.failurePolicy ?? 'Ignore',
      sideEffects: wh.sideEffects ?? 'Unknown',
      service: wh.clientConfig?.service
        ? `${wh.clientConfig.service.namespace}/${wh.clientConfig.service.name}`
        : (wh.clientConfig?.url ?? '—'),
      operations: (wh.rules ?? [])
        .flatMap((r: any) => r.operations ?? [])
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i),
      resources: (wh.rules ?? [])
        .flatMap((r: any) => r.resources ?? [])
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
        .slice(0, 8),
    })),
    createdAt: cfg.metadata.creationTimestamp,
  }))
}

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })
  try {
    const [valData, mutData] = await Promise.all([
      k8sGet('/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations'),
      k8sGet('/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations'),
    ])
    return NextResponse.json({
      validating: mapCfg(valData.items ?? [], 'Validating'),
      mutating:   mapCfg(mutData.items ?? [], 'Mutating'),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}