import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'
import { assertOperator, getSessionUserId } from '@/lib/rbac'
import { appendAuditLog } from '@/app/api/settings/config/shared'


// PATCH scale
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  const { namespace, name } = await params
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { replicas } = await req.json().catch(() => ({}))
  if (typeof replicas !== 'number' || !Number.isInteger(replicas) || replicas < 0 || replicas > 1000)
    return NextResponse.json({ error: 'Invalid replicas value' }, { status: 400 })

  try {
    const res = await fetch(
      `${K8S}/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}/scale`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', Accept: 'application/json' },
        body: JSON.stringify({ spec: { replicas } }),
      },
    )
    if (!res.ok) {
      const msg = await res.text()
      return NextResponse.json({ error: msg || `K8s returned ${res.status}` }, { status: res.status })
    }
    appendAuditLog({
      ts: new Date().toISOString(),
      user: (await getSessionUserId()) ?? 'authenticated-user',
      action: 'deployment.scale',
      detail: `${namespace}/${name} to ${replicas} replicas`,
    })
    return NextResponse.json({ ok: true, replicas })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
