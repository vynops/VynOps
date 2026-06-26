import { NextResponse } from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { resolveK8sUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

export async function POST(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny
  const K8S = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { statefulSetName, namespace } = await req.json()
  if (!statefulSetName || !namespace) {
    return NextResponse.json({ error: 'statefulSetName and namespace required' }, { status: 400 })
  }

  try {
    // Get all pods in this namespace
    const allPodsRes = await fetch(
      `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS) },
    )
    const allPodsData = await allPodsRes.json()

    const pods = (allPodsData.items ?? []).filter((pod: any) =>
      pod.metadata.ownerReferences?.some(
        (o: any) => o.kind === 'StatefulSet' && o.name === statefulSetName,
      ),
    )

    if (pods.length === 0) {
      return NextResponse.json({ ok: false, error: 'No pods found for this StatefulSet' }, { status: 404 })
    }

    // Delete in reverse ordinal order (pod-2 before pod-1 before pod-0)
    const sorted = [...pods].sort((a: any, b: any) =>
      b.metadata.name.localeCompare(a.metadata.name),
    )

    let restarted = 0, failed = 0
    for (const pod of sorted) {
      try {
        const delRes = await fetch(
          `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${pod.metadata.name}`,
          { method: 'DELETE', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) },
        )
        if (delRes.ok || delRes.status === 404) restarted++; else failed++
      } catch {
        failed++
      }
    }

    return NextResponse.json({ ok: true, statefulSetName, namespace, restarted, failed })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}