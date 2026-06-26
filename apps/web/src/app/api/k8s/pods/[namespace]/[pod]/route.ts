import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'


export async function GET(
  _req: Request,
  { params }: { params: Promise<{ namespace: string; pod: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const { namespace, pod } = await params
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const res = await fetch(
      `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 0 } },
    )
    if (!res.ok) return NextResponse.json({ error: `K8s returned ${res.status}` }, { status: res.status })
    const p = await res.json()

    return NextResponse.json({
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      labels: p.metadata.labels ?? {},
      annotations: Object.fromEntries(
        Object.entries(p.metadata.annotations ?? {}).filter(([k]) => !k.startsWith('kubectl.kubernetes.io')),
      ),
      podIP: p.status?.podIP,
      hostIP: p.status?.hostIP,
      nodeName: p.spec?.nodeName,
      serviceAccount: p.spec?.serviceAccountName,
      qosClass: p.status?.qosClass,
      phase: p.status?.phase,
      startTime: p.status?.startTime,
      createdAt: p.metadata.creationTimestamp,
      conditions: (p.status?.conditions ?? []).map((c: any) => ({
        type: c.type,
        status: c.status,
        lastTransitionTime: c.lastTransitionTime,
        reason: c.reason,
        message: c.message,
      })),
      volumes: (p.spec?.volumes ?? []).map((v: any) => ({
        name: v.name,
        type: v.configMap ? 'ConfigMap' : v.secret ? 'Secret' : v.persistentVolumeClaim ? 'PVC' : v.emptyDir ? 'EmptyDir' : v.hostPath ? 'HostPath' : 'Other',
        source: v.configMap?.name ?? v.secret?.secretName ?? v.persistentVolumeClaim?.claimName ?? v.hostPath?.path ?? '',
      })),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
