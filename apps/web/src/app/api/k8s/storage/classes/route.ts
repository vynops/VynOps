import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


export async function POST(req: Request) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const {
    name, provisioner, reclaimPolicy = 'Delete',
    volumeBindingMode = 'Immediate', allowVolumeExpansion = true,
    parameters = '', isDefault = false,
  } = await req.json()

  if (!name?.trim() || !provisioner?.trim()) {
    return NextResponse.json({ error: 'name and provisioner are required' }, { status: 400 })
  }

  const annotations: Record<string, string> = {}
  if (isDefault) annotations['storageclass.kubernetes.io/is-default-class'] = 'true'

  const params: Record<string, string> = {}
  for (const pair of (parameters as string).split(',')) {
    const [k, ...rest] = pair.trim().split('=')
    const v = rest.join('=').trim()
    if (k?.trim() && v) params[k.trim()] = v
  }

  const body: any = {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: name.trim(), annotations },
    provisioner: provisioner.trim(),
    reclaimPolicy,
    volumeBindingMode,
    allowVolumeExpansion,
  }
  if (Object.keys(params).length > 0) body.parameters = params

  try {
    const res = await fetch(`${K8S}/apis/storage.k8s.io/v1/storageclasses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    if (!res.ok) {
      const msg = await res.text()
      return NextResponse.json({ error: msg }, { status: res.status })
    }
    return NextResponse.json({ ok: true, name: name.trim() })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}