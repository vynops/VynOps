import { NextRequest, NextResponse } from 'next/server'
import { assertOperator, getSessionUserId } from '@/lib/rbac'
import { appendAuditLog } from '@/app/api/settings/config/shared'
import { resolveK8sUrl } from '@/lib/cluster'


export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  if (!K8S) return NextResponse.json({ ok: false, error: 'K8S_API_URL not configured' }, { status: 503 })

  const { namespace, name } = await params

  try {
    const body = await req.json().catch(() => ({}))
    const { rsName } = body

    if (typeof rsName !== 'string' || !rsName) {
      return NextResponse.json({ ok: false, error: 'rsName required' }, { status: 400 })
    }

    // 1. Fetch the target ReplicaSet
    const rsRes = await fetch(
      `${K8S}/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets/${encodeURIComponent(rsName)}`,
      { headers: { Accept: 'application/json' } },
    )
    if (!rsRes.ok) {
      return NextResponse.json({ ok: false, error: `ReplicaSet not found: ${rsName}` }, { status: 404 })
    }
    const rs = await rsRes.json()
    const owned = (rs.metadata?.ownerReferences ?? []).some((o: any) => o.kind === 'Deployment' && o.name === name)
    if (!owned) {
      return NextResponse.json({ ok: false, error: `ReplicaSet ${rsName} does not belong to deployment ${name}` }, { status: 400 })
    }
    if (!rs.spec?.template) {
      return NextResponse.json({ ok: false, error: 'RS has no pod template' }, { status: 400 })
    }

    // 2. PATCH deployment spec.template with RS's template (kubectl drops the pod-template-hash label first)
    const template = JSON.parse(JSON.stringify(rs.spec.template))
    if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash']
    const patch = { spec: { template } }
    const res = await fetch(
      `${K8S}/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
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

    appendAuditLog({
      ts: new Date().toISOString(),
      user: (await getSessionUserId()) ?? 'authenticated-user',
      action: 'deployment.rollback',
      detail: `${namespace}/${name} to ${rsName}`,
    })
    return NextResponse.json({ ok: true, message: `Rolled back ${namespace}/${name} to RS ${rsName}` })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
