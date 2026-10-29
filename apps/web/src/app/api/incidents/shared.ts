import { resolvePromUrl, K8S_TIMEOUT_MS } from '@/lib/cluster'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { readConfig, appendAuditLog } from '@/app/api/settings/config/shared'
import { notifyIncident } from '@/lib/notify'

// SLA window (minutes) per severity — reads runtime config, falls back to defaults
export function getSlaMinutes(): Record<string, number> {
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
    match: /KubePod|CrashLoop|OOMKill|KubeContainer|KubeDeployment|VynOpsWorkload|VynOpsPod/,
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
  notificationChannels?: string[]
  lastAffected?: string
  notificationPending?: boolean
  notificationEvent?: string
  notificationAttempts?: number
  notificationAttemptEvent?: string
  notificationNextAttemptAt?: string
  notificationAbandoned?: boolean
}

const STORE_FILE = join(process.cwd(), 'data', 'incidents-manual.json')

// Minutes to wait before retry n+1 after failed attempt n; the last attempt is abandoned.
const NOTIFY_BACKOFF_MIN = [1, 5, 15, 30, 60]
export const NOTIFY_MAX_ATTEMPTS = NOTIFY_BACKOFF_MIN.length + 1

export function notificationDue(incident: IncidentDoc, now = Date.now()): boolean {
  if (incident.notificationAttemptEvent !== incident.notificationEvent) return true
  return !incident.notificationNextAttemptAt || new Date(incident.notificationNextAttemptAt).getTime() <= now
}

/** Collapses runs of identical notification timeline entries; returns how many were removed. */
export function compactNotificationTimeline(incident: Pick<IncidentDoc, 'timeline'>): number {
  const out: TimelineEvent[] = []
  let removed = 0
  for (const ev of incident.timeline ?? []) {
    const prev = out[out.length - 1]
    if (ev.type === 'notification' && prev?.type === 'notification' && prev.title === ev.title && prev.description === ev.description) {
      prev.metadata = { ...prev.metadata, repeats: Number(prev.metadata?.repeats ?? 1) + 1, lastTs: ev.ts }
      removed++
      continue
    }
    out.push(ev)
  }
  if (removed) incident.timeline = out
  return removed
}

function loadStore(): Map<string, IncidentDoc> {
  try {
    if (!existsSync(STORE_FILE)) return new Map()
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Record<string, IncidentDoc>
    let compacted = 0
    for (const incident of Object.values(raw)) compacted += compactNotificationTimeline(incident)
    if (compacted) writeAtomicJson(STORE_FILE, raw)
    return new Map(Object.entries(raw))
  } catch {
    throw new Error('Unable to read incident history')
  }
}

export function writeAtomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = file + '.tmp'
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(temporary, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt === 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1))
    }
  }
}

function saveStore(store: Map<string, IncidentDoc>): void {
  writeAtomicJson(STORE_FILE, Object.fromEntries(store))
}

const sharedGlobal = globalThis as typeof globalThis & { vynopsIncidentStore?: Map<string, IncidentDoc> }
export const manualStore: Map<string, IncidentDoc> = sharedGlobal.vynopsIncidentStore ??= loadStore()
const lockGlobal = globalThis as typeof globalThis & { vynopsEscalationLocks?: Set<string>; vynopsNotificationLocks?: Set<string> }
export const escalationLocks = lockGlobal.vynopsEscalationLocks ??= new Set<string>()
const notificationLocks = lockGlobal.vynopsNotificationLocks ??= new Set<string>()

export function persistStore(): void {
  saveStore(manualStore)
}

const WORKLOAD_LABELS = ['deployment', 'statefulset', 'daemonset', 'job_name', 'pod', 'container'] as const

/** Which workloads an incident's alerts point at, e.g. "shop/web-1 (KubePodCrashLooping)"; grouped incidents have generic titles. */
export function affectedSummary(incident: Pick<IncidentDoc, 'alerts'>, max = 3): string {
  const seen = new Map<string, Set<string>>()
  for (const a of incident.alerts ?? []) {
    const labels = a.labels ?? {}
    const workload = WORKLOAD_LABELS.map(k => labels[k]).find(Boolean) ?? labels.service ?? labels.job ?? labels.instance
    const target = [labels.namespace, workload].filter(Boolean).join('/')
    if (!target) continue
    if (!seen.has(target)) seen.set(target, new Set())
    seen.get(target)!.add(a.name)
  }
  const entries = [...seen.entries()]
  const shown = entries.slice(0, max).map(([target, names]) => `${target} (${[...names].join(', ')})`)
  if (entries.length > max) shown.push(`+${entries.length - max} more`)
  return shown.join('; ')
}

