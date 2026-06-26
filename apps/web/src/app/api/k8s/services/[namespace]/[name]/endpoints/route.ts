import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'


export async function GET(
  _req: Request,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const { namespace, name } = await params
  if (!K8S) return NextResponse.json({ ready: [], notReady: [], ports: [] })

  try {
    const res = await fetch(
      `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/endpoints/${encodeURIComponent(name)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000), next: { revalidate: 0 } },
    )
    if (!res.ok) return NextResponse.json({ ready: [], notReady: [], ports: [] })
    const ep = await res.json()

    const ready:    { ip: string; pod: string; node: string }[] = []
    const notReady: { ip: string; pod: string; node: string }[] = []
    const portSet = new Set<string>()

    for (const subset of (ep.subsets ?? [])) {
      for (const port of (subset.ports ?? [])) {
        portSet.add(`${port.name ? port.name + ':' : ''}${port.port}/${port.protocol ?? 'TCP'}`)
      }
      for (const addr of (subset.addresses ?? [])) {
        ready.push({ ip: addr.ip, pod: addr.targetRef?.name ?? '', node: addr.nodeName ?? '' })
      }
      for (const addr of (subset.notReadyAddresses ?? [])) {
        notReady.push({ ip: addr.ip, pod: addr.targetRef?.name ?? '', node: addr.nodeName ?? '' })
      }
    }

    return NextResponse.json({ ready, notReady, ports: [...portSet] })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
