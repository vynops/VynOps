import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'


export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const [quotaRes, nsRes, lrRes] = await Promise.all([
      fetch(`${K8S}/api/v1/resourcequotas`, { headers: { Accept: 'application/json' }, next: { revalidate: 0 } }),
      fetch(`${K8S}/api/v1/namespaces`, { headers: { Accept: 'application/json' }, next: { revalidate: 0 } }),
      fetch(`${K8S}/api/v1/limitranges`, { headers: { Accept: 'application/json' }, next: { revalidate: 0 } }),
    ])
    const [data, nsData, lrData] = await Promise.all([quotaRes.json(), nsRes.json(), lrRes.json()])

    const quotas = (data.items ?? []).map((q: any) => {
      const hard = q.status?.hard ?? {}
      const used = q.status?.used ?? {}

      return {
        name: q.metadata.name,
        namespace: q.metadata.namespace,
        cpuRequestUsed: parseCPU(used['requests.cpu']),
        cpuRequestLimit: parseCPU(hard['requests.cpu']),
        cpuLimitUsed: parseCPU(used['limits.cpu']),
        cpuLimitLimit: parseCPU(hard['limits.cpu']),
        memRequestUsed: parseMem(used['requests.memory']),
        memRequestLimit: parseMem(hard['requests.memory']),
        memLimitUsed: parseMem(used['limits.memory']),
        memLimitLimit: parseMem(hard['limits.memory']),
        podUsed: parseInt(used.pods ?? '0'),
        podLimit: parseInt(hard.pods ?? '0'),
        pvcUsed: parseInt(used['persistentvolumeclaims'] ?? '0'),
        pvcLimit: parseInt(hard['persistentvolumeclaims'] ?? '0') || undefined,
        serviceUsed: parseInt(used.services ?? '0'),
        serviceLimit: parseInt(hard.services ?? '0') || undefined,
      }
    })

    const namespaces = (nsData.items ?? []).map((ns: any) => ({
      name: ns.metadata.name,
      status: ns.status?.phase ?? 'Active',
      createdAt: ns.metadata.creationTimestamp,
      labels: ns.metadata.labels ?? {},
    }))

    const limitranges = (lrData.items ?? []).map((lr: any) => ({
      name: lr.metadata.name,
      namespace: lr.metadata.namespace,
      limits: (lr.spec?.limits ?? []).map((l: any) => ({
        type: l.type,
        resource: Object.keys(l.default ?? l.max ?? {})[0] ?? 'cpu',
        default: l.default ?? {},
        defaultRequest: l.defaultRequest ?? {},
        max: l.max ?? {},
        min: l.min ?? {},
      })),
    }))

    return NextResponse.json({ quotas, namespaces, limitranges })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}

function parseCPU(s?: string): number {
  if (!s) return 0
  if (s.endsWith('m')) return parseFloat(s) / 1000
  return parseFloat(s)
}

function parseMem(s?: string): number {
  if (!s) return 0
  if (s.endsWith('Gi')) return parseFloat(s)
  if (s.endsWith('Mi')) return parseFloat(s) / 1024
  if (s.endsWith('Ki')) return parseFloat(s) / (1024 ** 2)
  if (s.endsWith('G')) return parseFloat(s) * 0.931
  if (s.endsWith('M')) return parseFloat(s) * 0.000931
  return parseFloat(s) / (1024 ** 3)
}
