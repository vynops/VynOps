import { NextRequest, NextResponse } from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { resolveK8sUrl } from '@/lib/cluster'


export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  if (!K8S) return NextResponse.json({ ok: true, source: 'mock' })
  const { namespace, name } = await params

  try {
    const r = await fetch(
      `${K8S}/apis/batch/v1/namespaces/${namespace}/jobs/${name}?propagationPolicy=Background`,
      { method: 'DELETE', headers: { Accept: 'application/json' } },
    )
    const j = await r.json()
    return NextResponse.json(r.ok ? { ok: true } : { ok: false, error: j.message })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
