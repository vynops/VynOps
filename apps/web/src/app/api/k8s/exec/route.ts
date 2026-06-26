// WebSocket proxy for kubectl exec
// Bridges browser WebSocket ↔ K8s exec WebSocket API
// Protocol: subprotocol "channel.k8s.io" with 5 channels (stdin=0, stdout=1, stderr=2, error=3, resize=4)
import { resolveK8sUrl } from '@/lib/cluster'

export const dynamic = 'force-dynamic'


export async function GET(req: Request) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return new Response('K8S_API_URL not configured', { status: 503 })

  const { searchParams } = new URL(req.url)
  const namespace = searchParams.get('namespace') ?? 'default'
  const pod = searchParams.get('pod') ?? ''
  const container = searchParams.get('container') ?? ''
  const command = searchParams.get('command') ?? '/bin/sh'

  if (!pod) return new Response('pod param required', { status: 400 })

  // Check WebSocket upgrade
  const upgradeHeader = req.headers.get('upgrade')
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 })
  }

  // Build K8s exec URL
  const k8sBase = K8S.replace(/^http/, 'ws')
  const cmd = command.split(' ').map(c => `command=${encodeURIComponent(c)}`).join('&')
  const containerParam = container ? `&container=${encodeURIComponent(container)}` : ''
  const k8sExecUrl = `${k8sBase}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/exec?stdin=true&stdout=true&stderr=true&tty=true&${cmd}${containerParam}`

  // WebSocket proxy requires edge/Deno runtime — return connection info for client-side use
  return new Response(
    JSON.stringify({
      wsUrl: k8sExecUrl.replace(/^ws/, 'http'),
      note: 'Connect via WebSocket with subprotocol channel.k8s.io',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}
