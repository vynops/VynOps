import { NextRequest, NextResponse } from 'next/server'
import { resolveK8sUrl } from '@/lib/cluster'


async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return { items: [] }
  try {
    const r = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 0 },
    })
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ revisions: [] })
  const { namespace, name } = await params

  try {
    const rsData = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/replicasets`)
    const rsList = (rsData.items ?? []).filter((rs: any) =>
      rs.metadata?.ownerReferences?.some((o: any) => o.kind === 'Deployment' && o.name === name)
    )

    // Sort by revision annotation descending
    rsList.sort((a: any, b: any) => {
      const revA = parseInt(a.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? '0')
      const revB = parseInt(b.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? '0')
      return revB - revA
    })

    const revisions = rsList
      .filter((rs: any, i: number) => {
        // Include current RS (i===0) + previous ones that still have replicas tracked
        const rev = parseInt(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? '0')
        return rev > 0
      })
      .map((rs: any, i: number) => {
        const rev      = parseInt(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? '0')
        const image    = rs.spec?.template?.spec?.containers?.[0]?.image ?? 'unknown'
        const desired  = rs.spec?.replicas ?? 0
        const ready    = rs.status?.readyReplicas ?? 0
        const isCurrent = i === 0
        return {
          revision:   rev,
          rsName:     rs.metadata.name,
          image,
          imageTag:   image.includes(':') ? image.split(':').pop() : 'latest',
          desired,
          ready,
          current:    isCurrent,
          createdAt:  rs.metadata.creationTimestamp,
          containers: (rs.spec?.template?.spec?.containers ?? []).map((c: any) => ({
            name: c.name, image: c.image ?? '',
          })),
        }
      })

    return NextResponse.json({ revisions })
  } catch (err) {
    return NextResponse.json({ revisions: [], error: String(err) })
  }
}
