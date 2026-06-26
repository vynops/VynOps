import { NextRequest, NextResponse } from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { resolveK8sUrl } from '@/lib/cluster'


export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  if (!K8S) return NextResponse.json({ ok: true, source: 'mock' })
  const { namespace, name } = await params
  const { replicas } = await req.json()
  if (typeof replicas !== 'number') return NextResponse.json({ ok: false, error: 'replicas required' }, { status: 400 })
  try {
    const r = await fetch(
      `${K8S}/apis/apps/v1/namespaces/${namespace}/statefulsets/${name}/scale`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/merge-patch+json' }, body: JSON.stringify({ spec: { replicas } }) },
    )
    const j = await r.json()
    return NextResponse.json(r.ok ? { ok: true } : { ok: false, error: j.message })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 502 })
  }
}
