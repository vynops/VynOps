import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'
import { assertOperator } from '@/lib/rbac'


export async function POST(
  _req: Request,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  const { namespace, name } = await params
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    // Trigger rollout restart by patching restartedAt annotation
    const res = await fetch(
      `${K8S}/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/strategic-merge-patch+json', Accept: 'application/json' },
        body: JSON.stringify({
          spec: {
            template: {
              metadata: {
                annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() },
              },
            },
          },
        }),
      },
    )
    if (!res.ok) {
      const msg = await res.text()
      return NextResponse.json({ error: msg || `K8s returned ${res.status}` }, { status: res.status })
    }
    return NextResponse.json({ ok: true, message: `Rollout restart triggered for ${name}` })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
