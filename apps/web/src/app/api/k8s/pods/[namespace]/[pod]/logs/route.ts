import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'


export async function GET(
  req: Request,
  { params }: { params: Promise<{ namespace: string; pod: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const { namespace, pod } = await params
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const container = searchParams.get('container') ?? ''
  const tailLines = searchParams.get('tailLines') ?? '300'

  try {
    let url = `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?tailLines=${encodeURIComponent(tailLines)}&timestamps=true`
    if (container) url += `&container=${encodeURIComponent(container)}`

    const res = await fetch(url, {
      headers: { Accept: 'text/plain, */*' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      const errText = await res.text()
      // K8s returns JSON Status object even for log errors — parse it
      let errMsg: string
      try { errMsg = JSON.parse(errText)?.message ?? errText } catch { errMsg = errText }
      return NextResponse.json({ error: errMsg || `K8s returned ${res.status}` }, { status: res.status })
    }
    const raw = await res.text()
    const lines = raw.split('\n').filter(Boolean).map((line, i) => {
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/)
      if (tsMatch) {
        const [, ts, msg] = tsMatch
        const level = /error|err |fatal|exception/i.test(msg) ? 'ERROR'
          : /warn/i.test(msg) ? 'WARN'
          : /debug/i.test(msg) ? 'DEBUG'
          : 'INFO'
        return { id: i, ts, level, msg }
      }
      return { id: i, ts: new Date().toISOString(), level: 'INFO', msg: line }
    })
    return NextResponse.json({ pod, namespace, container: container || null, lines })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
