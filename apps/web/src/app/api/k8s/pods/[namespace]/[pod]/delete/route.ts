import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'
import { assertOperator } from '@/lib/rbac'


export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ namespace: string; pod: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  const { namespace, pod } = await params
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const res = await fetch(
      `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}`,
      {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
        body: JSON.stringify({ gracePeriodSeconds: 0 }),
      },
    )
    if (!res.ok) {
      const msg = await res.text()
      return NextResponse.json({ error: msg || `K8s returned ${res.status}` }, { status: res.status })
    }
    return NextResponse.json({ ok: true, pod, namespace })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
