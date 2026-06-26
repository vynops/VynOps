import { resolvePromUrl, K8S_TIMEOUT_MS } from '@/lib/cluster'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { readConfig } from '@/app/api/settings/config/shared'

// SLA window (minutes) per severity ? reads runtime config, falls back to defaults
function getSlaMinutes(): Record<string, number> {
  const cfg = readConfig()
  return {
    critical: cfg.sla_minutes_critical ?? 30,
    high: cfg.sla_minutes_high ?? 120,
    medium: cfg.sla_minutes_medium ?? 480,
    low: cfg.sla_minutes_low ?? 2880,
  }
}

// Alert grouping: patterns that map to a single incident
const COMPONENT_GROUPS: { key: string; title: string; service: string; match: RegExp }[] = [
  {
    key: 'k8s-control-plane',
    title: 'Kubernetes Control Plane Components Unmonitored',
    service: 'kube-system',
    match: /KubeControllerManager|KubeScheduler|KubeAPIServer/,
  },
  {
    key: 'k8s-network',
    title: 'Kubernetes Network Components Degraded',
    service: 'kube-system',
    match: /KubeProxy|CoreDNS|KubeDNS|NetworkPlugin/,
  },
  {
    key: 'k8s-nodes',
    title: 'Kubernetes Node Conditions Detected',
    service: 'kube-system',
    match: /KubeNode|NodeNotReady|NodePressure/,
  },
  {
    key: 'k8s-pods',
    title: 'Kubernetes Workload Issues',
    service: 'cluster-wide',
    match: /KubePod|CrashLoop|OOMKill|KubeContainer|KubeDeployment/,
  },
  {
    key: 'k8s-storage',
    title: 'Persistent Storage Issues',
    service: 'storage',
    match: /KubePersistentVolume|PVC|VolumeMount|Disk/,
  },
  {
    key: 'k8s-monitoring',
    title: 'Monitoring Stack Issues',
    service: 'monitoring',
    match: /Prometheus|Alertmanager|Grafana|Loki|Tempo/,
  },
]

function classifyAlert(alertname: string, labels: Record<string, string>): string {
  for (const g of COMPONENT_GROUPS) {
    if (g.match.test(alertname)) return g.key
  }
  const ns = labels.namespace ?? labels.job ?? ''
  return ns ? `app-${ns}` : 'app-misc'
}

function fmtMins(m: number): string {
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}

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

export type AlertDoc = {
  id: string
  name: string
  severity: string
  state: string
  summary: string
  labels: Record<string, string>
  startsAt: string
  source: string
  affectedServices: string[]
}

export type TimelineEvent = {
  id: string
  ts: string
  type: string
  title: string
  description: string
  severity?: string
  actor?: string
  metadata?: Record<string, unknown>
}

export type IncidentDoc = {
  id: string
  title: string
  description: string
  severity: string
  state: string
  owner: string
  team: string
  service: string
  environment: string
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  slaDeadline: string
  slaBreached: boolean
  alertCount: number
  alerts: AlertDoc[]
  timeline: TimelineEvent[]
  blastRadius: {
    affectedServices: string[]
    affectedUsers: number
    affectedRegions: string[]
    slaBreached: boolean
    dependentServices: string[]
    revenueImpact?: number
  }
  runbookUrls: string[]
  linkedDeployments: string[]
  source: 'auto' | 'manual'
  durationMinutes: number
  escalationLevel: number
}

const STORE_FILE = join(process.cwd(), 'data', 'incidents-manual.json')

function loadStore(): Map<string, IncidentDoc> {
  try {
    if (!existsSync(STORE_FILE)) return new Map()
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Record<string, IncidentDoc>
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

function saveStore(store: Map<string, IncidentDoc>): void {
  try {
    const dir = join(process.cwd(), 'data')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const obj: Record<string, IncidentDoc> = {}
    for (const [k, v] of store) obj[k] = v
    writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2), 'utf8')
  } catch {
    // non-fatal
  }
}

export const manualStore: Map<string, IncidentDoc> = loadStore()

export function persistStore(): void {
  saveStore(manualStore)
}

const SEV_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0, none: 0 }

