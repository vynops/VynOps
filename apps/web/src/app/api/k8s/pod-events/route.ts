import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


export async function GET(req: Request) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ events: [] })
  const { searchParams } = new URL(req.url)
  const ns   = searchParams.get('namespace') ?? ''
  const name = searchParams.get('name') ?? ''
  if (!ns || !name) return NextResponse.json({ events: [] })

  try {
    const r = await fetch(
      `${K8S}/api/v1/namespaces/${encodeURIComponent(ns)}/events` +
      `?fieldSelector=involvedObject.name=${encodeURIComponent(name)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } },
    )
    if (!r.ok) return NextResponse.json({ events: [] })
    const j = await r.json()

    const events = (j.items ?? [])
      .map((e: any) => ({
        type:      e.type ?? 'Normal',
        reason:    e.reason ?? '',
        message:   e.message ?? '',
        count:     e.count ?? 1,
        component: e.source?.component ?? '',
        firstTime: e.firstTimestamp ?? e.eventTime,
        lastTime:  e.lastTimestamp  ?? e.eventTime,
      }))
      .sort((a: any, b: any) =>
        new Date(b.lastTime ?? 0).getTime() - new Date(a.lastTime ?? 0).getTime()
      )
      .slice(0, 15)

    return NextResponse.json({ events })
  } catch {
    return NextResponse.json({ events: [] })
  }
}