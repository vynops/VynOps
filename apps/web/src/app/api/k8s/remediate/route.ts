import { NextResponse } from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { resolveK8sUrl } from '@/lib/cluster'

type Action = 'restart_deployment' | 'scale_deployment' | 'delete_pod' | 'cordon_node' | 'uncordon_node'

interface RemediateBody {
  action: Action
  name: string
  namespace?: string
  replicas?: number
}

export async function POST(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny
  const K8S = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  let body: RemediateBody
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const { action, name, namespace = 'default', replicas } = body
  if (!action || !name) return NextResponse.json({ error: 'action and name are required' }, { status: 400 })

  let endpoint = ''
  let method: 'PATCH' | 'DELETE' = 'PATCH'
  let patchBody: object | null = null

  switch (action) {
    case 'restart_deployment':
      endpoint  = `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`
      patchBody = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } }
      break
    case 'scale_deployment':
      if (typeof replicas !== 'number') return NextResponse.json({ error: 'replicas required for scale_deployment' }, { status: 400 })
      endpoint  = `/apis/apps/v1/namespaces/${namespace}/deployments/${name}/scale`
      patchBody = { spec: { replicas } }
      break
    case 'delete_pod':
      endpoint = `/api/v1/namespaces/${namespace}/pods/${name}`
      method   = 'DELETE'
      break
    case 'cordon_node':
      endpoint  = `/api/v1/nodes/${name}`
      patchBody = { spec: { unschedulable: true } }
      break
    case 'uncordon_node':
      endpoint  = `/api/v1/nodes/${name}`
      patchBody = { spec: { unschedulable: false } }
      break
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }

  try {
    const t0 = Date.now()
    const r = await fetch(`${K8S}${endpoint}`, {
      method,
      headers: patchBody ? { 'Content-Type': 'application/strategic-merge-patch+json' } : {},
      body:    patchBody ? JSON.stringify(patchBody) : undefined,
      signal:  AbortSignal.timeout(10000),
    })
    const latencyMs = Date.now() - t0
    if (r.ok) {
      return NextResponse.json({
        status: 'executed', action, name, namespace, latencyMs,
        message: `✅ ${action} executed on ${name} in ${namespace} (${latencyMs}ms)`,
      })
    }
    const errText = await r.text().catch(() => '')
    return NextResponse.json({ status: 'failed', action, name, namespace, httpStatus: r.status, error: errText.slice(0, 300) }, { status: 502 })
  } catch (e: any) {
    return NextResponse.json({ status: 'error', action, name, namespace, error: e.message }, { status: 500 })
  }
}