function buildIncident(
  groupKey: string,
  groupTitle: string,
  service: string,
  alerts: AlertDoc[],
  minStartMs: number,
  now: number,
  runbookUrls: string[],
): IncidentDoc {
  const severity = alerts.reduce<string>((max, a) =>
    (SEV_ORDER[a.severity] ?? 0) > (SEV_ORDER[max] ?? 0) ? a.severity : max, 'low')

  const slaMins = getSlaMinutes()[severity] ?? 480
  const slaDeadlineMs = minStartMs + slaMins * 60 * 1000
  const slaBreached = now > slaDeadlineMs
  const durationMins = Math.round((now - minStartMs) / 60000)
  const createdAt = new Date(minStartMs).toISOString()
  const slaDeadline = new Date(slaDeadlineMs).toISOString()

  const timeline: TimelineEvent[] = [
    {
      id: `tl-${groupKey}-fired`,
      ts: createdAt,
      type: 'alert',
      title: `${alerts.length} alert${alerts.length > 1 ? 's' : ''} detected`,
      description: `Prometheus detected: ${alerts.map(a => a.name).join(', ')}`,
      severity,
    },
  ]

  if (slaBreached) {
    timeline.push({
      id: `tl-${groupKey}-sla`,
      ts: new Date(slaDeadlineMs).toISOString(),
      type: 'escalation',
      title: 'SLA deadline exceeded',
      description: `${severity.toUpperCase()} incidents have a ${slaMins < 60 ? slaMins + '-min' : Math.round(slaMins / 60) + '-hour'} SLA ? now ${fmtMins(durationMins - slaMins)} overdue`,
      severity: 'critical',
    })
  }

  const affectedServices = [...new Set(alerts.flatMap(a => a.affectedServices ?? []))]

  return {
    id: `INC-${groupKey.toUpperCase().replace(/-/g, '-')}`,
    title: groupTitle,
    description: `${alerts.length} related ${severity}-severity alert${alerts.length > 1 ? 's' : ''} detected by Prometheus have been firing since ${new Date(minStartMs).toUTCString()}. Affected component: ${service}.`,
    severity,
    state: 'open',
    owner: 'Unassigned',
    team: 'Platform Engineering',
    service,
    environment: 'production',
    labels: { source: 'prometheus', component: service },
    createdAt,
    updatedAt: createdAt,
    slaDeadline,
    slaBreached,
    alertCount: alerts.length,
    alerts,
    timeline,
    blastRadius: {
      affectedServices,
      affectedUsers: 0,
      affectedRegions: [],
      slaBreached,
      dependentServices: [],
    },
    runbookUrls,
    linkedDeployments: [],
    source: 'auto',
    durationMinutes: durationMins,
    escalationLevel: 0,
  }
}

export async function buildAutoIncidents(): Promise<{ incidents: IncidentDoc[]; totalAlerts: number; hasPrometheus: boolean }> {
  const now = Date.now()

  const [alertsJson, forStateJson, rulesJson] = await Promise.all([
    pGet('/api/v1/query?query=ALERTS'),
    pGet('/api/v1/query?query=ALERTS_FOR_STATE'),
    pGet('/api/v1/rules'),
  ])

  const firingResults: any[] = alertsJson?.data?.result ?? []
  const forStateResults: any[] = forStateJson?.data?.result ?? []
  const ruleGroups: any[] = rulesJson?.data?.groups ?? []

  const startMap: Record<string, number> = {}
  for (const r of forStateResults) {
    const name = r.metric?.alertname
    const job = r.metric?.job ?? r.metric?.namespace ?? ''
    if (name) startMap[`${name}::${job}`] = parseFloat(r.value[1]) * 1000
  }

  const runbookMap: Record<string, string> = {}
  for (const grp of ruleGroups) {
    for (const rule of grp.rules ?? []) {
      if (rule.type === 'alerting' && rule.annotations?.runbook_url) {
        runbookMap[rule.name] = rule.annotations.runbook_url
      }
    }
  }

  type Group = {
    key: string
    title: string
    service: string
    alerts: AlertDoc[]
    minStart: number
    runbookUrls: string[]
  }
  const groupMap: Record<string, Group> = {}

  for (const r of firingResults) {
    const alertname: string = r.metric?.alertname ?? ''
    const severity: string = r.metric?.severity ?? 'medium'
    const alertstate: string = r.metric?.alertstate ?? 'firing'

    if (!alertname || alertname === 'Watchdog' || severity === 'none') continue
    if (alertstate !== 'firing') continue

    const job = r.metric?.job ?? r.metric?.namespace ?? ''
    const startMs = startMap[`${alertname}::${job}`] ?? now

    const gKey = classifyAlert(alertname, r.metric ?? {})
    if (!groupMap[gKey]) {
      const cfg = COMPONENT_GROUPS.find(g => g.key === gKey)
      groupMap[gKey] = {
        key: gKey,
        title: cfg?.title ?? `${r.metric?.namespace ?? job} Issues`,
        service: cfg?.service ?? r.metric?.namespace ?? job ?? 'unknown',
        alerts: [],
        minStart: startMs,
        runbookUrls: [],
      }
    }

    const g = groupMap[gKey]
    if (startMs < g.minStart) g.minStart = startMs

    const rb = runbookMap[alertname]
    if (rb && !g.runbookUrls.includes(rb)) g.runbookUrls.push(rb)

    g.alerts.push({
      id: `prom-${alertname}-${job || Date.now()}`,
      name: alertname,
      severity,
      state: 'firing',
      summary: alertname,
      labels: r.metric ?? {},
      startsAt: new Date(startMs).toISOString(),
      source: 'prometheus',
      affectedServices: [groupMap[gKey].service],
    })
  }

  const incidents: IncidentDoc[] = Object.values(groupMap).map(g =>
    buildIncident(g.key, g.title, g.service, g.alerts, g.minStart, now, g.runbookUrls)
  )

  const totalAlerts = firingResults.filter(
    r => r.metric?.alertname !== 'Watchdog' && r.metric?.severity !== 'none'
  ).length

  return { incidents, totalAlerts, hasPrometheus: !!alertsJson }
}
