import { NextRequest, NextResponse } from 'next/server'
import { notifyIncident } from '@/lib/notify'
import { resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { readConfig } from '@/app/api/settings/config/shared'
import { assertOperator, assertSession } from '@/lib/rbac'

// SLA window (minutes) per severity ? reads runtime config, falls back to defaults
function getSlaMinutes(): Record<string, number> {
  const cfg = readConfig()
  return {
    critical: cfg.sla_minutes_critical ?? 30,
    high:     cfg.sla_minutes_high     ?? 120,
    medium:   cfg.sla_minutes_medium   ?? 480,
    low:      cfg.sla_minutes_low      ?? 2880,
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

// ?? Helpers ???????????????????????????????????????????????????

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
  } catch { return null }
}

// ?? Types ?????????????????????????????????????????????????????

type AlertDoc = {
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

type TimelineEvent = {
  id: string
  ts: string
  type: string
  title: string
  description: string
  severity?: string
  actor?: string
  metadata?: Record<string, unknown>
}

type IncidentDoc = {
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
  escalationLevel: number   // 0 = not escalated, 1 = L1 paged, 2 = L2, ?
}

// ?? Server-side manual incident store ? disk-backed ?????????
// Survives Next.js HMR reloads and server restarts
const STORE_FILE = join(process.cwd(), 'data', 'incidents-manual.json')

function loadStore(): Map<string, IncidentDoc> {
  try {
    if (!existsSync(STORE_FILE)) return new Map()
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Record<string, IncidentDoc>
    return new Map(Object.entries(raw))
  } catch { return new Map() }
}

function saveStore(store: Map<string, IncidentDoc>): void {
  try {
    const dir = join(process.cwd(), 'data')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const obj: Record<string, IncidentDoc> = {}
    for (const [k, v] of store) obj[k] = v
    writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2), 'utf8')
  } catch { /* non-fatal */ }
}

const manualStore: Map<string, IncidentDoc> = loadStore()

/** Call after every mutation to persist changes to disk. */
function persistStore(): void { saveStore(manualStore) }

// ?? Build one incident from a grouped alert set ???????????????

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

  const slaMins       = getSlaMinutes()[severity] ?? 480
  const slaDeadlineMs = minStartMs + slaMins * 60 * 1000
  const slaBreached   = now > slaDeadlineMs
  const durationMins  = Math.round((now - minStartMs) / 60000)
  const createdAt     = new Date(minStartMs).toISOString()
  const slaDeadline   = new Date(slaDeadlineMs).toISOString()

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

// ?? GET: list all incidents ???????????????????????????????????

/** Shared logic: fetch Prometheus alerts and build IncidentDoc list.
 *  Called by GET handler and by the [id] route directly (no internal HTTP). */
