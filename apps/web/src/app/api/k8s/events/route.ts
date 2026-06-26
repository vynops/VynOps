import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'

export const dynamic = 'force-dynamic'


async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) throw new Error('K8S_API_URL not configured')
  const res = await fetch(`${K8S}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`K8s API returned ${res.status} for ${path}`)
  return res.json()
}

async function k8sGetSafe(path: string): Promise<any> {
  const K8S  = await resolveK8sUrl()
  try { return await k8sGet(path) } catch { return { items: [] } }
}

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
// Fetch events (required — throws on failure) and pods (optional — used only for correlation)
  const evtData = await k8sGet('/api/v1/events?limit=500')
  const podData = await k8sGetSafe('/api/v1/pods')

    const events = (evtData.items ?? [])
      .sort((a: any, b: any) =>
        new Date(b.lastTimestamp ?? b.eventTime ?? 0).getTime() -
        new Date(a.lastTimestamp ?? a.eventTime ?? 0).getTime()
      )
      .slice(0, 300)
      .map((e: any) => ({
        id: e.metadata.uid,
        type: (e.type ?? 'Normal') as 'Normal' | 'Warning',
        reason: e.reason ?? '',
        message: e.message ?? '',
        involvedObject: {
          kind: e.involvedObject?.kind ?? '',
          name: e.involvedObject?.name ?? '',
          namespace: e.involvedObject?.namespace ?? '',
        },
        count: e.count ?? 1,
        firstTime: e.firstTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp,
        lastTime: e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp,
        namespace: e.involvedObject?.namespace ?? e.metadata.namespace ?? '',
        sourceComponent: e.source?.component ?? e.reportingComponent ?? '',
        sourceHost: e.source?.host ?? '',
      }))

    // Build pod → owner map for correlation
    const podOwnerMap: Record<string, string> = {}
    for (const pod of (podData.items ?? [])) {
      const ns = pod.metadata.namespace
      const podName = pod.metadata.name
      const owner = pod.metadata.ownerReferences?.[0]
      if (owner) {
        const ownerName = owner.kind === 'ReplicaSet'
          ? podName.replace(/-[a-z0-9]{5,10}$/, '').replace(/-[a-z0-9]{5,10}$/, '')
          : owner.name
        podOwnerMap[`${ns}/${podName}`] = `${owner.kind}/${ownerName}`
      }
    }

    // Anomaly burst detection: reason combos with count > 3× average
    const reasonCounts: Record<string, number> = {}
    for (const e of events) {
      const key = `${e.type}:${e.reason}`
      reasonCounts[key] = (reasonCounts[key] ?? 0) + e.count
    }
    const avgCount = Object.values(reasonCounts).reduce((a, b) => a + b, 0) / Math.max(Object.keys(reasonCounts).length, 1)
    const anomalies = Object.entries(reasonCounts)
      .filter(([, count]) => count > Math.max(avgCount * 3, 10))
      .map(([key, count]) => {
        const [type, reason] = key.split(':')
        return { type, reason, count, severity: count > avgCount * 6 ? 'critical' : 'warning' as const }
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    // Correlate events into groups by owning workload
    const groups: Record<string, typeof events> = {}
    for (const e of events) {
      const ns = e.involvedObject.namespace || '_cluster'
      const obj = e.involvedObject.name
      const ownerKey = podOwnerMap[`${ns}/${obj}`] ?? `${e.involvedObject.kind}/${obj}`
      const groupKey = `${ns}/${ownerKey}`
      if (!groups[groupKey]) groups[groupKey] = []
      groups[groupKey].push(e)
    }

    const correlatedGroups = Object.entries(groups)
      .map(([key, evts]) => {
        const warnings = evts.filter(e => e.type === 'Warning')
        const totalCount = evts.reduce((a, e) => a + e.count, 0)
        const parts = key.split('/')
        return {
          key,
          namespace: parts[0] === '_cluster' ? null : parts[0],
          owner: parts.slice(1).join('/'),
          eventCount: evts.length,
          warningCount: warnings.length,
          totalOccurrences: totalCount,
          events: evts
            .sort((a, b) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime())
            .slice(0, 8),
        }
      })
      .filter(g => g.warningCount > 0)
      .sort((a, b) => b.warningCount - a.warningCount)
      .slice(0, 20)

    const warningEvents = events.filter(e => e.type === 'Warning')
    const recentWarnings = warningEvents.filter(e => {
      return Date.now() - new Date(e.lastTime).getTime() < 15 * 60 * 1000
    })

    return NextResponse.json({
      events,
      anomalies,
      correlatedGroups,
      summary: {
        total: events.length,
        warnings: warningEvents.length,
        highRepeat: events.filter(e => e.count > 10).length,
        recentWarnings15m: recentWarnings.length,
        anomalyBursts: anomalies.length,
      },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const isConnErr = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('abort')
    return NextResponse.json(
      { error: isConnErr ? `Cannot reach kubectl proxy at ${K8S}: ${msg}` : msg, events: [], anomalies: [], correlatedGroups: [], summary: { total: 0, warnings: 0, highRepeat: 0, recentWarnings15m: 0, anomalyBursts: 0 } },
      { status: isConnErr ? 503 : 502 }
    )
  }
}

