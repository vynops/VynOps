/**
 * GET /api/alerts
 *
 * Returns all firing Prometheus alerts with metadata.
 * Used by the /alerts frontend page (linked from Alertmanager Slack notifications).
 */
import { NextResponse } from 'next/server'
import { resolvePromUrl, K8S_TIMEOUT_MS } from '@/lib/cluster'

async function pGet(path: string): Promise<any> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}${path}`, {
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    return r.ok ? r.json() : null
  } catch {
    return null
  }
}

export type AlertEntry = {
  id: string
  name: string
  severity: string
  state: string
  namespace: string
  job: string
  summary: string
  description: string
  labels: Record<string, string>
  startsAt: string
  runbookUrl?: string
  generatorUrl?: string
}

export type AlertsApiResponse = {
  alerts: AlertEntry[]
  total: number
  firing: number
  resolved: number
  critical: number
  warning: number
  info: number
  hasPrometheus: boolean
}

const EMPTY: AlertsApiResponse = {
  alerts: [], total: 0, firing: 0, resolved: 0,
  critical: 0, warning: 0, info: 0, hasPrometheus: false,
}

export async function GET() {
  const [alertsJson, forStateJson, rulesJson] = await Promise.all([
    pGet('/api/v1/query?query=ALERTS'),
    pGet('/api/v1/query?query=ALERTS_FOR_STATE'),
    pGet('/api/v1/rules'),
  ])

  if (!alertsJson) {
    return NextResponse.json({ ...EMPTY })
  }

  const firingResults: any[] = alertsJson?.data?.result ?? []
  const forStateResults: any[] = forStateJson?.data?.result ?? []
  const ruleGroups: any[] = rulesJson?.data?.groups ?? []

  // Build map: alertname::job → startsAt timestamp (ms)
  const startMap: Record<string, number> = {}
  for (const r of forStateResults) {
    const name = r.metric?.alertname
    const job  = r.metric?.job ?? r.metric?.namespace ?? ''
    if (name) startMap[`${name}::${job}`] = parseFloat(r.value[1]) * 1000
  }

  // Build runbook map from rules
  const runbookMap: Record<string, string> = {}
  const descMap: Record<string, string> = {}
  const summaryMap: Record<string, string> = {}
  for (const grp of ruleGroups) {
    for (const rule of grp.rules ?? []) {
      if (rule.type !== 'alerting') continue
      if (rule.annotations?.runbook_url)  runbookMap[rule.name]  = rule.annotations.runbook_url
      if (rule.annotations?.description)  descMap[rule.name]     = rule.annotations.description
      if (rule.annotations?.summary)      summaryMap[rule.name]  = rule.annotations.summary
    }
  }

  const now = Date.now()
  const alerts: AlertEntry[] = []

  for (const r of firingResults) {
    const name: string  = r.metric?.alertname ?? ''
    const sev: string   = (r.metric?.severity ?? 'info').toLowerCase()
    const state: string = r.metric?.alertstate ?? 'firing'

    if (!name || name === 'Watchdog' || sev === 'none') continue

    const job   = r.metric?.job       ?? ''
    const ns    = r.metric?.namespace ?? r.metric?.job ?? ''
    const startMs = startMap[`${name}::${job}`] ?? now

    alerts.push({
      id:          `alert-${name}-${job || ns}-${startMs}`,
      name,
      severity:    sev,
      state,
      namespace:   ns,
      job,
      summary:     summaryMap[name]  ?? r.metric?.summary      ?? name,
      description: descMap[name]     ?? r.metric?.description  ?? '',
      labels:      r.metric ?? {},
      startsAt:    new Date(startMs).toISOString(),
      runbookUrl:  runbookMap[name],
      generatorUrl: r.metric?.generatorURL,
    })
  }

  // Sort: critical first, then by start time (oldest first)
  const SEV_ORDER: Record<string, number> = { critical: 4, high: 3, warning: 2, medium: 2, low: 1, info: 0 }
  alerts.sort((a, b) => {
    const ds = (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0)
    if (ds !== 0) return ds
    return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
  })

  const firing   = alerts.filter(a => a.state === 'firing').length
  const critical = alerts.filter(a => a.severity === 'critical').length
  const warning  = alerts.filter(a => a.severity === 'warning' || a.severity === 'medium').length
  const info     = alerts.filter(a => a.severity === 'info' || a.severity === 'low').length

  return NextResponse.json({
    alerts,
    total: alerts.length,
    firing,
    resolved: alerts.length - firing,
    critical,
    warning,
    info,
    hasPrometheus: true,
  } satisfies AlertsApiResponse)
}
