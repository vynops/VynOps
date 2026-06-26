import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

const SNAPSHOT_API = '/apis/snapshot.storage.k8s.io/v1'

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ snapshots: [], crdAvailable: false })

  try {
    const res = await fetch(`${K8S}${SNAPSHOT_API}/volumesnapshots`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    if (!res.ok) return NextResponse.json({ snapshots: [], crdAvailable: false })

    const data = await res.json()
    const snapshots = (data.items ?? []).map((s: any) => ({
      name: s.metadata.name,
      namespace: s.metadata.namespace,
      sourcePVC: s.spec.source?.persistentVolumeClaimName ?? '',
      snapshotClass: s.spec.volumeSnapshotClassName ?? '',
      readyToUse: s.status?.readyToUse ?? false,
      restoreSize: s.status?.restoreSize ?? '',
      error: s.status?.error?.message ?? null,
      createdAt: s.metadata.creationTimestamp,
    }))
    return NextResponse.json({ snapshots, crdAvailable: true })
  } catch {
    return NextResponse.json({ snapshots: [], crdAvailable: false })
  }
}

export async function POST(req: Request) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { name, namespace, pvcName, snapshotClassName } = await req.json()
  if (!name || !namespace || !pvcName) {
    return NextResponse.json({ error: 'name, namespace and pvcName are required' }, { status: 400 })
  }

  const body: any = {
    apiVersion: 'snapshot.storage.k8s.io/v1',
    kind: 'VolumeSnapshot',
    metadata: { name, namespace },
    spec: { source: { persistentVolumeClaimName: pvcName } },
  }
  if (snapshotClassName) body.spec.volumeSnapshotClassName = snapshotClassName

  try {
    const res = await fetch(
      `${K8S}${SNAPSHOT_API}/namespaces/${encodeURIComponent(namespace)}/volumesnapshots`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      },
    )
    if (!res.ok) {
      const msg = await res.text()
      return NextResponse.json({ error: msg }, { status: res.status })
    }
    return NextResponse.json({ ok: true, name, namespace })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}

export async function DELETE(req: Request) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const name = searchParams.get('name') ?? ''
  const namespace = searchParams.get('namespace') ?? ''

  try {
    const res = await fetch(
      `${K8S}${SNAPSHOT_API}/namespaces/${encodeURIComponent(namespace)}/volumesnapshots/${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS) },
    )
    if (!res.ok) return NextResponse.json({ error: `K8s returned ${res.status}` }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}