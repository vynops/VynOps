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

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })
  try {
    const data = await k8sGet('/apis/apiextensions.k8s.io/v1/customresourcedefinitions')
    const crds = (data.items ?? []).map((crd: any) => {
      const established = (crd.status?.conditions ?? []).some(
        (c: any) => c.type === 'Established' && c.status === 'True',
      )
      const versions = (crd.spec?.versions ?? []).filter((v: any) => v.served)
      return {
        name: crd.metadata.name,
        group: crd.spec?.group ?? '',
        scope: crd.spec?.scope ?? 'Namespaced',
        kind: crd.spec?.names?.kind ?? '',
        plural: crd.spec?.names?.plural ?? '',
        versions: versions.map((v: any) => ({
          name: v.name,
          storage: !!v.storage,
          deprecated: v.deprecated ?? false,
        })),
        established,
        createdAt: crd.metadata.creationTimestamp,
      }
    }).sort((a: any, b: any) => a.group.localeCompare(b.group) || a.kind.localeCompare(b.kind))

    return NextResponse.json({ crds })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}