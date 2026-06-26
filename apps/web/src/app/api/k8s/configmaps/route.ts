import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

const SKIP_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } })
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const data = await k8sGet('/api/v1/configmaps?limit=500')
  const items: any[] = data.items ?? []

  const configmaps = items
    .filter(cm => !SKIP_NS.has(cm.metadata?.namespace ?? ''))
    .map(cm => {
      const rawData: Record<string, string> = cm.data ?? {}
      const keys = Object.keys(rawData)
      const sizeBytes = keys.reduce((a, k) => a + (rawData[k]?.length ?? 0), 0)
      // Truncate large values to 512 chars to keep response manageable
      const data: Record<string, string> = {}
      for (const k of keys.slice(0, 50)) {
        const v = rawData[k] ?? ''
        data[k] = v.length > 512 ? v.slice(0, 512) + '…[truncated]' : v
      }
      return {
        name:       cm.metadata.name,
        namespace:  cm.metadata.namespace ?? 'default',
        keyCount:   keys.length,
        sizeBytes,
        keys,
        data,
        createdAt:  cm.metadata.creationTimestamp ?? null,
        immutable:  cm.immutable ?? false,
      }
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

  return NextResponse.json({ configmaps })
}