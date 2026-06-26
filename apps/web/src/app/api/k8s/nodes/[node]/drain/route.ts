import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'
import { assertOperator } from '@/lib/rbac'


export async function POST(
  _req: Request,
  { params }: { params: Promise<{ node: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  const { node } = await params
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    // Step 1: Cordon the node
    const cordonRes = await fetch(`${K8S}/api/v1/nodes/${encodeURIComponent(node)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/merge-patch+json', Accept: 'application/json' },
      body: JSON.stringify({ spec: { unschedulable: true } }),
      signal: AbortSignal.timeout(8000),
    })
    if (!cordonRes.ok) {
      const msg = await cordonRes.text()
      return NextResponse.json({ error: `Cordon failed: ${msg}` }, { status: cordonRes.status })
    }

    // Step 2: List all pods on this node (exclude DaemonSet and static pods)
    const podsRes = await fetch(
      `${K8S}/api/v1/pods?fieldSelector=spec.nodeName=${encodeURIComponent(node)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
    )
    if (!podsRes.ok) return NextResponse.json({ error: 'Failed to list pods' }, { status: 502 })
    const podsData = await podsRes.json()

    const pods: any[] = (podsData.items ?? []).filter((p: any) => {
      const owners: any[] = p.metadata?.ownerReferences ?? []
      // Skip DaemonSet pods and mirror (static) pods
      const isDaemonSet = owners.some((o: any) => o.kind === 'DaemonSet')
      const isStatic = owners.some((o: any) => o.kind === 'Node') || (p.metadata?.annotations?.['kubernetes.io/config.mirror'])
      return !isDaemonSet && !isStatic
    })

    // Step 3: Evict each pod
    const evictions = await Promise.allSettled(
      pods.map((p: any) =>
        fetch(
          `${K8S}/api/v1/namespaces/${encodeURIComponent(p.metadata.namespace)}/pods/${encodeURIComponent(p.metadata.name)}/eviction`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              apiVersion: 'policy/v1',
              kind: 'Eviction',
              metadata: { name: p.metadata.name, namespace: p.metadata.namespace },
            }),
            signal: AbortSignal.timeout(10000),
          },
        ),
      ),
    )

    const evicted = evictions.filter(r => r.status === 'fulfilled').length
    const failed  = evictions.filter(r => r.status === 'rejected').length

    return NextResponse.json({ ok: true, node, cordoned: true, evicted, failed, totalPods: pods.length })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
