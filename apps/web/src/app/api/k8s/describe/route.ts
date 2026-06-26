import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


const RESOURCE_PATHS: Record<string, string> = {
  Deployment:             '/apis/apps/v1/namespaces/{ns}/deployments/{name}',
  StatefulSet:            '/apis/apps/v1/namespaces/{ns}/statefulsets/{name}',
  DaemonSet:              '/apis/apps/v1/namespaces/{ns}/daemonsets/{name}',
  Pod:                    '/api/v1/namespaces/{ns}/pods/{name}',
  Service:                '/api/v1/namespaces/{ns}/services/{name}',
  ConfigMap:              '/api/v1/namespaces/{ns}/configmaps/{name}',
  Ingress:                '/apis/networking.k8s.io/v1/namespaces/{ns}/ingresses/{name}',
  NetworkPolicy:          '/apis/networking.k8s.io/v1/namespaces/{ns}/networkpolicies/{name}',
  Namespace:              '/api/v1/namespaces/{name}',
  PodDisruptionBudget:    '/apis/policy/v1/namespaces/{ns}/poddisruptionbudgets/{name}',
  LimitRange:             '/api/v1/namespaces/{ns}/limitranges/{name}',
  ResourceQuota:          '/api/v1/namespaces/{ns}/resourcequotas/{name}',
  Role:                   '/apis/rbac.authorization.k8s.io/v1/namespaces/{ns}/roles/{name}',
  ClusterRole:            '/apis/rbac.authorization.k8s.io/v1/clusterroles/{name}',
  RoleBinding:            '/apis/rbac.authorization.k8s.io/v1/namespaces/{ns}/rolebindings/{name}',
  ClusterRoleBinding:     '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/{name}',
  ServiceAccount:         '/api/v1/namespaces/{ns}/serviceaccounts/{name}',
  PersistentVolumeClaim:  '/api/v1/namespaces/{ns}/persistentvolumeclaims/{name}',
  PersistentVolume:       '/api/v1/persistentvolumes/{name}',
  Node:                   '/api/v1/nodes/{name}',
  StorageClass:           '/apis/storage.k8s.io/v1/storageclasses/{name}',
}

async function k8sFetch(path: string) {
  const K8S  = await resolveK8sUrl()
  const res = await fetch(`${K8S}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`K8s returned ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function GET(req: Request) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const kind      = searchParams.get('kind') ?? 'Pod'
  const namespace = searchParams.get('namespace') ?? 'default'
  const name      = searchParams.get('name') ?? ''

  if (!name) return NextResponse.json({ error: 'name param required' }, { status: 400 })

  let resourcePath = RESOURCE_PATHS[kind]
  if (!resourcePath) return NextResponse.json({ error: `Unknown kind: ${kind}` }, { status: 400 })

  const isNamespaced = resourcePath.includes('{ns}')
  resourcePath = resourcePath
    .replace('/namespaces/{ns}', `/namespaces/${encodeURIComponent(namespace)}`)
    .replace('/{name}', `/${encodeURIComponent(name)}`)

  // Events scoped to the same namespace/name/kind
  // The fieldSelector value must be fully URL-encoded (kubectl uses %3D for the inner = signs)
  const eventSelector = encodeURIComponent(`involvedObject.name=${name},involvedObject.kind=${kind}`)
  const eventsPath = isNamespaced
    ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/events?fieldSelector=${eventSelector}`
    : `/api/v1/events?fieldSelector=${eventSelector}`

  try {
    const [resource, eventsResult] = await Promise.all([
      k8sFetch(resourcePath),
      k8sFetch(eventsPath).catch((e: unknown) => ({ items: [], _error: String(e) })),
    ])

    // Strip managed fields to reduce noise
    if (resource.metadata?.managedFields) delete resource.metadata.managedFields

    const eventsData = eventsResult as any
    const events = (eventsData.items ?? [])
      .sort((a: any, b: any) =>
        new Date(b.lastTimestamp ?? b.eventTime ?? 0).getTime() -
        new Date(a.lastTimestamp ?? a.eventTime ?? 0).getTime()
      )
      .map((e: any) => ({
        type:      e.type ?? 'Normal',
        reason:    e.reason ?? '',
        message:   e.message ?? '',
        source:    [e.source?.component, e.source?.host].filter(Boolean).join('/'),
        count:     e.count ?? 1,
        firstTime: e.firstTimestamp ?? e.eventTime ?? '',
        lastTime:  e.lastTimestamp  ?? e.eventTime ?? '',
      }))

    return NextResponse.json({
      resource,
      events,
      ...(eventsData._error ? { eventsError: eventsData._error } : {}),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}