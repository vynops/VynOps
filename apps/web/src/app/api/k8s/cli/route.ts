import { NextResponse } from 'next/server'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { assertSession, getSessionUserId } from '@/lib/rbac'
import { appendAuditLog } from '@/app/api/settings/config/shared'
import { K8S_TIMEOUT_MS } from '@/lib/cluster'

const CLUSTERS_FILE = join(process.cwd(), 'data', 'clusters.json')
const MAX_ROWS = 100
const MAX_TEXT = 240
const COMMANDS = new Set(['cluster-info', 'nodes', 'namespaces', 'deployments', 'pods', 'services', 'events', 'top-nodes'])

function clean(value: unknown, max = MAX_TEXT): string {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function age(value?: string): string {
  if (!value) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

function renderTable(headers: string[], rows: unknown[][]): string {
  const values = rows.slice(0, MAX_ROWS).map(row => row.map(value => clean(value, 40)))
  const widths = headers.map((header, i) => Math.min(32, Math.max(header.length, ...values.map(row => (row[i] ?? '').length))))
  const line = (row: string[]) => row.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd()
  const output = [line(headers), line(widths.map(width => '-'.repeat(width))), ...values.map(line)]
  if (rows.length > MAX_ROWS) output.push(`… truncated to ${MAX_ROWS} of ${rows.length} rows`)
  return output.join('\n')
}

function selectClusterUrl(clusterId: string): { url: string; name: string } | null {
  try {
    if (existsSync(CLUSTERS_FILE)) {
      const clusters = JSON.parse(readFileSync(CLUSTERS_FILE, 'utf8')) as Array<{ id?: string; name?: string; k8sUrl?: string }>
      const cluster = clusters.find(item => item.id === clusterId || item.name === clusterId || item.k8sUrl === clusterId)
      if (cluster?.k8sUrl?.startsWith('http')) return { url: cluster.k8sUrl.replace(/\/$/, ''), name: cluster.name ?? cluster.id ?? clusterId }
    }
  } catch { return null }
  const fallback = (process.env.K8S_API_URL ?? '').replace(/\/$/, '')
  if (fallback && (clusterId === fallback || clusterId === 'default')) return { url: fallback, name: clusterId }
  return null
}

export async function POST(req: Request): Promise<NextResponse> {
  const deny = await assertSession()
  if (deny) return deny

  let body: { clusterId?: unknown; commandId?: unknown; namespace?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const clusterId = typeof body.clusterId === 'string' ? body.clusterId.trim() : ''
  const commandId = typeof body.commandId === 'string' ? body.commandId : ''
  const namespace = typeof body.namespace === 'string' ? body.namespace.trim() : ''
  if (!clusterId || clusterId.length > 200) return NextResponse.json({ error: 'A registered cluster is required' }, { status: 400 })
  if (!COMMANDS.has(commandId)) return NextResponse.json({ error: 'Command is not allowed' }, { status: 400 })
  if (namespace && (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) || namespace.length > 63)) {
    return NextResponse.json({ error: 'Invalid namespace name' }, { status: 400 })
  }

  const cluster = selectClusterUrl(clusterId)
  if (!cluster) return NextResponse.json({ error: 'Cluster is not registered on this server' }, { status: 404 })

  const namespacePath = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''
  const collection: Record<string, string> = {
    nodes: '/api/v1/nodes',
    namespaces: '/api/v1/namespaces',
    deployments: `/apis/apps/v1${namespacePath}/deployments`,
    pods: `/api/v1${namespacePath}/pods`,
    services: `/api/v1${namespacePath}/services`,
    events: `/api/v1${namespacePath}/events`,
    'top-nodes': '/apis/metrics.k8s.io/v1beta1/nodes',
  }
  const path = commandId === 'cluster-info'
    ? '/version'
    : `${collection[commandId]}?limit=${MAX_ROWS}`

  try {
    const response = await fetch(`${cluster.url}${path}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) return NextResponse.json({ error: `Kubernetes API returned ${response.status}: ${clean(text)}` }, { status: 502 })

    const data = text ? JSON.parse(text) : {}
    let output: string
    if (commandId === 'cluster-info') {
      output = `Cluster: ${cluster.name}\nKubernetes version: ${data.gitVersion ?? 'unknown'}\nAPI server: reachable`
    } else {
      const items: any[] = data.items ?? []
      if (commandId === 'nodes') {
        output = renderTable(['NAME', 'STATUS', 'ROLES', 'VERSION'], items.map(item => [
          item.metadata?.name,
          item.status?.conditions?.find((condition: any) => condition.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
          Object.keys(item.metadata?.labels ?? {}).filter((key: string) => key.startsWith('node-role.kubernetes.io/')).map((key: string) => key.split('/').pop()).join(',') || '<none>',
          item.status?.nodeInfo?.kubeletVersion,
        ]))
      } else if (commandId === 'namespaces') {
        output = renderTable(['NAME', 'STATUS', 'AGE'], items.map(item => [item.metadata?.name, item.status?.phase, age(item.metadata?.creationTimestamp)]))
      } else if (commandId === 'deployments') {
        output = renderTable(['NAMESPACE', 'NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE'], items.map(item => [item.metadata?.namespace, item.metadata?.name, `${item.status?.readyReplicas ?? 0}/${item.spec?.replicas ?? 0}`, item.status?.updatedReplicas ?? 0, item.status?.availableReplicas ?? 0]))
      } else if (commandId === 'pods') {
        output = renderTable(['NAMESPACE', 'NAME', 'READY', 'STATUS', 'RESTARTS', 'NODE'], items.map(item => [item.metadata?.namespace, item.metadata?.name, `${(item.status?.containerStatuses ?? []).filter((container: any) => container.ready).length}/${(item.spec?.containers ?? []).length}`, item.status?.phase, (item.status?.containerStatuses ?? []).reduce((total: number, container: any) => total + (container.restartCount ?? 0), 0), item.spec?.nodeName]))
      } else if (commandId === 'services') {
        output = renderTable(['NAMESPACE', 'NAME', 'TYPE', 'CLUSTER-IP', 'PORTS'], items.map(item => [item.metadata?.namespace, item.metadata?.name, item.spec?.type, item.spec?.clusterIP, (item.spec?.ports ?? []).map((port: any) => `${port.port}/${port.protocol ?? 'TCP'}`).join(',')]))
      } else if (commandId === 'events') {
        const sorted = items.sort((a, b) => new Date(b.eventTime ?? b.lastTimestamp ?? b.metadata?.creationTimestamp ?? 0).getTime() - new Date(a.eventTime ?? a.lastTimestamp ?? a.metadata?.creationTimestamp ?? 0).getTime())
        output = renderTable(['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], sorted.map(item => [age(item.eventTime ?? item.lastTimestamp ?? item.metadata?.creationTimestamp), item.type, item.reason, `${item.involvedObject?.kind ?? ''}/${item.involvedObject?.name ?? ''}`, item.message]))
      } else {
        output = renderTable(['NAME', 'CPU', 'MEMORY'], items.map(item => [item.metadata?.name, item.usage?.cpu, item.usage?.memory]))
      }
      if (!items.length) output = 'No resources found.'
    }

    appendAuditLog({ ts: new Date().toISOString(), user: (await getSessionUserId()) ?? 'authenticated-user', action: 'kubernetes.cli.read', detail: `${cluster.name}: ${commandId}${namespace ? ` -n ${namespace}` : ''}` })
    return NextResponse.json({ output, cluster: cluster.name, commandId, namespace: namespace || null })
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError' ? 'Kubernetes API request timed out' : 'Could not reach the Kubernetes API'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
