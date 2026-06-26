import { NextResponse } from 'next/server'
import { resolvePromUrl, K8S_TIMEOUT_MS } from '@/lib/cluster'

async function promRange(
  PROM: string, query: string, minutes: number, step: number,
): Promise<{ ts: number; value: number }[]> {
  try {
    const now   = Math.floor(Date.now() / 1000)
    const start = now - minutes * 60
    const url   = `${PROM}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${now}&step=${step}`
    const r     = await fetch(url, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } } as RequestInit)
    const j     = await r.json()
    const vals: [number, string][] = j.data?.result?.[0]?.values ?? []
    return vals.map(([t, v]) => ({ ts: t * 1000, value: parseFloat(parseFloat(v).toFixed(4)) }))
  } catch { return [] }
}

async function promRangeAll(
  PROM: string, query: string, minutes: number, step: number,
): Promise<Array<{ metric: Record<string, string>; values: { ts: number; value: number }[] }>> {
  try {
    const now   = Math.floor(Date.now() / 1000)
    const start = now - minutes * 60
    const url   = `${PROM}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${now}&step=${step}`
    const r     = await fetch(url, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } } as RequestInit)
    const j     = await r.json()
    return (j.data?.result ?? []).map((res: any) => ({
      metric: res.metric as Record<string, string>,
      values: (res.values ?? []).map(([t, v]: [number, string]) => ({
        ts: t * 1000, value: parseFloat(parseFloat(v).toFixed(4)),
      }))
    }))
  } catch { return [] }
}

const WINDOWS: Record<string, { minutes: number; step: number; label: string }> = {
  '1h':  { minutes: 60,    step: 60,    label: '1 Hour'   },
  '6h':  { minutes: 360,   step: 300,   label: '6 Hours'  },
  '24h': { minutes: 1440,  step: 3600,  label: '24 Hours' },
  '7d':  { minutes: 10080, step: 21600, label: '7 Days'   },
  '30d': { minutes: 43200, step: 86400, label: '30 Days'  },
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const win = searchParams.get('window') ?? '1h'
  const wc  = WINDOWS[win] ?? WINDOWS['1h']!

  const PROM = await resolvePromUrl()

  // p50 / p95 / p99 histograms — fleet-wide (sum across all ingresses)
  const rateQuery  = `sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le)`
  const p50Query   = `histogram_quantile(0.50, ${rateQuery})`
  const p95Query   = `histogram_quantile(0.95, ${rateQuery})`
  const p99Query   = `histogram_quantile(0.99, ${rateQuery})`
  const rpsQuery   = `sum(rate(nginx_ingress_controller_requests_total[2m]))`
  const errQuery   = `sum(rate(nginx_ingress_controller_requests_total{status=~"5.."}[2m])) or vector(0)`

  // Per-ingress p95 (latest value only for top table)
  const perIngressQ = `histogram_quantile(0.95, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le, ingress, service, namespace))`

  const [p50h, p95h, p99h, rpsh, errh, perIngress] = await Promise.all([
    promRange(PROM, p50Query, wc.minutes, wc.step),
    promRange(PROM, p95Query, wc.minutes, wc.step),
    promRange(PROM, p99Query, wc.minutes, wc.step),
    promRange(PROM, rpsQuery, wc.minutes, wc.step),
    promRange(PROM, errQuery, wc.minutes, wc.step),
    promRangeAll(PROM, perIngressQ, Math.min(wc.minutes, 60), Math.min(wc.step, 300)),
  ])

  // Current values (last point)
  const last = (arr: { value: number }[]) => arr.length > 0 ? arr[arr.length - 1]!.value : null

  // Per-ingress summary: latest p95
  const services = perIngress.map(r => ({
    ingress:   r.metric.ingress   ?? r.metric.service ?? 'unknown',
    service:   r.metric.service   ?? '',
    namespace: r.metric.namespace ?? '',
    p95ms: r.values.length > 0
      ? parseFloat(((r.values[r.values.length - 1]!.value) * 1000).toFixed(1))
      : null,
  })).filter(s => s.p95ms !== null && s.p95ms > 0)
    .sort((a, b) => (b.p95ms ?? 0) - (a.p95ms ?? 0))
    .slice(0, 20)

  // Convert seconds → milliseconds for display
  const toMs = (arr: { ts: number; value: number }[]) =>
    arr.map(p => ({ ts: p.ts, value: parseFloat((p.value * 1000).toFixed(2)) }))

  const hasData = p95h.length > 0

  return NextResponse.json({
    window: win,
    windowLabel: wc.label,
    hasData,
    current: {
      p50ms:  last(p50h) !== null ? parseFloat(((last(p50h) ?? 0) * 1000).toFixed(2)) : null,
      p95ms:  last(p95h) !== null ? parseFloat(((last(p95h) ?? 0) * 1000).toFixed(2)) : null,
      p99ms:  last(p99h) !== null ? parseFloat(((last(p99h) ?? 0) * 1000).toFixed(2)) : null,
      rps:    last(rpsh) !== null ? parseFloat((last(rpsh) ?? 0).toFixed(3)) : null,
      errRps: last(errh) !== null ? parseFloat((last(errh) ?? 0).toFixed(4)) : null,
    },
    history: {
      p50: toMs(p50h),
      p95: toMs(p95h),
      p99: toMs(p99h),
      rps: rpsh,
      err: errh,
    },
    services,
    source: hasData ? 'live' : 'no_data',
  })
}
