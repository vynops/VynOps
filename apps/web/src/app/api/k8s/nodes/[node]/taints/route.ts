import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'
import { assertOperator } from '@/lib/rbac'


export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ node: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })
  const { node } = await params

  const body = await req.json()
  const taints: { key: string; value?: string; effect: string }[] = body.taints ?? []

  try {
    const res = await fetch(`${K8S}/api/v1/nodes/${encodeURIComponent(node)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/strategic-merge-patch+json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ spec: { taints } }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const msg = await res.text()
      return NextResponse.json({ error: msg }, { status: res.status })
    }
    const data = await res.json()
    return NextResponse.json({ ok: true, taints: data.spec?.taints ?? [] })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