/** Escalation levels count from the latest reopen, not from the alert's original start. */
export function escalationClockStart(incident: Pick<IncidentDoc, 'createdAt' | 'timeline'>): number {
  const reopened = (incident.timeline ?? []).filter(e => e.title === 'Alerts firing again').map(e => Date.parse(e.ts) || 0)
  return Math.max(Date.parse(incident.createdAt) || 0, ...reopened)
}

export async function dispatchIncidentNotification(incident: IncidentDoc): Promise<void> {
  if (notificationLocks.has(incident.id)) return
  notificationLocks.add(incident.id)
  try {
  const event = incident.notificationEvent ?? 'incident.created'
  const generation = incident.updatedAt
  if (incident.notificationAbandoned || incident.notificationAttemptEvent !== event) {
    incident.notificationAttempts = 0
    incident.notificationAbandoned = false
  }
  const base = (process.env.NEXTAUTH_URL ?? 'http://localhost:3030').replace(/\/$/, '')
  const result = await notifyIncident({ ...incident, detail: affectedSummary(incident) || incident.lastAffected, url: `${base}/incidents?id=${encodeURIComponent(incident.id)}` }, event, incident.notificationChannels ?? [])
  if (incident.notificationEvent !== event || incident.updatedAt !== generation) return
  incident.notificationChannels = result.channels
  const now = new Date().toISOString()
  const note = (title: string, description: string, metadata: Record<string, unknown>) =>
    incident.timeline.push({ id: `tl-${incident.id}-${now}-notification`, ts: now, type: 'notification', title, description, actor: 'system', metadata })
  if (result.ok) {
    incident.notificationPending = false
    incident.notificationAttempts = 0
    incident.notificationNextAttemptAt = undefined
    note(`Notification ${result.status}`, `${event}: ${result.channels.join(', ') || 'no channel delivered'}`, { status: result.status, channels: result.channels })
  } else {
    const attempts = (incident.notificationAttempts ?? 0) + 1
    incident.notificationAttempts = attempts
    incident.notificationAttemptEvent = event
    if (attempts >= NOTIFY_MAX_ATTEMPTS) {
      incident.notificationPending = false
      incident.notificationAbandoned = true
      incident.notificationNextAttemptAt = undefined
      note('Notification abandoned', `${event}: gave up after ${attempts} attempts`, { status: result.status, channels: result.channels, attempts })
    } else {
      incident.notificationPending = true
      incident.notificationNextAttemptAt = new Date(Date.now() + NOTIFY_BACKOFF_MIN[attempts - 1]! * 60_000).toISOString()
      if (attempts === 1) note(`Notification ${result.status}`, `${event}: ${result.channels.join(', ') || 'no channel delivered'}`, { status: result.status, channels: result.channels })
    }
  }
  persistStore()
  } finally {
    notificationLocks.delete(incident.id)
  }
}

// A manual resolve gets this long to take effect before still-firing alerts reopen the incident.
export const REOPEN_GRACE_MS = 30 * 60 * 1000

function stillFiringAfterResolve(incident: IncidentDoc): boolean {
  const resolvedMs = incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : 0
  return Date.now() - resolvedMs > REOPEN_GRACE_MS
}

const ALERT_SEVERITY: Record<string, string> = { warning: 'medium', error: 'high', major: 'high', page: 'critical', minor: 'low' }
export function normalizeAlertSeverity(raw: string | undefined): string {
  const s = (raw ?? 'medium').toLowerCase()
  return ALERT_SEVERITY[s] ?? s
}

