import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'


export async function GET(req: Request) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const namespace = searchParams.get('namespace') ?? 'default'
  const pod = searchParams.get('pod') ?? ''
  const container = searchParams.get('container') ?? ''
  const tailLines = Math.min(Math.max(1, parseInt(searchParams.get('tailLines') ?? '200', 10)), 2000)
  const timestamps = searchParams.get('timestamps') !== 'false'
  const previous = searchParams.get('previous') === 'true'

  if (!pod) return NextResponse.json({ error: 'pod param required' }, { status: 400 })

  const params = new URLSearchParams({ tailLines: String(tailLines) })
  if (timestamps) params.set('timestamps', 'true')
  if (previous) params.set('previous', 'true')
  if (container) params.set('container', container)

  const url = `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${params}`

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const text = await res.text()
      // K8s returns a JSON Status object on error — extract the message if possible
      let msg = text
      try {
        const status = JSON.parse(text)
        if (status?.message) msg = status.message
      } catch { /* not JSON, use raw text */ }

      // Pod-not-found (404) or gone (410): treat as "unavailable" rather than an error
      // so the client can show a soft info message instead of a hard error state
      if (res.status === 404 || res.status === 410) {
        return NextResponse.json({
          logs: '',
          pod,
          container: container || null,
          namespace,
          unavailable: true,
          reason: msg || 'Pod not found — it may have completed and been cleaned up',
        })
      }

      return NextResponse.json({ error: msg || `K8s returned ${res.status}` }, { status: res.status })
    }

    const text = await res.text()
    return NextResponse.json({ logs: text, pod, container: container || null, namespace })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
