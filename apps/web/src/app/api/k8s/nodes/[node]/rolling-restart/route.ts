import { NextResponse } from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { resolveK8sUrl } from '@/lib/cluster'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ node: string }> },
) {
  const deny = await assertOperator()
  if (deny) return deny
  const K8S = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })
  const { node } = await params

  try {
    const podsRes = await fetch(
      `${K8S}/api/v1/pods?fieldSelector=spec.nodeName=${encodeURIComponent(node)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
    )
    const podsData = await podsRes.json()

    const pods = (podsData.items ?? []).filter((pod: any) => {
      const owners = pod.metadata.ownerReferences ?? []
      return !owners.some((o: any) => o.kind === 'DaemonSet' || o.kind === 'Node')
        && pod.status?.phase !== 'Succeeded'
        && pod.status?.phase !== 'Failed'
    })

    let restarted = 0
    let failed = 0
    const results: { name: string; namespace: string; ok: boolean }[] = []

    for (const pod of pods) {
      try {
        const delRes = await fetch(
          `${K8S}/api/v1/namespaces/${pod.metadata.namespace}/pods/${pod.metadata.name}`,
          {
            method: 'DELETE',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ gracePeriodSeconds: 30 }),
            signal: AbortSignal.timeout(10000),
          },
        )
        const ok = delRes.ok || delRes.status === 404
        if (ok) restarted++; else failed++
        results.push({ name: pod.metadata.name, namespace: pod.metadata.namespace, ok })
      } catch {
        failed++
        results.push({ name: pod.metadata.name, namespace: pod.metadata.namespace, ok: false })
      }
    }

    return NextResponse.json({ ok: true, node, restarted, failed, total: pods.length, results })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
