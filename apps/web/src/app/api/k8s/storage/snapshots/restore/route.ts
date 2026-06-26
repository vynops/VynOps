import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'
import { assertOperator } from '@/lib/rbac'


async function k8sPost(path: string, body: unknown) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) throw new Error('K8S_API_URL not configured')
  const res = await fetch(`${K8S}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    const msg = await res.text()
    throw new Error(msg || `K8s returned ${res.status}`)
  }
  return res.json()
}

// POST /api/k8s/storage/snapshots/restore
// Body: { snapshotName, namespace, newPvcName, storageClass, accessMode, sizeGi }
export async function POST(req: Request) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { snapshotName, namespace, newPvcName, storageClass, accessMode, sizeGi } = body
  if (!snapshotName || !namespace || !newPvcName) {
    return NextResponse.json({ error: 'snapshotName, namespace, newPvcName are required' }, { status: 400 })
  }

  const sizeStr = sizeGi ? `${sizeGi}Gi` : '1Gi'
  const mode = accessMode ?? 'ReadWriteOnce'

  const pvcManifest = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: newPvcName, namespace },
    spec: {
      accessModes: [mode],
      resources: { requests: { storage: sizeStr } },
      ...(storageClass ? { storageClassName: storageClass } : {}),
      dataSource: {
        name: snapshotName,
        kind: 'VolumeSnapshot',
        apiGroup: 'snapshot.storage.k8s.io',
      },
    },
  }

  try {
    const result = await k8sPost(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims`,
      pvcManifest,
    )
    return NextResponse.json({ ok: true, name: result.metadata?.name ?? newPvcName, namespace })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