export function reconcileAutoIncidents(incidents: IncidentDoc[], hasPrometheus: boolean): void {
  if (!hasPrometheus) return
  const now = new Date().toISOString()
  const activeIds = new Set(incidents.map(incident => incident.id))
  for (const detected of incidents) {
    const existing = manualStore.get(detected.id)
    if (!existing) {
      detected.notificationPending = true
      detected.notificationEvent = 'incident.created'
      manualStore.set(detected.id, detected)
      appendAuditLog({ ts: now, user: 'system', action: 'incident.created', detail: detected.id })
      continue
    }
    if (existing.state === 'resolved' && (existing.alertCount === 0 || stillFiringAfterResolve(existing))) {
      existing.state = 'investigating'
      existing.createdAt = detected.createdAt
      existing.slaDeadline = detected.slaDeadline
      existing.resolvedAt = undefined
      existing.escalationLevel = 0
      existing.notificationChannels = []
      existing.notificationPending = true
      existing.notificationEvent = 'incident.reopened'
      existing.timeline.push({ id: `tl-${existing.id}-${now}-reopen`, ts: now, type: 'alert', title: 'Alerts firing again', description: 'A new alert occurrence reopened this incident', actor: 'system' })
      appendAuditLog({ ts: now, user: 'system', action: 'incident.reopened', detail: existing.id })
    }
    existing.alerts = detected.alerts
    existing.alertCount = detected.alertCount
    existing.severity = detected.severity
    existing.updatedAt = now
    existing.slaBreached = (existing.resolvedAt ? new Date(existing.resolvedAt).getTime() : Date.now()) > new Date(existing.slaDeadline).getTime()
  }
  for (const incident of manualStore.values()) {
    if (incident.source !== 'auto' || activeIds.has(incident.id) || incident.alertCount === 0) continue
    incident.lastAffected = affectedSummary(incident) || incident.lastAffected
    incident.alerts = []
    incident.alertCount = 0
    incident.updatedAt = now
    if (incident.state !== 'resolved') {
      incident.state = 'resolved'
      incident.resolvedAt = now
      incident.notificationChannels = []
      incident.notificationPending = true
      incident.notificationEvent = 'incident.resolved'
      incident.timeline.push({ id: `tl-${incident.id}-${now}-recovery`, ts: now, type: 'alert', title: 'Alerts recovered', description: 'A successful Prometheus poll confirmed that the firing alerts cleared', actor: 'system' })
      appendAuditLog({ ts: now, user: 'system', action: 'incident.resolved', detail: incident.id })
    }
  }
  persistStore()
}

export function recordSlaBreaches(): void {
  const now = Date.now()
  for (const incident of manualStore.values()) {
    if (incident.state === 'resolved' || now <= new Date(incident.slaDeadline).getTime()) continue
    incident.slaBreached = true
    if (incident.timeline.some(event => event.title === 'SLA deadline exceeded')) continue
    const ts = new Date(now).toISOString()
    incident.timeline.push({ id: `tl-${incident.id}-${ts}-sla`, ts, type: 'escalation', title: 'SLA deadline exceeded', description: 'The server detected an unresolved incident past its SLA deadline', actor: 'system' })
    if (!incident.notificationPending) {
      incident.notificationPending = true
      incident.notificationChannels = []
      incident.notificationEvent = 'incident.sla_breached'
    }
    appendAuditLog({ ts, user: 'system', action: 'incident.sla_breached', detail: incident.id })
  }
  persistStore()
}

export const SEV_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0, none: 0 }

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
      actor: 'system',
    },
  ]

  if (slaBreached) {
    timeline.push({
      id: `tl-${groupKey}-sla`,
      ts: new Date(slaDeadlineMs).toISOString(),
      type: 'escalation',
      title: 'SLA deadline exceeded',
      description: `${severity.toUpperCase()} incidents have a ${slaMins < 60 ? slaMins + '-min' : Math.round(slaMins / 60) + '-hour'} SLA — now ${fmtMins(durationMins - slaMins)} overdue`,
      severity: 'critical',
    })
  }

  const affectedServices = [...new Set(alerts.flatMap(a => a.affectedServices ?? []))]

  return {
    id: `INC-${groupKey.toUpperCase().replace(/-/g, '-')}`,
    title: groupTitle,
    description: `${alerts.length} related ${severity}-severity alert${alerts.length > 1 ? 's' : ''} detected by Prometheus have been firing since ${new Date(minStartMs).toUTCString()}. Affected component: ${service}.`,
    severity,
    state: 'investigating',
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
    const severity: string = normalizeAlertSeverity(r.metric?.severity)
    const alertstate: string = r.metric?.alertstate ?? 'firing'

    if (!alertname || alertname === 'Watchdog' || r.metric?.severity === 'none') continue
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

  return { incidents, totalAlerts, hasPrometheus: alertsJson?.status === 'success' && Array.isArray(alertsJson?.data?.result) }
}
