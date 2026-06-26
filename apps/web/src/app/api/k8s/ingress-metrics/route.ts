import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

async function promQuery(q: string): Promise<any[]> {
  const PROM = await resolvePromUrl()
  if (!PROM) return []
  try {
    const res = await fetch(
      `${PROM}/api/v1/query?query=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) },
    )
    const json = await res.json()
    return json?.data?.result ?? []
  } catch { return [] }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const namespace = searchParams.get('namespace') ?? ''
  const name = searchParams.get('name') ?? ''

  const [
    nginxReq, nginxErr, nginxLat,
    traefikReq, traefikLat,
    nginxUp, traefikUp,
  ] = await Promise.all([
    // nginx-ingress-controller request metrics (available in v1.9 and earlier)
    promQuery(`sum(rate(nginx_ingress_controller_requests_total{exported_namespace="${namespace}",ingress="${name}"}[5m]))`),
    promQuery(`sum(rate(nginx_ingress_controller_requests_total{exported_namespace="${namespace}",ingress="${name}",status=~"[45].."}[5m]))`),
    promQuery(`histogram_quantile(0.95,sum by(le)(rate(nginx_ingress_controller_request_duration_seconds_bucket{exported_namespace="${namespace}",ingress="${name}"}[5m])))`),
    // Traefik metrics (k3s default)
    promQuery(`sum(rate(traefik_service_requests_total{exported_service=~"${namespace}-${name}@.*"}[5m]))`),
    promQuery(`histogram_quantile(0.95,sum by(le)(rate(traefik_service_request_duration_seconds_bucket{exported_service=~"${namespace}-${name}@.*"}[5m])))`),
    // Controller presence detection via Prometheus scrape target (works for all versions)
    promQuery(`up{job=~".*nginx.*"}`),
    promQuery(`up{job=~".*traefik.*"}`),
  ])

  const nginxTotal = parseFloat(nginxReq[0]?.value?.[1] ?? '0')
  const nginxErrTotal = parseFloat(nginxErr[0]?.value?.[1] ?? '0')

  const nginxMetrics = nginxReq.length > 0 ? {
    controller: 'nginx' as const,
    reqPerSec:   Math.round(nginxTotal * 1000) / 1000,
    errorRate:   nginxTotal > 0 ? Math.round((nginxErrTotal / nginxTotal) * 10000) / 100 : 0,
    p95LatencyMs: Math.round(parseFloat(nginxLat[0]?.value?.[1] ?? '0') * 1000),
  } : null

  const traefikMetrics = traefikReq.length > 0 ? {
    controller: 'traefik' as const,
    reqPerSec:    Math.round(parseFloat(traefikReq[0]?.value?.[1] ?? '0') * 1000) / 1000,
    errorRate:    0,
    p95LatencyMs: Math.round(parseFloat(traefikLat[0]?.value?.[1] ?? '0') * 1000),
  } : null

  const metrics = nginxMetrics ?? traefikMetrics

  // Detect controller presence even when request metrics aren't available (nginx v1.12+ removed Lua stats)
  const nginxControllerUp = nginxUp.some(r => r.value?.[1] === '1')
  const traefikControllerUp = traefikUp.some(r => r.value?.[1] === '1')
  const hasController = !!metrics || nginxControllerUp || traefikControllerUp

  // Identify which controller is present for the "no metrics yet" message
  const controllerType = metrics?.controller
    ?? (nginxControllerUp ? 'nginx' : traefikControllerUp ? 'traefik' : null)

  return NextResponse.json({ metrics, hasController, controllerType })
}