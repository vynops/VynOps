import { NextResponse } from 'next/server'
import { auth }         from '@/lib/auth'
import { resolveK8sUrl, resolvePromUrl, resolveAlertmanagerUrl, resolveLokiUrl, resolveJaegerUrl, resolveGrafanaUrl, resolveCouchbaseCreds } from '@/lib/cluster'

async function probe(
  url: string,
  checkPath: string,
  opts: { timeout?: number; headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; latencyMs: number; detail: string | null }> {
  if (!url) return { ok: false, latencyMs: 0, detail: 'Not configured' }
  const t0 = Date.now()
  try {
    const r = await fetch(`${url}${checkPath}`, {
      signal: AbortSignal.timeout(opts.timeout ?? 5000),
      headers: opts.headers,
      cache: 'no-store',
    })
    const latencyMs = Date.now() - t0
    if (r.ok) return { ok: true, latencyMs, detail: null }
    return { ok: false, latencyMs, detail: `HTTP ${r.status}` }
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - t0, detail: e?.message ?? 'Unreachable' }
  }
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [K8S, PROM, JAEGER, GRAFANA, LOKI] = await Promise.all([
    resolveK8sUrl(), resolvePromUrl(), resolveJaegerUrl(), resolveGrafanaUrl(), resolveLokiUrl(),
  ])

  const cbCreds = await resolveCouchbaseCreds(K8S)
  const COUCHBASE = cbCreds.url.replace(/\/$/, '')
  const cbAuth = cbCreds.pass
    ? { Authorization: 'Basic ' + Buffer.from(`${cbCreds.user}:${cbCreds.pass}`).toString('base64') }
    : undefined

  const [k8s, prom, couchbase, jaeger, grafana, loki] = await Promise.all([
    probe(K8S,       '/version'),
    probe(PROM,      '/api/v1/status/runtimeinfo'),
    probe(COUCHBASE, '/pools', { headers: cbAuth }),
    probe(JAEGER,    '/api/services'),
    probe(GRAFANA,   '/api/health'),
    probe(LOKI,      '/ready'),
  ])

  return NextResponse.json({
    sources: [
      {
        id: 'k8s',
        label: 'Kubernetes API',
        category: 'Orchestration',
        url: K8S,
        envVar: 'K8S_API_URL',
        ...k8s,
      },
      {
        id: 'prometheus',
        label: 'Prometheus',
        category: 'Metrics',
        url: PROM,
        envVar: 'PROMETHEUS_URL',
        ...prom,
      },
      {
        id: 'jaeger',
        label: 'Jaeger',
        category: 'Tracing',
        url: JAEGER,
        envVar: 'JAEGER_QUERY_URL',
        ...jaeger,
      },
      {
        id: 'couchbase',
        label: 'Couchbase',
        category: 'Database',
        url: COUCHBASE,
        envVar: 'COUCHBASE_URL',
        ...couchbase,
      },
      {
        id: 'grafana',
        label: 'Grafana',
        category: 'Visualisation',
        url: GRAFANA,
        displayUrl: 'monitoring/monitoring-grafana:80 (via K8s proxy)',
        envVar: 'GRAFANA_URL',
        ...grafana,
      },
      {
        id: 'loki',
        label: 'Loki',
        category: 'Logs',
        url: LOKI,
        displayUrl: 'monitoring/loki:3100 (via K8s proxy)',
        envVar: 'LOKI_URL',
        ...loki,
      },
    ],
  })
}
