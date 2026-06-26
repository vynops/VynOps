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

  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: { 'vynops.io/restartedAt': new Date().toISOString() },
        },
      },
    },
  }

  const r = await fetch(
    `${K8S}/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/daemonsets/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/strategic-merge-patch+json',
        Accept: 'application/json',
      },
      body: JSON.stringify(patch),
    },
  )

  if (!r.ok) {
    const text = await r.text()
    return NextResponse.json({ error: text }, { status: r.status })
  }

  return NextResponse.json({ ok: true })
}
