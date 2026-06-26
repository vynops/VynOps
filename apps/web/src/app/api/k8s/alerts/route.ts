import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl, resolveAlertmanagerUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function promGet(query: string): Promise<any[]> {
  const PROM = await resolvePromUrl()
  try {
    const url = `${PROM}/api/v1/query?query=${encodeURIComponent(query)}`
    const r = await fetch(url, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } })
    const json = await r.json()
    return json.data?.result ?? []
  } catch { return [] }
}

const SEVERITY_MAP: Record<string, string> = {
  critical: 'critical', high: 'high', warning: 'high',
  medium: 'medium', low: 'low', info: 'info',
}
function normSev(s?: string): string {
  return SEVERITY_MAP[s?.toLowerCase() ?? ''] ?? 'medium'
}

function k8sEventToAlert(e: any, idx: number) {
  const reason: string = e.reason ?? ''
  const sev =
    ['OOMKilling', 'Evicted', 'Failed', 'BackOff', 'Error', 'Kill'].some(r => reason.includes(r))
      ? 'critical'
      : ['FailedMount', 'Unhealthy', 'NetworkNotReady', 'FailedScheduling'].some(r => reason.includes(r))
      ? 'high'
      : 'medium'

  return {
    id: e.metadata?.uid ?? `k8s-evt-${idx}`,
    name: `K8s/${reason}`,
    severity: sev,
    state: 'firing',
    summary: (e.message ?? reason).slice(0, 150),
    description: e.message ?? '',
    labels: {
      namespace: e.involvedObject?.namespace ?? '',
      object: e.involvedObject?.name ?? '',
      reason,
    },
    annotations: {},
    startsAt: e.firstTimestamp ?? e.metadata?.creationTimestamp ?? new Date().toISOString(),
    source: 'kubernetes',
    affectedServices: [e.involvedObject?.name ?? ''].filter(Boolean),
    aiCorrelated: false,
  }
}

export async function GET() {
  const K8S = await resolveK8sUrl()
  const ALERTMANAGER = await resolveAlertmanagerUrl()
  // ── 1. Alertmanager ──────────────────────────────────────────
  if (ALERTMANAGER) {
    try {
      const r = await fetch(`${ALERTMANAGER}/api/v2/alerts?active=true&silenced=false`, {
        signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
        next: { revalidate: 0 },
      })
      if (r.ok) {
        const amAlerts: any[] = await r.json()
        const alerts = amAlerts.map((a, i) => ({
          id: a.fingerprint ?? `am-${i}`,
          name: a.labels?.alertname ?? 'Unknown Alert',
          severity: normSev(a.labels?.severity),
          state: a.status?.state === 'suppressed' ? 'suppressed' : 'firing',
          summary: a.annotations?.summary ?? a.labels?.alertname ?? '',
          description: a.annotations?.description ?? '',
          labels: a.labels ?? {},
          annotations: a.annotations ?? {},
          startsAt: a.startsAt ?? new Date().toISOString(),
          endsAt: a.endsAt,
          source: 'prometheus',
          affectedServices: [a.labels?.service ?? a.labels?.job ?? ''].filter(Boolean),
          aiCorrelated: false,
        }))
        return NextResponse.json({ alerts, source: 'alertmanager' })
      }
    } catch { /* fall through */ }
  }

  // ── 2. Prometheus ALERTS metric ──────────────────────────────
  const promResults = await promGet('ALERTS{alertstate="firing"}')
  if (promResults.length > 0) {
    const alerts = promResults.map((a, i) => {
      const labels = a.metric ?? {}
      return {
        id: `prom-${labels.alertname ?? i}-${labels.instance ?? labels.pod ?? ''}`,
        name: labels.alertname ?? 'Prometheus Alert',
        severity: normSev(labels.severity),
        state: 'firing',
        summary: labels.alertname ?? '',
        description: `${labels.job ?? ''} · ${labels.instance ?? labels.namespace ?? ''}`.replace(/^·\s*/, ''),
        labels,
        annotations: {},
        startsAt: new Date(Number(a.value?.[0] ?? Date.now() / 1000) * 1000).toISOString(),
        source: 'prometheus',
        affectedServices: [labels.service ?? labels.job ?? labels.namespace ?? ''].filter(Boolean),
        aiCorrelated: false,
      }
    })
    return NextResponse.json({ alerts, source: 'prometheus' })
  }

  // ── 3. K8s Warning events as alerts ─────────────────────────
  if (K8S) {
    try {
      const r = await fetch(
        `${K8S}/api/v1/events?fieldSelector=type%3DWarning&limit=50`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } },
      )
      if (r.ok) {
        const data = await r.json()
        const items: any[] = data.items ?? []
        const alerts = items
          .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
          .slice(0, 25)
          .map((e, i) => k8sEventToAlert(e, i))
        return NextResponse.json({ alerts, source: 'k8s-events' })
      }
    } catch { /* fall through */ }
  }

  return NextResponse.json({ error: 'No alert source configured' }, { status: 503 })
}