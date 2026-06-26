import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'
import { assertOperator } from '@/lib/rbac'


export async function POST(
  req: Request,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  const { namespace, name } = await params
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { newSizeGi } = await req.json() as { newSizeGi: number }
  if (!newSizeGi || newSizeGi <= 0) {
    return NextResponse.json({ error: 'newSizeGi must be a positive number' }, { status: 400 })
  }

  try {
    // Fetch current PVC to validate new size is larger
    const getRes = await fetch(
      `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(name)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) },
    )
    if (!getRes.ok) return NextResponse.json({ error: 'PVC not found' }, { status: 404 })
    const pvc = await getRes.json()
    const currentStorage = pvc.spec?.resources?.requests?.storage ?? '0Gi'
    const currentGi = parseFloat(currentStorage.replace(/[^0-9.]/g, ''))
    if (newSizeGi <= currentGi) {
      return NextResponse.json({ error: `New size (${newSizeGi}Gi) must be larger than current (${currentGi}Gi)` }, { status: 400 })
    }

    // Patch storage request
    const patchRes = await fetch(
      `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(name)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', Accept: 'application/json' },
        body: JSON.stringify({ spec: { resources: { requests: { storage: `${newSizeGi}Gi` } } } }),
        signal: AbortSignal.timeout(8000),
      },
    )
    if (!patchRes.ok) {
      const msg = await patchRes.text()
      return NextResponse.json({ error: msg || `K8s returned ${patchRes.status}` }, { status: patchRes.status })
    }
    return NextResponse.json({ ok: true, namespace, name, newSize: `${newSizeGi}Gi` })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