async function buildAutoIncidents(): Promise<{ incidents: IncidentDoc[]; totalAlerts: number; hasPrometheus: boolean }> {
  const now = Date.now()

  const [alertsJson, forStateJson, rulesJson] = await Promise.all([
    pGet('/api/v1/query?query=ALERTS'),
    pGet('/api/v1/query?query=ALERTS_FOR_STATE'),
    pGet('/api/v1/rules'),
  ])

  const firingResults: any[]   = alertsJson?.data?.result   ?? []
  const forStateResults: any[] = forStateJson?.data?.result ?? []
  const ruleGroups: any[]      = rulesJson?.data?.groups    ?? []

  // Start-time map: "alertname::job" ? unix ms
  const startMap: Record<string, number> = {}
  for (const r of forStateResults) {
    const name = r.metric?.alertname
    const job  = r.metric?.job ?? r.metric?.namespace ?? ''
    if (name) startMap[`${name}::${job}`] = parseFloat(r.value[1]) * 1000
  }

  // Runbook URL map: alertname ? url
  const runbookMap: Record<string, string> = {}
  for (const grp of ruleGroups) {
    for (const rule of grp.rules ?? []) {
      if (rule.type === 'alerting' && rule.annotations?.runbook_url) {
        runbookMap[rule.name] = rule.annotations.runbook_url
      }
    }
  }

  // Group firing alerts (skip Watchdog / severity:none)
  type Group = {
    key: string; title: string; service: string
    alerts: AlertDoc[]; minStart: number; runbookUrls: string[]
  }
  const groupMap: Record<string, Group> = {}

  for (const r of firingResults) {
    const alertname:  string = r.metric?.alertname  ?? ''
    const severity:   string = r.metric?.severity   ?? 'medium'
    const alertstate: string = r.metric?.alertstate ?? 'firing'

    if (!alertname || alertname === 'Watchdog' || severity === 'none') continue
    if (alertstate !== 'firing') continue

    const job     = r.metric?.job ?? r.metric?.namespace ?? ''
    const startMs = startMap[`${alertname}::${job}`] ?? now

    const gKey = classifyAlert(alertname, r.metric ?? {})
    if (!groupMap[gKey]) {
      const cfg = COMPONENT_GROUPS.find(g => g.key === gKey)
      groupMap[gKey] = {
        key:     gKey,
        title:   cfg?.title ?? `${r.metric?.namespace ?? job} Issues`,
        service: cfg?.service ?? r.metric?.namespace ?? job ?? 'unknown',
        alerts:  [],
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

export async function GET() {
  const deny = await assertSession()
  if (deny) return deny

  const now = Date.now()
  const { incidents: autoIncidents, totalAlerts, hasPrometheus } = await buildAutoIncidents()

  // Merge: manualStore entries override auto-incidents with the same ID (don't duplicate)
  const manualEntries = Array.from(manualStore.values()).map(i => ({
    ...i,
    slaBreached:     now > new Date(i.slaDeadline).getTime(),
    durationMinutes: Math.round((now - new Date(i.createdAt).getTime()) / 60000),
  }))
  const manualIds = new Set(manualEntries.map(i => i.id))

  const all: IncidentDoc[] = [
    ...autoIncidents.filter(i => !manualIds.has(i.id)),  // skip auto if manual copy exists
    ...manualEntries,
  ].sort((a, b) => {
    if (a.state === 'resolved' && b.state !== 'resolved') return  1
    if (b.state === 'resolved' && a.state !== 'resolved') return -1
    const sb = (b.slaBreached ? 1 : 0) - (a.slaBreached ? 1 : 0)
    if (sb !== 0) return sb
    const sv = (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0)
    if (sv !== 0) return sv
    return b.durationMinutes - a.durationMinutes
  })

  // Metrics
  const nonResolved     = all.filter(i => i.state !== 'resolved')
  const open            = nonResolved.length
  const critical        = nonResolved.filter(i => i.severity === 'critical').length
  const slaBreachedCnt  = nonResolved.filter(i => i.slaBreached).length
  const slaBreachingCnt = nonResolved.filter(i => {
    if (i.slaBreached) return false
    return (new Date(i.slaDeadline).getTime() - now) < 30 * 60 * 1000
  }).length

  const resolved = all.filter(i => i.state === 'resolved' && i.resolvedAt)
  const avgMttrMinutes = resolved.length > 0
    ? Math.round(resolved.reduce((s, i) =>
        s + (new Date(i.resolvedAt!).getTime() - new Date(i.createdAt).getTime()) / 60000, 0
      ) / resolved.length)
    : null

  const slaCompliancePct = nonResolved.length > 0
    ? Math.round((nonResolved.length - slaBreachedCnt) / nonResolved.length * 100)
    : 100

  return NextResponse.json({
    incidents: all,
    metrics: {
      open,
      critical,
      slaBreached: slaBreachedCnt,
      slaBreaching: slaBreachingCnt,
      avgMttrMinutes,
      slaCompliancePct,
      totalAlerts,
    },
    source: hasPrometheus ? 'prometheus' : 'unavailable',
  })
}

// ?? POST: declare a manual incident ??????????????????????????

export async function POST(req: NextRequest) {
  const deny = await assertOperator()
  if (deny) return deny

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const title = (body.title ?? '').toString().trim()
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 })

  const now      = Date.now()
  const severity = ['critical', 'high', 'medium', 'low'].includes(body.severity)
    ? (body.severity as string) : 'medium'
  const slaMins  = getSlaMinutes()[severity]
  const id       = `INC-${Date.now().toString(36).toUpperCase().slice(-7)}`

  const doc: IncidentDoc = {
    id,
    title,
    description:  (body.description ?? '').toString().trim(),
    severity,
    state:        'open',
    owner:        (body.owner ?? '').toString().trim()   || 'Unassigned',
    team:         (body.team  ?? '').toString().trim()   || 'Platform Engineering',
    service:      (body.service ?? '').toString().trim() || 'unknown',
    environment:  typeof body.environment === 'string' ? body.environment : 'production',
    labels:       (body.labels != null && typeof body.labels === 'object') ? body.labels : {},
    createdAt:    new Date(now).toISOString(),
    updatedAt:    new Date(now).toISOString(),
    slaDeadline:  new Date(now + slaMins * 60 * 1000).toISOString(),
    slaBreached:  false,
    alertCount:   0,
    alerts:       [],
    timeline: [{
      id:          `tl-${id}-0`,
      ts:          new Date(now).toISOString(),
      type:        'user_action',
      title:       'Incident declared',
      description: 'Incident declared manually via Incident Command Center',
    }],
    blastRadius: {
      affectedServices:  (body.service ?? '').toString().trim() ? [(body.service as string).trim()] : [],
      affectedUsers:     0,
      affectedRegions:   [],
      slaBreached:       false,
      dependentServices: [],
    },
    runbookUrls:       [],
    linkedDeployments: [],
    source:            'manual',
    durationMinutes:   0,
    escalationLevel:   0,
  }

  manualStore.set(id, doc)
  persistStore()

  // Fire-and-forget notification (Slack / webhook if configured)
  const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000'
  notifyIncident({
    id, title, severity, service: doc.service, state: doc.state,
    url: `${base}/incidents/${id}`,
  })

  return NextResponse.json(doc, { status: 201 })
}
