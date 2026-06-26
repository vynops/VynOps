import { headers } from 'next/headers'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'

/**
 * Read the default cluster from clusters.json (isDefault: true).
 * Falls back to env vars if clusters.json is missing or no default is set.
 */
function readDefaultCluster(): Record<string, string> {
  try {
    const file = join(process.cwd(), 'data', 'clusters.json')
    if (!existsSync(file)) return {}
    const clusters: Array<Record<string, string>> = JSON.parse(readFileSync(file, 'utf8'))
    return clusters.find(c => c.isDefault === true as any) ?? clusters[0] ?? {}
  } catch { return {} }
}

/**
 * Per-request K8s API URL resolver.
 *
 * Client code sends the `X-K8s-Url` header to route requests to a specific
 * registered cluster. Falls back to the default cluster in clusters.json,
 * then to K8S_API_URL env var.
 */
export function getK8sUrl(hdrs: Headers): string {
  const override = hdrs.get('x-k8s-url')
  if (override && override.startsWith('http')) return override.replace(/\/$/, '')
  const def = readDefaultCluster()
  return (def.k8sUrl ?? process.env.K8S_API_URL ?? '').replace(/\/$/, '')
}

/**
 * All async per-request URL resolvers.
 * Each reads a specific header forwarded by the client, falls back to the
 * default cluster in clusters.json, then to the matching env var.
 */
async function resolveHeader(header: string, clusterField: string, envVar: string, fallback = ''): Promise<string> {
  try {
    const h = await headers()
    const override = h.get(header)
    if (override === 'none') return ''           // cluster selected but this service not configured
    if (override?.startsWith('http')) return override.replace(/\/$/, '')
  } catch { /* not in a request context */ }
  const def = readDefaultCluster()
  const fromDefault = def[clusterField] as string | undefined
  if (fromDefault) return fromDefault.replace(/\/$/, '')
  return (process.env[envVar] ?? fallback).replace(/\/$/, '')
}

export const resolveK8sUrl          = () => resolveHeader('x-k8s-url',          'k8sUrl',          'K8S_API_URL')
export const resolvePromUrl         = () => resolveHeader('x-prom-url',         'promUrl',         'PROMETHEUS_URL')
export const resolveAlertmanagerUrl = () => resolveHeader('x-alertmanager-url', 'alertmanagerUrl', 'ALERTMANAGER_URL')
export const resolveLokiUrl         = () => resolveHeader('x-loki-url',         'lokiUrl',         'LOKI_URL')
export const resolveJaegerUrl       = () => resolveHeader('x-jaeger-url',       'jaegerUrl',       'JAEGER_QUERY_URL', 'http://localhost:16686')
export const resolveGrafanaUrl      = () => resolveHeader('x-grafana-url',      'grafanaUrl',      'GRAFANA_URL')

/**
 * Look up cluster metadata (name, provider, region) from clusters.json
 * by matching the resolved K8s URL. Returns null if not found.
 */
export async function resolveClusterMeta(): Promise<{ name: string; provider: string; region: string } | null> {
  try {
    const { readFileSync, existsSync } = await import('fs')
    const { join } = await import('path')
    const file = join(process.cwd(), 'data', 'clusters.json')
    if (!existsSync(file)) return null
    const clusters: Array<{ k8sUrl?: string; name?: string; provider?: string; region?: string }> =
      JSON.parse(readFileSync(file, 'utf8'))
    const k8sUrl = await resolveK8sUrl()
    const match = clusters.find(c => c.k8sUrl && c.k8sUrl.replace(/\/$/, '') === k8sUrl)
    if (!match) return null
    return { name: match.name ?? '—', provider: match.provider ?? '—', region: match.region ?? '' }
  } catch { return null }
}

/**
 * Configurable fetch timeout for K8s API requests.
 * Increase K8S_TIMEOUT_MS in .env.local for slow VPN connections.
 * Default: 15000ms (15s). Recommended for VPN: 20000–30000ms.
 */
export const K8S_TIMEOUT_MS = parseInt(process.env.K8S_TIMEOUT_MS ?? '8000', 10)

/**
 * Resolve Couchbase credentials for the active cluster.
 * Priority:
 *   1. clusters.json — couchbaseUrl/User/Pass for the matched cluster (per-cluster)
 *   2. .env.local    — COUCHBASE_URL / COUCHBASE_USER / COUCHBASE_PASS (global fallback)
 * Note: kubectl proxy strips Authorization headers, so couchbaseUrl must be a direct
 * NodePort/LoadBalancer URL, not a kubectl proxy path.
 * Resolved server-side only — never sent via headers.
 */
export async function resolveCouchbaseCreds(k8sUrl: string): Promise<{ url: string; user: string; pass: string }> {
  const envUser = process.env.COUCHBASE_USER ?? 'Administrator'
  const envPass = process.env.COUCHBASE_PASS ?? ''

  // 1 — per-cluster config in clusters.json
  try {
    const { readFileSync, existsSync } = await import('fs')
    const { join } = await import('path')
    const file = join(process.cwd(), 'data', 'clusters.json')
    if (existsSync(file)) {
      const clusters: Array<{ k8sUrl?: string; couchbaseUrl?: string; couchbaseUser?: string; couchbasePass?: string }> =
        JSON.parse(readFileSync(file, 'utf8'))
      const normalized = k8sUrl?.replace(/\/$/, '')
      const match = clusters.find(c => c.k8sUrl?.replace(/\/$/, '') === normalized)
      if (match) {
        // Cluster found — use its couchbase config (empty string = not installed on this cluster)
        return {
          url:  match.couchbaseUrl  ?? '',
          user: match.couchbaseUser || envUser,
          pass: match.couchbasePass || envPass,
        }
      }
    }
  } catch { /* fall through */ }

  // 2 — global .env.local fallback
  return {
    url:  process.env.COUCHBASE_URL ?? '',
    user: envUser,
    pass: envPass,
  }
}
