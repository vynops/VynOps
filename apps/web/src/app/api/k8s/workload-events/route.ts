import { NextRequest, NextResponse } from 'next/server'
import { resolveK8sUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


export async function GET(req: NextRequest) {
  const K8S  = await resolveK8sUrl()
  const { searchParams } = new URL(req.url)
  const namespace = searchParams.get('namespace')
  const kind      = searchParams.get('kind') ?? 'Deployment'
  const name      = searchParams.get('name')

  if (!namespace || !name) return NextResponse.json({ events: [] })
  if (!K8S) return NextResponse.json({ events: [] })

  try {
    const selector = `involvedObject.kind=${kind},involvedObject.name=${name},involvedObject.namespace=${namespace}`
    const r = await fetch(
      `${K8S}/api/v1/namespaces/${namespace}/events?fieldSelector=${encodeURIComponent(selector)}&limit=50`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } },
    )
    const data = r.ok ? await r.json() : { items: [] }

    const events = (data.items ?? [])
      .filter((e: any) => e.type === 'Warning')
      .sort((a: any, b: any) =>
        new Date(b.lastTimestamp ?? b.eventTime ?? 0).getTime() -
        new Date(a.lastTimestamp ?? a.eventTime ?? 0).getTime()
      )
      .slice(0, 10)
      .map((e: any) => ({
        type:          e.type,
        reason:        e.reason,
        message:       e.message,
        count:         e.count ?? 1,
        lastTimestamp: e.lastTimestamp ?? e.eventTime,
        source:        e.source?.component ?? '',
      }))

    return NextResponse.json({ events })
  } catch {
    return NextResponse.json({ events: [] })
  }
}