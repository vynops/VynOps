import { NextRequest, NextResponse } from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { resolveK8sUrl } from '@/lib/cluster'


export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  if (!K8S) return NextResponse.json({ ok: true, source: 'mock' })

  const { namespace, name } = await params

  try {
    const body = await req.json().catch(() => ({}))
    const { rsName } = body

    if (!rsName) {
      return NextResponse.json({ ok: false, error: 'rsName required' }, { status: 400 })
    }

    // 1. Fetch the target ReplicaSet
    const rsRes = await fetch(
      `${K8S}/apis/apps/v1/namespaces/${namespace}/replicasets/${rsName}`,
      { headers: { Accept: 'application/json' } },
    )
    if (!rsRes.ok) {
      return NextResponse.json({ ok: false, error: `ReplicaSet not found: ${rsName}` }, { status: 404 })
    }
    const rs = await rsRes.json()
    const template = rs.spec?.template
    if (!template) {
      return NextResponse.json({ ok: false, error: 'RS has no pod template' }, { status: 400 })
    }

    // 2. PATCH deployment spec.template with RS's template
    //    This is what `kubectl rollout undo --to-revision=N` does under the hood
    const patch = { spec: { template } }
    const res = await fetch(
      `${K8S}/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/strategic-merge-patch+json', Accept: 'application/json' },
        body: JSON.stringify(patch),
      },
    )

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ ok: false, error: text }, { status: res.status })
    }

    return NextResponse.json({ ok: true, message: `Rolled back ${namespace}/${name} to RS ${rsName}` })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
