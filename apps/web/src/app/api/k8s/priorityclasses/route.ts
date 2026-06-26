import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const res = await fetch(`${K8S}/apis/scheduling.k8s.io/v1/priorityclasses`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    const data = res.ok ? await res.json() : { items: [] }

    const priorityClasses = (data.items ?? [])
      .map((pc: any) => ({
        name:             pc.metadata.name,
        value:            pc.value ?? 0,
        globalDefault:    pc.globalDefault ?? false,
        preemptionPolicy: pc.preemptionPolicy ?? 'PreemptLowerPriority',
        description:      pc.description ?? '',
        createdAt:        pc.metadata.creationTimestamp,
      }))
      .sort((a: any, b: any) => b.value - a.value)   // highest priority first

    return NextResponse.json({ priorityClasses })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}