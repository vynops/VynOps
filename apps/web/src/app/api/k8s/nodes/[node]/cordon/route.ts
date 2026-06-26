import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'
import { assertOperator } from '@/lib/rbac'


export async function POST(
  req: Request,
  { params }: { params: Promise<{ node: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  const { node } = await params
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { action } = await req.json() as { action: 'cordon' | 'uncordon' }
  if (action !== 'cordon' && action !== 'uncordon')
    return NextResponse.json({ error: 'action must be cordon or uncordon' }, { status: 400 })

  const unschedulable = action === 'cordon'

  try {
    const res = await fetch(
      `${K8S}/api/v1/nodes/${encodeURIComponent(node)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', Accept: 'application/json' },
        body: JSON.stringify({ spec: { unschedulable } }),
      },
    )
    if (!res.ok) {
      const msg = await res.text()
      return NextResponse.json({ error: msg || `K8s returned ${res.status}` }, { status: res.status })
    }
    return NextResponse.json({ ok: true, node, action })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
