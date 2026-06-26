import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'
import { assertOperator, assertSession } from '@/lib/rbac'


const RESOURCE_PATHS: Record<string, string> = {
  Deployment: '/apis/apps/v1/namespaces/{ns}/deployments/{name}',
  StatefulSet: '/apis/apps/v1/namespaces/{ns}/statefulsets/{name}',
  DaemonSet: '/apis/apps/v1/namespaces/{ns}/daemonsets/{name}',
  Pod: '/api/v1/namespaces/{ns}/pods/{name}',
  Service: '/api/v1/namespaces/{ns}/services/{name}',
  ConfigMap: '/api/v1/namespaces/{ns}/configmaps/{name}',
  NetworkPolicy: '/apis/networking.k8s.io/v1/namespaces/{ns}/networkpolicies/{name}',
  Namespace: '/api/v1/namespaces/{name}',
  PodDisruptionBudget: '/apis/policy/v1/namespaces/{ns}/poddisruptionbudgets/{name}',
  LimitRange: '/api/v1/namespaces/{ns}/limitranges/{name}',
  ResourceQuota: '/api/v1/namespaces/{ns}/resourcequotas/{name}',
  Role: '/apis/rbac.authorization.k8s.io/v1/namespaces/{ns}/roles/{name}',
  ClusterRole: '/apis/rbac.authorization.k8s.io/v1/clusterroles/{name}',
  RoleBinding: '/apis/rbac.authorization.k8s.io/v1/namespaces/{ns}/rolebindings/{name}',
  ClusterRoleBinding: '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/{name}',
  ServiceAccount: '/api/v1/namespaces/{ns}/serviceaccounts/{name}',
  Node: '/api/v1/nodes/{name}',
  PersistentVolume: '/api/v1/persistentvolumes/{name}',
  PersistentVolumeClaim: '/api/v1/namespaces/{ns}/persistentvolumeclaims/{name}',
  StorageClass: '/apis/storage.k8s.io/v1/storageclasses/{name}',
}

export async function GET(req: Request) {
  const deny = await assertSession()
  if (deny) return deny

  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const kind = searchParams.get('kind') ?? 'Pod'
  const namespace = searchParams.get('namespace') ?? 'default'
  const name = searchParams.get('name') ?? ''

  let path = RESOURCE_PATHS[kind]
  if (!path) return NextResponse.json({ error: `Unknown kind: ${kind}` }, { status: 400 })

  path = path
    .replace('/namespaces/{ns}', `/namespaces/${encodeURIComponent(namespace)}`)
    .replace('/{name}', `/${encodeURIComponent(name)}`)

  try {
    const res = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    if (!res.ok) return NextResponse.json({ error: `K8s returned ${res.status}` }, { status: res.status })
    const data = await res.json()

    // Strip managed fields to reduce noise
    if (data.metadata?.managedFields) delete data.metadata.managedFields

    return NextResponse.json({ kind, namespace, name, yaml: JSON.stringify(data, null, 2) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}

// PATCH — apply edited YAML/JSON
export async function PATCH(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny

  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const kind = searchParams.get('kind') ?? 'Pod'
  const namespace = searchParams.get('namespace') ?? 'default'
  const name = searchParams.get('name') ?? ''

  const body = await req.text()
  let parsed: any
  try { parsed = JSON.parse(body) } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  let path = RESOURCE_PATHS[kind]
  if (!path) return NextResponse.json({ error: `Unknown kind: ${kind}` }, { status: 400 })
  path = path
    .replace('/namespaces/{ns}', `/namespaces/${encodeURIComponent(namespace)}`)
    .replace('/{name}', `/${encodeURIComponent(name)}`)

  try {
    const res = await fetch(`${K8S}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(parsed),
    })
    if (!res.ok) {
      const msg = await res.text()
      return NextResponse.json({ error: msg || `K8s returned ${res.status}` }, { status: res.status })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}