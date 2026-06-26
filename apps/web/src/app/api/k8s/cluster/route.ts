import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolveClusterMeta, K8S_TIMEOUT_MS } from '@/lib/cluster'

async function k8sGet(k8sUrl: string, path: string) {
  try {
    const res = await fetch(`${k8sUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    return res.json()
  } catch { return null }
}

export async function GET() {
  const K8S = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const [meta, versionData, nsData] = await Promise.all([
    resolveClusterMeta(),
    k8sGet(K8S, '/version'),
    k8sGet(K8S, '/api/v1/namespaces'),
  ])

  return NextResponse.json({
    id:             meta?.name     ?? K8S,
    name:           meta?.name     ?? '—',
    provider:       meta?.provider ?? 'on-prem',
    region:         meta?.region   ?? '—',
    version:        versionData?.gitVersion ?? '—',
    namespaceCount: (nsData?.items ?? []).length,
    k8sUrl:         K8S,
  })
}