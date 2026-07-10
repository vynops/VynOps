'use client'

import { useState, useMemo, useEffect, useCallback, useRef, Fragment, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { format } from 'date-fns'
import { Activity, Search, Filter, RefreshCw, BarChart3, FileText, GitBranch, Info, Terminal, Loader2, AlertTriangle, ChevronDown, ChevronRight, Clock, Layers, Zap, TrendingUp, TrendingDown, Download, Copy, ExternalLink, Target, ShieldCheck, X, BellOff, Link2, Bell, Siren, ScrollText, Maximize2, Cpu, MemoryStick } from 'lucide-react'
import { useLiveData } from '@/hooks/useLiveData'
import { useDashboardStore } from '@/store'
import { MetricChart } from '@/components/charts/MetricChart'
import { Sparkline } from '@/components/charts/Sparkline'
import { cn, formatLatency, formatNumber, exportCSV } from '@/lib/utils'
import type { Trace, ClusterMetrics, ServiceMetric } from '@/types'

const TABS = ['Metrics', 'Logs', 'Traces', 'Events'] as const
type Tab = typeof TABS[number]

const WINDOWS = [{ label: '15m', value: '15' }, { label: '1h', value: '60' }, { label: '6h', value: '360' }, { label: '24h', value: '1440' }]
const LOOKBACKS = ['15m', '30m', '1h', '3h', '6h', '24h']

/** Convert header timeRange string to minutes for the metrics API */
function timeRangeToMinutes(tr: string): number {
  const map: Record<string, number> = {
    '15m': 15, '30m': 30, '1h': 60, '3h': 180,
    '6h': 360, '12h': 720, '24h': 1440, '7d': 10080, '30d': 43200,
  }
  return map[tr] ?? 60
}

// ── Trace waterfall helpers ───────────────────────────────────
const PALETTE = [
  '#06b6d4','#3b82f6','#8b5cf6','#f97316','#22c55e',
  '#eab308','#ec4899','#14b8a6','#6366f1','#f43f5e',
]
const colorCache: Record<string, string> = {}
let colorIdx = 0
const svcColor = (s: string) => {
  if (!colorCache[s]) colorCache[s] = PALETTE[colorIdx++ % PALETTE.length]!
  return colorCache[s]!
}

function TraceWaterfall({ trace, selectedSpanId, onSelectSpan }: { trace: Trace; selectedSpanId: string | null; onSelectSpan: (id: string | null) => void }) {
  const total = trace.totalDuration
  return (
    <div className="space-y-0.5 py-1">
      {trace.spans.map(span => {
        const leftPct = (span.startOffset / total) * 100
        const widthPct = Math.max((span.duration / total) * 100, 0.5)
        const color = span.status === 'error' ? '#ef4444' : span.status === 'slow' ? '#f59e0b' : svcColor(span.service)
        const isSelected = selectedSpanId === span.id
        return (
          <div key={span.id}
            onClick={() => onSelectSpan(isSelected ? null : span.id)}
            className={cn('flex items-center gap-2 rounded px-3 py-1 cursor-pointer transition-colors',
              isSelected ? 'bg-brand-500/10 border border-brand-500/20' : 'hover:bg-surface-800/40 border border-transparent'
            )}>
            <div className="w-48 flex-shrink-0 flex items-center gap-1" style={{ paddingLeft: `${span.depth * 12}px` }}>
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              <span className="text-2xs text-surface-300 truncate font-mono">{span.service}</span>
            </div>
            <div className="w-36 flex-shrink-0">
              <span className="text-2xs text-surface-500 truncate block">{span.operation}</span>
            </div>
            <div className="flex-1 relative h-5">
              <div
                className="absolute top-0.5 h-4 rounded"
                style={{
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  backgroundColor: color,
                  opacity: span.status === 'error' ? 1 : 0.75,
                }}
              />
            </div>
            <span className={cn('text-2xs font-mono flex-shrink-0 w-14 text-right',
              span.status === 'error' ? 'text-danger' :
              span.status === 'slow' ? 'text-warning' : 'text-surface-400'
            )}>{span.duration}ms</span>
          </div>
        )
      })}
    </div>
  )
}

function ObservabilityInner() {
  const { timeRange, activeCluster } = useDashboardStore()
  const metricWindow = String(timeRangeToMinutes(timeRange))
  const router = useRouter()
  const searchParams = useSearchParams()
  const [activeTab, setActiveTab]         = useState<Tab>(() => {
    const t = searchParams.get('tab')
    return (TABS as readonly string[]).includes(t ?? '') ? t as Tab : 'Metrics'
  })
  const [search, setSearch]               = useState('')
  const [filterStatus, setFilterStatus]   = useState<string>('all')
  const [filterOpen, setFilterOpen]       = useState(false)
  const [selectedTrace, setSelectedTrace] = useState<Trace | null>(null)
  const [traceService, setTraceService]   = useState(() => searchParams.get('service') ?? '')
  const [traceLookback, setTraceLookback] = useState('1h')
  const [traceMinDur, setTraceMinDur]     = useState('')
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)
  const [logLevel, setLogLevel]           = useState<string>('all')
  const [logSearch, setLogSearch]         = useState('')
  const [evtNs, setEvtNs]                 = useState('')
  const [evtType, setEvtType]             = useState<string>('all')
  const [expandedEvt, setExpandedEvt]     = useState<string | null>(null)
  const [evtView, setEvtView]             = useState<'list'|'groups'>('list')
  const [evtSearch, setEvtSearch]         = useState('')
  const [evtReason, setEvtReason]         = useState('')
  const [evtPage, setEvtPage]             = useState(50)

  // Traces extra filters
  const [traceSearch, setTraceSearch]     = useState('')
  const [traceStatus, setTraceStatus]     = useState<'all'|'error'|'slow'>('all')
  const [traceSort, setTraceSort]         = useState<'newest'|'slowest'|'spans'>('newest')

  // Metrics table sort
  const [metricSort, setMetricSort]       = useState<{col:string;dir:'asc'|'desc'}>({col:'name',dir:'asc'})

  // Pod log viewer state
  const [logNs, setLogNs] = useState('')
  const [logPod, setLogPod] = useState('')
  const [logContainer, setLogContainer] = useState('')
  const [liveLogs, setLiveLogs] = useState<{ id: number; ts: string; level: string; msg: string }[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [isLiveFeed, setIsLiveFeed] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(10)
  const [logLevelFilter, setLogLevelFilter] = useState('all')
  const [logTail, setLogTail] = useState(true)
  const [logTailLines, setLogTailLines]     = useState(300)
  const [logWrap, setLogWrap]               = useState(false)

  // Loki search state
  const [lokiQuery,    setLokiQuery]    = useState('')
  const [lokiSince,    setLokiSince]    = useState('60')
  const [lokiStart,    setLokiStart]    = useState<number | null>(null)
  const [lokiEnd,      setLokiEnd]      = useState<number | null>(null)
  const [lokiLoading,  setLokiLoading]  = useState(false)
  const [lokiError,    setLokiError]    = useState<string | null>(null)
  const [lokiLogs,     setLokiLogs]     = useState<{ id: number; ts: string; level: string; msg: string }[]>([])
  const [lokiQueried,  setLokiQueried]  = useState(false)
  const [lokiAvailable,setLokiAvailable]= useState<boolean | null>(null)
  const [lokiLabels,   setLokiLabels]   = useState<string[]>([])
  const [lokiSearch,   setLokiSearch]   = useState('')

  const [evtAutoRefresh, setEvtAutoRefresh] = useState(false)
  const autoRefreshRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const evtAutoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Event action state — Suppress, Webhook, Auto-Esc, Create Incident
  const [suppressionRules, setSuppressionRules] = useState<{ id: string; reason: string; namespace: string; durationMin: number; expiresAt: number }[]>(() => {
    try { return JSON.parse(typeof window !== 'undefined' ? (localStorage.getItem('vynops-event-suppressions') ?? '[]') : '[]') } catch { return [] }
  })
  const [showSuppressionModal, setShowSuppressionModal] = useState(false)
  const [newSupRule, setNewSupRule] = useState({ reason: '', namespace: 'all', durationMin: 60 })
  const [webhookUrl, setWebhookUrl] = useState<string>(() => typeof window !== 'undefined' ? (localStorage.getItem('vynops-webhook-url') ?? '') : '')
  const [showWebhookModal, setShowWebhookModal] = useState(false)
  const [webhookInput, setWebhookInput] = useState('')
  const [autoEscRules, setAutoEscRules] = useState<{ reason: string; minCount: number; severity: 'critical' | 'high' | 'medium' }[]>(() => {
    try { return JSON.parse(typeof window !== 'undefined' ? (localStorage.getItem('vynops-auto-esc') ?? '[]') : '[]') } catch { return [] }
  })
  const [showAutoEsc, setShowAutoEsc] = useState(false)
  const [newEscRule, setNewEscRule] = useState({ reason: '', minCount: 5, severity: 'high' as 'critical' | 'high' | 'medium' })
  const [evtCreateModal, setEvtCreateModal] = useState<{ reason: string; message: string; namespace: string } | null>(null)
  const [evtCreateForm, setEvtCreateForm] = useState({ title: '', severity: 'high' as 'critical' | 'high' | 'medium', owner: 'on-call@vynops.io' })
  const [evtCreateSuccess, setEvtCreateSuccess] = useState<string | null>(null)
  const logEndRef      = useRef<HTMLDivElement>(null)
  const autoOpenedRef  = useRef(false)
  const pendingLokiFetch = useRef(false)

  // ── Drill-down panel state ────────────────────────────────────────────────
  type DrillRow = { name: string; value: number; unit: string; meta?: Record<string, string> }
  type DrillState = { metric: string; ts: number; value: number; label: string; rows: DrillRow[] | null; loading: boolean }
  type SubState   = { rowName: string; rows: DrillRow[] | null; loading: boolean }
  const [drill, setDrill]   = useState<DrillState | null>(null)
  const [sub,   setSub]     = useState<SubState | null>(null)

  // ── Metric popup state (expanded chart modal) ─────────────────────────────
  type MetricDef = { label: string; metricKey: string; data: any[]; unit: string; color: string; warn?: number; crit?: number; current?: number }
  const [metricPopup, setMetricPopup] = useState<MetricDef | null>(null)
  const [popupDrill, setPopupDrill]   = useState<DrillState | null>(null)
  const [popupSub,   setPopupSub]     = useState<SubState | null>(null)

  const openPopupDrill = useCallback(async (metricKey: string, label: string, tsMs: number, value: number) => {
    const tsS = Math.floor(tsMs / 1000)
    setPopupSub(null)
    setPopupDrill(prev => ({ metric: metricKey, ts: tsS, value, label, rows: prev?.rows ?? null, loading: true }))
    try {
      const r = await fetch(`/api/observability/breakdown?metric=${metricKey}&at=${tsS}`)
      const j = await r.json()
      setPopupDrill(prev => prev ? { ...prev, rows: j.rows ?? [], loading: false } : null)
    } catch {
      setPopupDrill(prev => prev ? { ...prev, rows: [], loading: false } : null)
    }
  }, [])

  const togglePopupSub = useCallback(async (row: DrillRow) => {
    if (!popupDrill) return
    if (popupSub?.rowName === row.name) { setPopupSub(null); return }
    const meta = row.meta ?? {}
    const podName = meta.pod ?? (row.name.includes('/') ? row.name.split('/')[1] : row.name)
    const ns      = meta.namespace ?? (row.name.includes('/') ? row.name.split('/')[0] : '')
    const svcName = meta.service ?? row.name
    const sub_    = popupDrill.metric === 'cpu' || popupDrill.metric === 'memory' ? podName : svcName
    setPopupSub({ rowName: row.name, rows: null, loading: true })
    try {
      const params = new URLSearchParams({ metric: popupDrill.metric, at: String(popupDrill.ts), sub: sub_, namespace: ns })
      const r = await fetch(`/api/observability/breakdown?${params}`)
      const j = await r.json()
      setPopupSub({ rowName: row.name, rows: j.rows ?? [], loading: false })
    } catch {
      setPopupSub({ rowName: row.name, rows: [], loading: false })
    }
  }, [popupDrill, popupSub])

  const openDrill = useCallback(async (metricKey: string, label: string, tsMs: number, value: number) => {
    const tsS = Math.floor(tsMs / 1000)
    setSub(null)
    setDrill(prev => ({
      metric: metricKey, ts: tsS, value, label,
      rows: prev?.rows ?? null,
      loading: true,
    }))
    try {
      const r = await fetch(`/api/observability/breakdown?metric=${metricKey}&at=${tsS}`)
      const j = await r.json()
      setDrill(prev => prev ? { ...prev, rows: j.rows ?? [], loading: false } : null)
    } catch {
      setDrill(prev => prev ? { ...prev, rows: [], loading: false } : null)
    }
  }, [])

  const toggleSub = useCallback(async (row: DrillRow) => {
    if (!drill) return
    // Collapse if already open
    if (sub?.rowName === row.name) { setSub(null); return }
    // Extract pod / namespace / service from row name or meta
    const meta = row.meta ?? {}
    const podName  = meta.pod ?? (row.name.includes('/') ? row.name.split('/')[1] : row.name)
    const ns       = meta.namespace ?? (row.name.includes('/') ? row.name.split('/')[0] : '')
    const svcName  = meta.service ?? row.name
    const sub_     = drill.metric === 'cpu' || drill.metric === 'memory' ? podName : svcName
    setSub({ rowName: row.name, rows: null, loading: true })
    try {
      const params = new URLSearchParams({ metric: drill.metric, at: String(drill.ts), sub: sub_, namespace: ns })
      const r = await fetch(`/api/observability/breakdown?${params}`)
      const j = await r.json()
      setSub({ rowName: row.name, rows: j.rows ?? [], loading: false })
    } catch {
      setSub({ rowName: row.name, rows: [], loading: false })
    }
  }, [drill, sub])

  // Auto-open drill panel when navigated from dashboard with ?metric= param
  const autoMetricParam = searchParams.get('metric')

  // Reset Loki probe state whenever the active cluster changes so it re-probes
  useEffect(() => {
    setLokiAvailable(null)
    setLokiLabels([])
  }, [activeCluster?.id])

  // Probe Loki availability + labels when Logs tab is active
  useEffect(() => {
    if (activeTab !== 'Logs' || lokiAvailable !== null) return
    const headers: HeadersInit = activeCluster ? {
      'X-Loki-Url': activeCluster.lokiUrl || 'none',
    } : {}
    fetch('/api/observability/loki', { headers }).then(r => r.json()).then(j => {
      setLokiAvailable(j.lokiAvailable ?? false)
      setLokiLabels(j.labels ?? [])
    }).catch(() => setLokiAvailable(false))
  }, [activeTab, lokiAvailable, activeCluster])

  const fetchLokiLogs = useCallback(async () => {
    if (!lokiQuery.trim()) return
    setLokiLoading(true); setLokiError(null); setLokiQueried(true)
    try {
      const headers: Record<string, string> = {}
      if (activeCluster) headers['X-Loki-Url'] = activeCluster.lokiUrl || 'none'
      const qp = new URLSearchParams({ query: lokiQuery, limit: '500' })
      if (lokiStart !== null && lokiEnd !== null) {
        qp.set('start', String(lokiStart))
        qp.set('end',   String(lokiEnd))
      } else {
        qp.set('since', lokiSince)
      }
      const r = await fetch(`/api/observability/loki?${qp}`, { headers })
      const j = await r.json()
      if (!r.ok || j.error) { setLokiError(j.error ?? 'Query failed'); return }
      setLokiLogs(j.lines ?? [])
    } catch (e) { setLokiError(String(e)) }
    finally   { setLokiLoading(false) }
  }, [lokiQuery, lokiSince, lokiStart, lokiEnd, activeCluster])

  // Auto-fetch Loki when triggered from spike drill (after state settles)
  useEffect(() => {
    if (activeTab === 'Logs' && pendingLokiFetch.current && lokiQuery.trim()) {
      pendingLokiFetch.current = false
      fetchLokiLogs()
    }
  }, [activeTab, lokiQuery, lokiSince, fetchLokiLogs])

  // Empty zero-state cluster metrics — shown only while API loads, never fake/mock data
  const EMPTY_CLUSTER: ClusterMetrics = useMemo(() => ({
    cpuUsage: 0, memoryUsage: 0, networkInBytes: 0, networkOutBytes: 0,
    diskReadBytes: 0, diskWriteBytes: 0, podRestartRate: 0, errorRate: 0,
    p50Latency: 0, p99Latency: 0, requestRate: 0,
    history: { cpu: [], memory: [], requests: [], errors: [], latency: [] },
  }), [])
  const { data: liveMetrics, loading: metricsLoading, refresh: refreshMetrics } = useLiveData(
    `/api/observability/metrics?window=${metricWindow}`,
    { clusterMetrics: EMPTY_CLUSTER, serviceMetrics: [] as ServiceMetric[], namespaceUsage: [] as { namespace: string; cpuCores: number; memGiB: number; restarts: number }[], clusterCpuCores: 0 },
    (r) => ({
      clusterMetrics:  r.clusterMetrics  ?? EMPTY_CLUSTER,
      serviceMetrics:  r.serviceMetrics  ?? [],
      namespaceUsage:  r.namespaceUsage  ?? [],
      clusterCpuCores: r.clusterCpuCores ?? 0,
    }),
  )
  const { clusterMetrics, serviceMetrics, namespaceUsage, clusterCpuCores } = liveMetrics

  // Auto-open drill panel once metrics have loaded (must be after metricsLoading is declared)
  useEffect(() => {
    if (!autoMetricParam || autoOpenedRef.current || metricsLoading) return
    const map: Record<string, { label: string; value: number }> = {
      cpu:      { label: 'CPU Usage',    value: clusterMetrics.cpuUsage },
      memory:   { label: 'Memory Usage', value: clusterMetrics.memoryUsage },
      requests: { label: 'Request Rate', value: clusterMetrics.requestRate },
      errors:   { label: 'Error Rate',   value: clusterMetrics.errorRate },
      latency:  { label: 'p99 Latency',  value: clusterMetrics.p99Latency },
    }
    const entry = map[autoMetricParam]
    if (!entry) return
    autoOpenedRef.current = true
    openDrill(autoMetricParam, entry.label, Date.now(), entry.value)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMetricParam, metricsLoading])

  const { data: eventsData, isLive: eventsLive, error: eventsError, loading: eventsLoading, refresh: refreshEvents } = useLiveData('/api/k8s/events', {
    events: [] as any[], anomalies: [] as any[], correlatedGroups: [] as any[],
    summary: { total: 0, warnings: 0, highRepeat: 0, recentWarnings15m: 0, anomalyBursts: 0 },
  }, (r) => ({
    events: r.events ?? [],
    anomalies: r.anomalies ?? [],
    correlatedGroups: r.correlatedGroups ?? [],
    summary: r.summary ?? { total: 0, warnings: 0, highRepeat: 0, recentWarnings15m: 0, anomalyBursts: 0 },
  }))
  const { data: podsData, isLive: podsLive, error: podsError, loading: podsLoading } = useLiveData('/api/k8s/pods', { pods: [] as any[], podsByNode: {} as Record<string, any[]> }, (r) => ({ pods: r.pods ?? [], podsByNode: r.podsByNode ?? {} }))
  const { data: tracesData } = useLiveData(
    `/api/observability/traces?lookback=${traceLookback}${traceService ? `&service=${encodeURIComponent(traceService)}` : ''}${traceMinDur ? `&minDuration=${encodeURIComponent(traceMinDur)}` : ''}${/^[0-9a-f]{32}$/.test(traceSearch) ? `&traceId=${traceSearch}` : ''}`,
    { traces: [] as Trace[], total: 0, jaegerAvailable: false, services: [] as string[] },
    (r) => ({ traces: (r.traces ?? []) as Trace[], total: r.total ?? 0, jaegerAvailable: r.jaegerAvailable ?? false, services: (r.services ?? []) as string[] }),
  )

  // Auto-select first trace when data loads
  useEffect(() => {
    if (tracesData.traces.length > 0 && !selectedTrace) {
      setSelectedTrace(tracesData.traces[0] ?? null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracesData.traces])

  // Unique namespaces from pods
  const podNamespaces = useMemo(() => [...new Set((podsData.pods as any[]).map((p: any) => p.namespace))].sort(), [podsData.pods])
  // Pods in selected namespace
  const podsInNs = useMemo(() => (podsData.pods as any[]).filter((p: any) => p.namespace === logNs).map((p: any) => p.name), [podsData.pods, logNs])
  // Containers in selected pod
  const containersInPod = useMemo(() => {
    const pod = (podsData.pods as any[]).find((p: any) => p.namespace === logNs && p.name === logPod)
    return (pod?.containers ?? []).map((c: any) => c.name) as string[]
  }, [podsData.pods, logNs, logPod])

  const fetchPodLogs = useCallback(async () => {
    if (!logNs || !logPod) return
    setLogLoading(true)
    setLogError(null)
    try {
      const qp = new URLSearchParams({ tailLines: String(logTailLines) })
      if (logContainer) qp.set('container', logContainer)
      const url = `/api/k8s/pods/${encodeURIComponent(logNs)}/${encodeURIComponent(logPod)}/logs?${qp}`
      const clusterHeaders: Record<string, string> = {}
      if (activeCluster) {
        clusterHeaders['X-K8s-Url']          = activeCluster.k8sUrl          || 'none'
        clusterHeaders['X-Prom-Url']         = activeCluster.promUrl         || 'none'
        clusterHeaders['X-Alertmanager-Url'] = activeCluster.alertmanagerUrl || 'none'
        clusterHeaders['X-Loki-Url']         = activeCluster.lokiUrl         || 'none'
        clusterHeaders['X-Jaeger-Url']       = activeCluster.jaegerUrl       || 'none'
        clusterHeaders['X-Grafana-Url']      = activeCluster.grafanaUrl      || 'none'
      }
      const r = await fetch(url, Object.keys(clusterHeaders).length ? { headers: clusterHeaders } : undefined)
      if (!r.ok) { const e = await r.json(); setLogError(e.error ?? 'Failed to fetch logs'); return }
      const j = await r.json()
      setLiveLogs(j.lines ?? [])
      setIsLiveFeed(true)
    } catch (e) {
      setLogError(String(e))
      setIsLiveFeed(false)
    } finally {
      setLogLoading(false)
    }
  }, [logNs, logPod, logContainer, logTailLines, activeCluster])

  const downloadLogs = useCallback(() => {
    if (!liveLogs.length) return
    const text = liveLogs.map(l => `${l.ts} [${l.level}] ${l.msg}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `${logPod}${logContainer ? `-${logContainer}` : ''}.log`,
    })
    document.body.appendChild(a); a.click()
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href) }, 100)
  }, [liveLogs, logPod, logContainer])

  // Auto-refresh live logs
  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
    if (autoRefresh && logNs && logPod) {
      autoRefreshRef.current = setInterval(fetchPodLogs, autoRefreshInterval * 1_000)
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current) }
  }, [autoRefresh, logNs, logPod, fetchPodLogs, autoRefreshInterval])

  // Tail mode — scroll to bottom when new logs arrive
  useEffect(() => {
    if (logTail && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [liveLogs, logTail])

  // Events auto-refresh (15s poll)
  useEffect(() => {
    if (evtAutoRefreshRef.current) clearInterval(evtAutoRefreshRef.current)
    if (evtAutoRefresh) evtAutoRefreshRef.current = setInterval(refreshEvents, 15_000)
    return () => { if (evtAutoRefreshRef.current) clearInterval(evtAutoRefreshRef.current) }
  }, [evtAutoRefresh, refreshEvents])

  // Events derived
  const evtNamespaces = useMemo(() => [
    ...new Set((eventsData.events as any[]).map((e: any) => e.namespace).filter(Boolean))
  ].sort(), [eventsData.events])

  const filteredEvents = useMemo(() => (eventsData.events as any[]).filter((e: any) => {
    const nsOk     = !evtNs     || e.namespace === evtNs
    const typeOk   = evtType   === 'all' || e.type === evtType
    const reasonOk = !evtReason || e.reason === evtReason
    const q        = evtSearch.toLowerCase()
    const searchOk = !q || e.message?.toLowerCase().includes(q) || e.reason?.toLowerCase().includes(q) || e.involvedObject?.name?.toLowerCase().includes(q)
    return nsOk && typeOk && reasonOk && searchOk
  }), [eventsData.events, evtNs, evtType, evtReason, evtSearch])

  const evtReasons = useMemo(() => [
    ...new Set((eventsData.events as any[]).map((e: any) => e.reason).filter(Boolean))
  ].sort(), [eventsData.events])

  // Filtered + sorted traces
  const filteredTraces = useMemo(() => {
    let t = tracesData.traces.filter(tr => {
      const svcOk    = !traceService || tr.rootService === traceService
      const statusOk = traceStatus === 'all' || tr.status === traceStatus
      const searchOk = !traceSearch || tr.rootOperation.toLowerCase().includes(traceSearch.toLowerCase()) || tr.rootService.toLowerCase().includes(traceSearch.toLowerCase()) || tr.id.startsWith(traceSearch.toLowerCase())
      return svcOk && statusOk && searchOk
    })
    if (traceSort === 'slowest') t = [...t].sort((a, b) => b.totalDuration - a.totalDuration)
    if (traceSort === 'spans')   t = [...t].sort((a, b) => b.spanCount - a.spanCount)
    return t
  }, [tracesData.traces, traceService, traceStatus, traceSearch, traceSort])

  // Sortable service metrics
  const sortedServices = useMemo(() => {
    const T = 300
    const arr = serviceMetrics.filter(s =>
      (!search || s.name.toLowerCase().includes(search.toLowerCase())) &&
      (filterStatus === 'all' || s.status === filterStatus)
    )
    return [...arr].sort((a, b) => {
      const d = metricSort.dir === 'asc' ? 1 : -1
      if (metricSort.col === 'requestRate')  return (a.requestRate  - b.requestRate)  * d
      if (metricSort.col === 'errorRate')    return (a.errorRate    - b.errorRate)    * d
      if (metricSort.col === 'p50')          return (a.p50Latency   - b.p50Latency)   * d
      if (metricSort.col === 'p99')          return (a.p99Latency   - b.p99Latency)   * d
      if (metricSort.col === 'availability') return (a.availability - b.availability) * d
      if (metricSort.col === 'apdex') {
        const apdex = (svc: typeof a) => svc.p50Latency > 0
          ? Math.max(0, Math.min(1, (svc.p50Latency <= T ? 1 - svc.errorRate / 100 : 0) + (svc.p50Latency > T && svc.p50Latency <= T * 4 ? (1 - svc.errorRate / 100) * 0.5 : 0)))
          : -1
        return (apdex(a) - apdex(b)) * d
      }
      if (metricSort.col === 'status')       return a.status.localeCompare(b.status)  * d
      return a.name.localeCompare(b.name) * d
    })
  }, [serviceMetrics, search, filterStatus, metricSort])

  // Relative time helper
  const relTime = (iso: string) => {
    try {
      const ms = Date.now() - new Date(iso).getTime()
      if (ms < 0)           return 'just now'
      if (ms < 60_000)      return `${Math.floor(ms / 1_000)}s ago`
      if (ms < 3_600_000)   return `${Math.floor(ms / 60_000)}m ago`
      if (ms < 86_400_000)  return `${Math.floor(ms / 3_600_000)}h ago`
      return new Date(iso).toLocaleDateString()
    } catch { return '' }
  }

  // Trend from sparkline data (positive = rising, negative = falling)
  const sparkTrend = (data: { ts: number; value: number }[] | number[]) => {
    if (data.length < 4) return 0
    const vals = (data as any[]).map((d: any) => typeof d === 'object' ? d.value : d) as number[]
    const half = Math.floor(vals.length / 2)
    const avg = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / arr.length
    return avg(vals.slice(half)) - avg(vals.slice(0, half))
  }

  // Sortable column header helper — sets sort col/dir
  const sortBy = (col: string) => setMetricSort(prev =>
    prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'desc' }
  )

  // Log volume histogram — 20 time-buckets coloured by highest severity (Datadog-style)
  const logHistogram = useMemo(() => {
    if (liveLogs.length < 2) return []
    const BUCKETS = 20
    const times = liveLogs.map(l => new Date(l.ts).getTime()).filter(t => !isNaN(t))
    if (times.length < 2) return []
    const tmin = times.reduce((a, b) => Math.min(a, b))
    const tmax = times.reduce((a, b) => Math.max(a, b))
    const range = tmax - tmin || 1
    const arr = Array.from({ length: BUCKETS }, () => ({ E: 0, W: 0, I: 0 }))
    for (const l of liveLogs) {
      const t = new Date(l.ts).getTime(); if (isNaN(t)) continue
      const b = arr[Math.min(Math.floor((t - tmin) / range * BUCKETS), BUCKETS - 1)]!
      if (l.level === 'ERROR') b.E++; else if (l.level === 'WARN') b.W++; else b.I++
    }
    return arr
  }, [liveLogs])

  // Service RED metrics (Rate / Errors / Duration) derived from Jaeger traces
  const serviceRed = useMemo(() => {
    const map = new Map<string, { total: number; errors: number; durs: number[] }>()
    for (const t of tracesData.traces) {
      if (!map.has(t.rootService)) map.set(t.rootService, { total: 0, errors: 0, durs: [] })
      const s = map.get(t.rootService)!
      s.total++; if (t.status === 'error') s.errors++; s.durs.push(t.totalDuration)
    }
    return [...map.entries()].map(([svc, s]) => {
      const d = [...s.durs].sort((a, b) => a - b)
      const p = (pct: number) => d[Math.floor(d.length * pct)] ?? 0
      return { svc, total: s.total, errorPct: s.total ? s.errors / s.total * 100 : 0, p50: p(0.5), p95: p(0.95), p99: p(0.99) }
    }).sort((a, b) => b.total - a.total)
  }, [tracesData.traces])

  // SLO tracking — computed from serviceMetrics (Availability / Error Rate / Latency)
  const sloData = useMemo(() => {
    const AVAIL_TARGET = 99.9   // %
    const ERR_TARGET   = 1.0    // %
    const LAT_TARGET   = 500    // ms p99
    return serviceMetrics
      .filter(s => s.requestRate > 0 || s.availability > 0)
      .map(s => {
        const availErr = 100 - s.availability
        const availBudget = 100 - AVAIL_TARGET
        const availPct = availBudget > 0 ? Math.min(100, Math.max(0, (availBudget - availErr) / availBudget * 100)) : (s.availability >= AVAIL_TARGET ? 100 : 0)
        const errPct   = Math.min(100, Math.max(0, (ERR_TARGET - s.errorRate) / ERR_TARGET * 100))
        const latPct   = s.p99Latency > 0 ? Math.min(100, Math.max(0, (1 - s.p99Latency / LAT_TARGET) * 100)) : 100
        const overall  = Math.min(availPct, errPct, latPct)
        // Burn rate: how many × faster than normal is the budget burning?
        // Normal = consuming the budget evenly over 30 days → budget/30d
        // If availability is 99.1% vs target 99.9%, error budget consumed = 0.8% vs allowed 0.1% → burn = 8×
        const burnRate = availBudget > 0 && availErr > 0
          ? parseFloat((availErr / availBudget).toFixed(1))
          : 0
        return {
          name: s.name,
          availability: { target: AVAIL_TARGET, current: s.availability, pct: availPct },
          errorRate:    { target: ERR_TARGET,   current: s.errorRate,    pct: errPct   },
          latency:      { target: LAT_TARGET,   current: s.p99Latency,   pct: latPct   },
          overall,
          burnRate,
          status: overall > 50 ? 'ok' as const : overall > 0 ? 'warning' as const : 'blown' as const,
        }
      })
      .sort((a, b) => a.overall - b.overall)
  }, [serviceMetrics])

  // Metric window → Jaeger lookback mapping
  const jumpToTraces = useCallback(() => {
    setTraceLookback(timeRange)
    setActiveTab('Traces')
  }, [timeRange])

  // Trace ID regex — 32-char lowercase hex (OTel / Jaeger format)
  const renderLogWithTraceIds = useCallback((msg: string) => {
    const re = /([0-9a-f]{32})/g
    const nodes: React.ReactNode[] = []
    let last = 0; let m: RegExpExecArray | null
    while ((m = re.exec(msg)) !== null) {
      if (m.index > last) nodes.push(msg.slice(last, m.index))
      const id = m[1]!
      nodes.push(
        <button key={m.index} onClick={() => { setTraceLookback('1h'); setTraceSearch(id); setActiveTab('Traces') }}
          className="text-brand-400 hover:text-brand-300 font-mono underline underline-offset-2 decoration-dotted" title={`Trace ID: ${id} — click to view in Traces`}>
          {id}
        </button>
      )
      last = m.index + id.length
    }
    if (last < msg.length) nodes.push(msg.slice(last))
    return nodes.length > 1 ? nodes : msg
  }, [])

  // Events timeline — 12 × 30-min buckets = last 6 h (Datadog-style event histogram)
  const evtTimeline = useMemo(() => {
    const BUCKETS = 12, MS = 30 * 60_000, now = Date.now()
    const arr = Array.from({ length: BUCKETS }, () => ({ n: 0, w: 0 }))
    for (const ev of eventsData.events as any[]) {
      const b = Math.floor((now - new Date((ev as any).lastTime).getTime()) / MS)
      if (b >= 0 && b < BUCKETS) {
        const bucket = arr[b]!
        if ((ev as any).type === 'Warning') bucket.w += (ev as any).count ?? 1
        else bucket.n += (ev as any).count ?? 1
      }
    }
    return arr.reverse()
  }, [eventsData.events])

  // K8s connection status — derived booleans used for inline banners
  const k8sLoading = eventsLoading || podsLoading
  const k8sLive    = eventsLive    || podsLive
  const k8sError   = eventsError   ?? podsError

  // ── Event action handlers ─────────────────────────────────────────────────
  const handleAddSuppressionRule = useCallback(() => {
    if (!newSupRule.reason.trim()) return
    const rule = { id: Math.random().toString(36).slice(2), ...newSupRule, expiresAt: Date.now() + newSupRule.durationMin * 60000 }
    const updated = [...suppressionRules, rule]
    setSuppressionRules(updated)
    if (typeof window !== 'undefined') localStorage.setItem('vynops-event-suppressions', JSON.stringify(updated))
    setNewSupRule({ reason: '', namespace: 'all', durationMin: 60 })
  }, [newSupRule, suppressionRules])

  const handleRemoveSuppressionRule = useCallback((id: string) => {
    const updated = suppressionRules.filter(r => r.id !== id)
    setSuppressionRules(updated)
    if (typeof window !== 'undefined') localStorage.setItem('vynops-event-suppressions', JSON.stringify(updated))
  }, [suppressionRules])

  const handleSaveWebhook = useCallback(() => {
    setWebhookUrl(webhookInput)
    if (typeof window !== 'undefined') localStorage.setItem('vynops-webhook-url', webhookInput)
    setShowWebhookModal(false)
  }, [webhookInput])

  const handleTriggerWebhook = useCallback(async (evt: any) => {
    if (!webhookUrl) return
    fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: evt.reason, message: evt.message, namespace: evt.involvedObject?.namespace ?? evt.namespace, count: evt.count, lastTime: evt.lastTime, source: evt.sourceComponent }),
    }).catch(() => null)
  }, [webhookUrl])

  const handleAddAutoEscRule = useCallback(() => {
    if (!newEscRule.reason.trim()) return
    const updated = [...autoEscRules, { ...newEscRule }]
    setAutoEscRules(updated)
    if (typeof window !== 'undefined') localStorage.setItem('vynops-auto-esc', JSON.stringify(updated))
    setNewEscRule({ reason: '', minCount: 5, severity: 'high' })
  }, [newEscRule, autoEscRules])

  const handleCreateIncidentFromEvent = useCallback(async () => {
    if (!evtCreateModal || !evtCreateForm.title.trim()) return
    try {
      const r = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:       evtCreateForm.title.trim(),
          severity:    evtCreateForm.severity,
          description: evtCreateModal.message,
          owner:       evtCreateForm.owner,
          service:     evtCreateModal.namespace || 'unknown',
          environment: 'production',
          labels:      { namespace: evtCreateModal.namespace, reason: evtCreateModal.reason },
        }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Failed to create incident')
      setEvtCreateSuccess(data.id ?? data.incident?.id ?? 'created')
    } catch (e: any) {
      setEvtCreateSuccess('error:' + (e.message ?? 'Unknown error'))
    }
    setTimeout(() => {
      setEvtCreateModal(null)
      setEvtCreateSuccess(null)
      setEvtCreateForm({ title: '', severity: 'high', owner: 'on-call@vynops.io' })
    }, 1800)
  }, [evtCreateModal, evtCreateForm])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-brand-400" />
            Observability
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">Unified metrics, logs, traces &amp; events</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search services, metrics..."
              className="w-52 bg-surface-800 border border-surface-700 rounded-xl pl-8 pr-3 py-1.5 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500"
            />
          </div>
          <div className="relative">
            <button
              onClick={() => setFilterOpen(o => !o)}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 border rounded-xl text-sm transition-all',
                filterStatus !== 'all'
                  ? 'bg-brand-500/10 border-brand-500/30 text-brand-400'
                  : 'bg-surface-800 hover:bg-surface-700 border-surface-700 text-surface-300')}>
              <Filter className="w-3.5 h-3.5" />
              Filter{filterStatus !== 'all' ? `: ${filterStatus}` : ''}
            </button>
            {filterOpen && (
              <div className="absolute top-full mt-1 right-0 bg-surface-900 border border-surface-700 rounded-xl p-1 shadow-xl z-50 min-w-[140px]">
                {['all','healthy','degraded','critical'].map(s => (
                  <button key={s} onClick={() => { setFilterStatus(s); setFilterOpen(false) }}
                    className={cn('w-full text-left px-3 py-1.5 rounded-lg text-sm capitalize transition-colors',
                      filterStatus === s ? 'bg-brand-500/20 text-brand-400' : 'text-surface-300 hover:bg-surface-800')}>
                    {s === 'all' ? 'All statuses' : s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => {
              switch (activeTab) {
                case 'Metrics': refreshMetrics(); break
                case 'Events':  refreshEvents();  break
                default: break
              }
            }}
            className="w-8 h-8 flex items-center justify-center bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-surface-400 hover:text-white transition-all">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-3 sm:px-6 pt-2 sm:pt-3 border-b border-surface-800 overflow-x-auto scrollbar-none flex-shrink-0">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); router.replace(`?tab=${encodeURIComponent(tab)}`, { scroll: false }) }}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-all',
              activeTab === tab
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent text-surface-400 hover:text-surface-300',
            )}
          >
            {tab === 'Metrics' && <BarChart3 className="w-3.5 h-3.5" />}
            {tab === 'Logs' && <FileText className="w-3.5 h-3.5" />}
            {tab === 'Traces' && <GitBranch className="w-3.5 h-3.5" />}
            {tab === 'Events' && <Activity className="w-3.5 h-3.5" />}
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-6">
        {activeTab === 'Metrics' && (
          <>
            {/* Time window controlled by header selector */}
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-surface-500" />
              <span className="text-xs text-surface-500">Window: <span className="text-brand-400 font-medium" suppressHydrationWarning>{timeRange}</span> (set in header)</span>
              <button onClick={jumpToTraces}
                className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg bg-surface-800 hover:bg-surface-700 border border-surface-700 text-surface-400 hover:text-white transition-all">
                <GitBranch className="w-3 h-3" />
                View Traces for this window
                <ExternalLink className="w-3 h-3 opacity-60" />
              </button>
            </div>

            {/* Overview charts — 2 large + 4 small */}

            {/* CPU + Memory full-width */}
            <div className="grid lg:grid-cols-2 gap-4">
              {[
                { label: 'CPU Usage',    metricKey: 'cpu',    data: clusterMetrics.history.cpu,    unit: '%', color: '#06b6d4', current: clusterMetrics.cpuUsage,    Icon: Cpu },
                { label: 'Memory Usage', metricKey: 'memory', data: clusterMetrics.history.memory, unit: '%', color: '#8b5cf6', current: clusterMetrics.memoryUsage, Icon: MemoryStick },
              ].map(m => {
                const isCrit = m.current >= 95
                const isWarn = !isCrit && m.current >= 80
                return (
                  <div key={m.label} className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <m.Icon className="w-4 h-4 text-brand-400" />
                        <span className="text-sm font-semibold text-white">{m.label}</span>
                        <span className={cn('text-xl font-bold tabular-nums ml-1',
                          isCrit ? 'text-danger' : isWarn ? 'text-warning' : 'text-success')}>
                          {m.current > 0 ? `${m.current.toFixed(1)}${m.unit}` : '\u2014'}
                        </span>
                      </div>
                      <button
                        onClick={() => { setMetricPopup({ label: m.label, metricKey: m.metricKey, data: m.data, unit: m.unit, color: m.color, current: m.current, warn: 80, crit: 95 }); setPopupDrill(null); setPopupSub(null) }}
                        className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 transition-colors"
                        title="Expand chart"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {m.data.length > 0
                      ? <MetricChart
                          data={m.data} label="" unit={m.unit} height={200}
                          color={m.color} threshold={80}
                          status={isCrit ? 'critical' : isWarn ? 'degraded' : 'healthy'}
                          onPointClick={(ts, value) => openDrill(m.metricKey, m.label, ts, value)}
                        />
                      : <div className="h-[200px] flex items-center justify-center text-surface-600 text-sm gap-2">
                          <RefreshCw className="w-4 h-4 opacity-30" /> No history yet
                        </div>
                    }
                    <div className="flex items-center justify-between mt-2 text-2xs text-surface-600">
                      <span suppressHydrationWarning>{timeRange} ago</span>
                      <span className="text-surface-700">{'\u00B7 \u00B7 \u00B7 80% threshold \u00B7 \u00B7 \u00B7'}</span>
                      <span>now</span>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 4 small sparklines */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Request Rate', metricKey: 'requests', data: clusterMetrics.history.requests, unit: ' rps', color: '#22c55e', current: clusterMetrics.requestRate,  warn: -1, crit: -1 },
                { label: 'Error Rate',   metricKey: 'errors',   data: clusterMetrics.history.errors,   unit: '%',    color: '#ef4444', current: clusterMetrics.errorRate,    warn: 1,  crit: 5  },
                { label: 'p50 Latency',  metricKey: 'latency',  data: clusterMetrics.history.latency,  unit: 'ms',   color: '#14b8a6', current: clusterMetrics.p50Latency ?? 0, warn: 200, crit: 500 },
                { label: 'p99 Latency',  metricKey: 'latency',  data: clusterMetrics.history.latency,  unit: 'ms',   color: '#f97316', current: clusterMetrics.p99Latency,   warn: 500, crit: 2000 },
              ].map(m => {
                const isCrit = m.crit > 0 && m.current >= m.crit
                const isWarn = m.warn > 0 && !isCrit && m.current >= m.warn
                const isActive = drill?.metric === m.metricKey && drill?.label === m.label
                return (
                  <div key={m.label}
                    className={cn('rounded-2xl bg-surface-900 border p-3 group/card relative cursor-pointer hover:border-brand-500/50 hover:bg-surface-800 transition-colors',
                      isActive ? 'border-brand-500/60 ring-1 ring-brand-500/20' :
                      isCrit ? 'border-danger/40' : isWarn ? 'border-warning/40' : 'border-surface-800'
                    )}
                    onClick={() => m.data.length > 0 && openDrill(m.metricKey, m.label, 0, m.current)}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); setMetricPopup({ ...m }); setPopupDrill(null); setPopupSub(null) }}
                      className="absolute top-2 right-2 opacity-0 group-hover/card:opacity-100 transition-opacity w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-white"
                      title="Expand"
                    >
                      <Maximize2 className="w-3 h-3" />
                    </button>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-surface-400 truncate pr-1">{m.label}</span>
                      {isCrit && <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse flex-shrink-0" />}
                      {isWarn && !isCrit && <span className="w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0" />}
                    </div>
                    <p className={cn('text-sm font-bold tabular-nums mb-2', isCrit ? 'text-danger' : isWarn ? 'text-warning' : 'text-white')}>
                      {m.current > 0 ? `${m.current.toFixed(m.unit === ' rps' ? 2 : 1)}${m.unit}` : '\u2014'}
                    </p>
                    {m.data.length > 0 && (
                      <Sparkline data={m.data} height={52} color={m.color} />
                    )}
                  </div>
                )
              })}
            </div>

            {/* Drill-down panel */}
            {drill && (
              <div className="rounded-2xl bg-surface-900 border border-brand-500/30 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-brand-400" />
                    <span className="text-sm font-semibold text-white">
                      {drill.label} breakdown
                    </span>
                    <span className="text-2xs text-surface-500">
                      at {format(new Date(drill.ts * 1000), 'HH:mm:ss')} — value: {drill.value.toFixed(2)}
                    </span>
                    {drill.loading && <Loader2 className="w-3 h-3 text-brand-400 animate-spin" />}
                  </div>
                  <button onClick={() => setDrill(null)} className="text-surface-500 hover:text-white transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="px-4 py-3">
                  {!drill.loading && drill.rows !== null && drill.rows.length === 0 && (
                    <p className="text-surface-500 text-sm py-4">No contributors found at this timestamp. Prometheus may not have per-pod data scraped yet.</p>
                  )}
                  {drill.rows !== null && drill.rows.length > 0 && (() => {
                    const max = drill.rows[0].value
                    return (
                      <div className="space-y-1" style={{ opacity: drill.loading ? 0.4 : 1, transition: 'opacity 0.15s ease' }}>
                        {drill.rows.map((row) => {
                          const isExpanded = sub?.rowName === row.name
                          const subMax = sub?.rows?.[0]?.value ?? 1
                          // Detect if this is a ns/pod row → build k8s link
                          const isPodRow   = (drill.metric === 'cpu' || drill.metric === 'memory') && row.name.includes('/')
                          const podName    = isPodRow ? row.name.split('/')[1] : ''
                          const nsName     = isPodRow ? row.name.split('/')[0] : (row.meta?.namespace ?? '')
                          const k8sHref    = isPodRow
                            ? `/kubernetes?tab=Pods&pod=${encodeURIComponent(podName)}`
                            : null
                          return (
                            <div key={row.name}>
                              {/* Level-1 row */}
                              <div
                                className={cn('flex items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer transition-colors',
                                  isExpanded ? 'bg-surface-800/60' : 'hover:bg-surface-800/40')}
                                onClick={() => toggleSub(row)}
                              >
                                <ChevronRight className={cn('w-3 h-3 text-surface-500 flex-shrink-0 transition-transform', isExpanded && 'rotate-90')} />
                                <span className="text-xs font-mono text-surface-300 w-52 truncate flex-shrink-0" title={row.name}>{row.name}</span>
                                <div className="flex-1 h-3 bg-surface-800 rounded-full overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-brand-500/70"
                                    style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%`, transition: 'width 0.4s ease' }}
                                  />
                                </div>
                                <span className="text-xs font-mono tabular-nums text-white w-20 text-right flex-shrink-0">
                                  {row.value.toFixed(2)} {row.unit}
                                </span>
                                {/* Action buttons */}
                                <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                                  {/* Logs: pre-fill Loki query with pod/namespace */}
                                  {isPodRow && (
                                    <button
                                      title="View logs around this spike"
                                      onClick={() => {
                                        const podBase = podName.split('-').slice(0,-2).join('-') || podName
                                        setLokiQuery(`{namespace="${nsName}"} |= "${podBase}"`)
                                        setLokiStart(drill.ts - 15 * 60)
                                        setLokiEnd(Math.min(drill.ts + 15 * 60, Math.floor(Date.now() / 1000)))
                                        pendingLokiFetch.current = true
                                        setActiveTab('Logs')
                                      }}
                                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-amber-400 transition-colors"
                                    >
                                      <ScrollText className="w-3 h-3" />
                                    </button>
                                  )}
                                  {/* Traces: pre-fill service filter */}
                                  {!isPodRow && (
                                    <button
                                      title="View traces for this service"
                                      onClick={() => {
                                        const svcName = row.meta?.service ?? row.name
                                        setTraceService(svcName)
                                        setTraceLookback('1h')
                                        setActiveTab('Traces')
                                      }}
                                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-cyan-400 transition-colors"
                                    >
                                      <GitBranch className="w-3 h-3" />
                                    </button>
                                  )}
                                  {/* K8s pod link */}
                                  {k8sHref && (
                                    <Link href={k8sHref} onClick={e => e.stopPropagation()}
                                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-brand-400 transition-colors" title="Open pod in Kubernetes">
                                      <ExternalLink className="w-3 h-3" />
                                    </Link>
                                  )}
                                </div>
                              </div>
                              {/* Level-2 accordion */}
                              {isExpanded && (
                                <div className="ml-6 mt-1 mb-2 pl-3 border-l border-surface-700 space-y-1">
                                  {sub.loading && (
                                    <div className="flex items-center gap-2 text-2xs text-surface-500 py-1">
                                      <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                                    </div>
                                  )}
                                  {!sub.loading && sub.rows !== null && sub.rows.length === 0 && (
                                    <p className="text-2xs text-surface-500 py-1">No sub-breakdown available</p>
                                  )}
                                  {!sub.loading && sub.rows !== null && sub.rows.length > 0 && sub.rows.map(sr => (
                                    <div key={sr.name} className="flex items-center gap-3">
                                      <span className="text-2xs font-mono text-surface-400 w-44 truncate flex-shrink-0" title={sr.name}>{sr.name}</span>
                                      <div className="flex-1 h-2 bg-surface-800 rounded-full overflow-hidden">
                                        <div
                                          className="h-full rounded-full bg-cyan-500/60"
                                          style={{ width: `${subMax > 0 ? (sr.value / subMax) * 100 : 0}%`, transition: 'width 0.4s ease' }}
                                        />
                                      </div>
                                      <span className="text-2xs font-mono tabular-nums text-surface-300 w-20 text-right flex-shrink-0">
                                        {sr.value.toFixed(2)} {sr.unit}
                                      </span>
                                      {isPodRow && (
                                        <Link href={`/kubernetes?tab=Pods&pod=${encodeURIComponent(podName)}`}
                                          className="flex-shrink-0 text-surface-600 hover:text-cyan-400 transition-colors" title="Open pod in Kubernetes">
                                          <ExternalLink className="w-3 h-3" />
                                        </Link>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>
              </div>
            )}

            {/* Service metrics table */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-3">
                <span className="text-sm font-semibold text-white">Service Health</span>
                <span className="text-2xs text-surface-500">{serviceMetrics.filter(s => s.status !== 'healthy').length} degraded</span>
                <div className="ml-auto relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-500" />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter services…"
                    className="w-44 bg-surface-800 border border-surface-700 rounded-lg pl-7 pr-3 py-1 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500" />
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-800">
                    {([
                      { key: 'name',         label: 'Service' },
                      { key: 'ns',           label: 'NS' },
                      { key: 'status',       label: 'Status' },
                      { key: 'requestRate',  label: 'Req/s' },
                      { key: 'errorRate',    label: 'Error %' },
                      { key: 'p50',          label: 'p50' },
                      { key: 'p99',          label: 'p99' },
                      { key: 'apdex',        label: 'Apdex', title: 'Apdex score (0–1): satisfied <300ms, tolerated <1.2s' },
                      { key: 'pods',         label: 'Pods' },
                      { key: 'availability', label: 'Avail %' },
                      { key: 'trend',        label: 'Trend (err%)' },
                    ] as const).map(h => (
                      <th key={h.key}
                        title={(h as any).title}
                        onClick={() => !['ns','status','pods'].includes(h.key) ? sortBy(h.key) : undefined}
                        className={cn('px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider select-none',
                          !['ns','status','pods'].includes(h.key) ? 'cursor-pointer hover:text-surface-300' : ''
                        )}>
                        <span className="flex items-center gap-1">
                          {h.label}
                          {metricSort.col === h.key && (
                            metricSort.dir === 'asc'
                              ? <TrendingUp className="w-2.5 h-2.5 text-brand-400" />
                              : <TrendingDown className="w-2.5 h-2.5 text-brand-400" />
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedServices.map(svc => {
                    // Apdex: satisfied = p50 < T, tolerating = p50 < 4T, frustrated = rest
                    // T = 300ms threshold (industry standard for web services)
                    const T = 300
                    const satisfied  = svc.p50Latency > 0 && svc.p50Latency <= T       ? 1 - svc.errorRate / 100 : 0
                    const tolerating = svc.p50Latency > T && svc.p50Latency <= T * 4  ? (1 - svc.errorRate / 100) * 0.5 : 0
                    const apdex = svc.p50Latency > 0 ? Math.max(0, Math.min(1, satisfied + tolerating)) : null
                    const podCount = (podsData.pods as any[]).filter(
                      (p: any) => p.namespace === svc.namespace && p.status === 'Running'
                    ).length
                    const svcStatus = svc.status === 'critical' ? 'critical' : svc.status === 'degraded' ? 'degraded' : 'healthy'
                    return (
                      <tr key={`${svc.namespace}/${svc.name}`}
                        className="border-b border-surface-800/50 hover:bg-surface-800/40 cursor-pointer transition-colors group"
                        onClick={() => window.location.href = `/kubernetes?tab=Services&service=${encodeURIComponent(svc.name)}`}
                      >
                        <td className="px-3 py-2.5 font-medium text-white">{svc.name}</td>
                        <td className="px-3 py-2.5 text-2xs text-surface-500 font-mono">{svc.namespace}</td>
                        <td className="px-3 py-2.5">
                          <span className={cn('text-2xs px-2 py-0.5 rounded-full font-medium capitalize',
                            svc.status === 'critical' ? 'bg-danger/10 text-danger' :
                            svc.status === 'degraded' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success',
                          )}>{svc.status}</span>
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-surface-300">{svc.requestRate > 0 ? svc.requestRate.toFixed(2) : <span className="text-surface-600">—</span>}</td>
                        <td className={cn('px-3 py-2.5 tabular-nums font-medium', svc.errorRate > 1 ? 'text-danger' : 'text-surface-400')}>
                          {svc.errorRate.toFixed(2)}%
                        </td>
                        <td className={cn('px-3 py-2.5 tabular-nums text-surface-400', svc.p50Latency > 300 ? 'text-warning' : '')}>
                          {svc.p50Latency > 0 ? formatLatency(svc.p50Latency) : <span className="text-surface-600">—</span>}
                        </td>
                        <td className={cn('px-3 py-2.5 tabular-nums font-medium', svc.p99Latency > 1000 ? 'text-warning' : 'text-surface-300')}>
                          {svc.p99Latency > 0 ? formatLatency(svc.p99Latency) : <span className="text-surface-600">—</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          {apdex !== null ? (
                            <span className={cn('text-xs font-bold tabular-nums',
                              apdex >= 0.94 ? 'text-success' : apdex >= 0.85 ? 'text-brand-400' : apdex >= 0.7 ? 'text-warning' : 'text-danger'
                            )} title={apdex >= 0.94 ? 'Excellent' : apdex >= 0.85 ? 'Good' : apdex >= 0.7 ? 'Fair' : 'Poor'}>
                              {apdex.toFixed(2)}
                            </span>
                          ) : <span className="text-surface-600">—</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          {podCount > 0
                            ? <span className="text-xs tabular-nums text-surface-300 font-mono">{podCount}</span>
                            : <span className="text-surface-600">—</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <div className="w-12 h-1.5 bg-surface-800 rounded-full overflow-hidden">
                              <div
                                className={cn('h-full rounded-full transition-all', svc.availability >= 99.9 ? 'bg-success' : svc.availability >= 99 ? 'bg-warning' : 'bg-danger')}
                                style={{ width: `${Math.min(svc.availability, 100)}%` }}
                              />
                            </div>
                            <span className={cn('text-2xs tabular-nums font-mono', svc.availability >= 99.9 ? 'text-success' : 'text-warning')}>
                              {svc.availability.toFixed(2)}%
                            </span>
                          </div>
                        </td>
                        {/* Trend sparkline — error rate history */}
                        <td className="px-3 py-2.5 w-24">
                          {svc.history.length > 1 ? (
                            <div className="w-20 h-6">
                              <Sparkline
                                data={svc.history}
                                color={svcStatus === 'critical' ? '#ef4444' : svcStatus === 'degraded' ? '#f59e0b' : '#22c55e'}
                                height={24}
                              />
                            </div>
                          ) : <span className="text-surface-600 text-2xs">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Namespace Resource Usage ──────────────────────────────────── */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-3">
                <Layers className="w-4 h-4 text-brand-400" />
                <span className="text-sm font-semibold text-white">Namespace Resource Usage</span>
                {namespaceUsage.length > 0 && (
                  <span className="text-2xs text-surface-500">{namespaceUsage.length} namespaces · actual usage</span>
                )}
                {metricsLoading && <span className="text-2xs text-surface-600 ml-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />loading</span>}
                <div className="ml-auto grid grid-cols-3 gap-8 text-2xs text-surface-600 pr-4">
                  <span>CPU (cores)</span>
                  <span>Memory</span>
                  <span>Pods</span>
                </div>
              </div>

              {namespaceUsage.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <Layers className="w-7 h-7 text-surface-700 mx-auto mb-2" />
                  <p className="text-sm text-surface-500">No namespace metrics available</p>
                  <p className="text-2xs text-surface-600 mt-1">Requires Prometheus to scrape cAdvisor metrics<br /><code className="text-surface-500">container_cpu_usage_seconds_total</code></p>
                </div>
              ) : (() => {
                const maxCpu = namespaceUsage[0]?.cpuCores ?? 1
                const maxMem = Math.max(...namespaceUsage.map(n => n.memGiB), 0.001)
                return (
                  <div className="divide-y divide-surface-800/40">
                    {namespaceUsage.map(ns => {
                      const cpuPct     = maxCpu > 0 ? (ns.cpuCores / maxCpu) * 100 : 0
                      const memPct     = maxMem > 0 ? (ns.memGiB  / maxMem) * 100 : 0
                      const cpuOfTotal = clusterCpuCores > 0 ? (ns.cpuCores / clusterCpuCores) * 100 : 0
                      const cpuCol     = cpuPct >= 70 ? 'bg-danger' : cpuPct >= 40 ? 'bg-warning' : 'bg-brand-500'
                      const memCol     = memPct >= 70 ? 'bg-danger' : memPct >= 40 ? 'bg-warning' : 'bg-success'
                      const cpuLabel   = ns.cpuCores >= 1
                        ? `${ns.cpuCores.toFixed(2)}c`
                        : `${(ns.cpuCores * 1000).toFixed(0)}m`
                      const memLabel   = ns.memGiB >= 1
                        ? `${ns.memGiB.toFixed(2)} GiB`
                        : `${(ns.memGiB * 1024).toFixed(0)} MiB`
                      const nsPodCount = (podsData.pods as any[]).filter((p: any) => p.namespace === ns.namespace).length
                      const nsRunning  = (podsData.pods as any[]).filter((p: any) => p.namespace === ns.namespace && p.status === 'Running').length
                      return (
                        <Link key={ns.namespace} href={`/kubernetes?tab=Pods&ns=${encodeURIComponent(ns.namespace)}`}
                          className="block px-4 py-2.5 flex items-center gap-3 hover:bg-surface-800/40 transition-colors group">
                          {/* Namespace name */}
                          <span className="w-28 flex-shrink-0 font-mono text-xs text-brand-400 group-hover:text-brand-300 truncate transition-colors" title={ns.namespace}>
                            {ns.namespace}
                          </span>
                          {/* CPU bar */}
                          <div className="flex-1 flex items-center gap-2">
                            <div className="flex-1 h-2 bg-surface-800 rounded-full overflow-hidden">
                              <div className={cn('h-full rounded-full transition-all', cpuCol)} style={{ width: `${cpuPct}%` }} />
                            </div>
                            <span className="w-14 text-right text-2xs tabular-nums font-mono text-surface-400 flex-shrink-0">
                              {cpuLabel}
                            </span>
                            {cpuOfTotal > 0 && (
                              <span className="w-10 text-right text-2xs tabular-nums font-mono text-surface-600 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                {cpuOfTotal.toFixed(1)}%
                              </span>
                            )}
                          </div>
                          {/* Memory bar */}
                          <div className="flex-1 flex items-center gap-2">
                            <div className="flex-1 h-2 bg-surface-800 rounded-full overflow-hidden">
                              <div className={cn('h-full rounded-full transition-all', memCol)} style={{ width: `${memPct}%` }} />
                            </div>
                            <span className="w-16 text-right text-2xs tabular-nums font-mono text-surface-400 flex-shrink-0">
                              {memLabel}
                            </span>
                          </div>
                          {/* Pod count */}
                          <div className="w-16 flex-shrink-0 flex items-center gap-1 justify-end">
                            {nsPodCount > 0 ? (
                              <>
                                <span className="text-xs tabular-nums font-mono text-surface-300">{nsRunning}</span>
                                {nsPodCount !== nsRunning && <span className="text-2xs text-surface-600">/{nsPodCount}</span>}
                                <span className="text-2xs text-surface-600">pods</span>
                              </>
                            ) : <span className="text-surface-700 text-2xs">—</span>}
                          </div>
                          {/* Restart badge */}
                          {ns.restarts > 0 && (
                            <span className="text-2xs font-mono text-warning flex-shrink-0 w-10 text-right" title={`${ns.restarts} container restarts`}>
                              ↺{ns.restarts}
                            </span>
                          )}
                        </Link>
                      )
                    })}
                  </div>
                )
              })()}
            </div>

            {/* ── SLO Tracking ──────────────────────────────────────────────── */}
            {sloData.length > 0 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-3">
                  <ShieldCheck className="w-4 h-4 text-brand-400" />
                  <span className="text-sm font-semibold text-white">SLO Tracking</span>
                  <span className="text-2xs text-surface-500">{sloData.length} services · 30-day error budget</span>
                  <div className="ml-auto flex items-center gap-4 pr-2 text-2xs text-surface-600">
                    <span className="w-28 text-center">Availability<br /><span className="text-2xs opacity-60">target 99.9%</span></span>
                    <span className="w-20 text-center">Error Rate<br /><span className="text-2xs opacity-60">target &lt;1%</span></span>
                    <span className="w-20 text-center">p99 Latency<br /><span className="text-2xs opacity-60">target &lt;500ms</span></span>
                    <span className="w-24 text-center">Burn Rate</span>
                    <span className="w-20 text-center">Budget Left</span>
                  </div>
                </div>
                <div className="divide-y divide-surface-800/40">
                  {sloData.map(s => {
                    const budgetColor = s.overall > 50 ? 'bg-success' : s.overall > 0 ? 'bg-warning' : 'bg-danger'
                    const statusColor = s.status === 'ok' ? 'text-success' : s.status === 'warning' ? 'text-warning' : 'text-danger'
                    const statusLabel = s.status === 'ok' ? 'OK' : s.status === 'warning' ? 'AT RISK' : 'BLOWN'
                    return (
                      <div key={s.name} className="flex items-center gap-4 px-4 py-3 hover:bg-surface-800/40 transition-colors">
                        <div className="flex items-center gap-2 w-36 flex-shrink-0">
                          <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', s.status === 'ok' ? 'bg-success' : s.status === 'warning' ? 'bg-warning animate-pulse' : 'bg-danger animate-pulse')} />
                          <Link href={`/kubernetes?tab=Services&service=${encodeURIComponent(s.name)}`}
                            className="text-xs font-medium text-white truncate hover:text-brand-400 transition-colors" title="View in Kubernetes Services">
                            {s.name}
                          </Link>
                        </div>
                        <div className="ml-auto flex items-center gap-4">
                          {/* Availability: current vs target */}
                          <div className="w-28 text-center">
                            <span className={cn('text-xs tabular-nums font-mono', s.availability.pct > 50 ? 'text-success' : s.availability.pct > 0 ? 'text-warning' : 'text-danger')}>
                              {s.availability.current.toFixed(2)}%
                            </span>
                            {s.availability.current < s.availability.target && (
                              <span className="text-2xs text-danger font-mono ml-1">
                                −{(s.availability.target - s.availability.current).toFixed(2)}%
                              </span>
                            )}
                          </div>
                          {/* Error Rate: current vs target */}
                          <div className="w-20 text-center">
                            <span className={cn('text-xs tabular-nums font-mono', s.errorRate.pct > 50 ? 'text-success' : s.errorRate.pct > 0 ? 'text-warning' : 'text-danger')}>
                              {s.errorRate.current.toFixed(2)}%
                            </span>
                            {s.errorRate.current > s.errorRate.target && (
                              <span className="text-2xs text-danger font-mono ml-1">
                                +{(s.errorRate.current - s.errorRate.target).toFixed(2)}%
                              </span>
                            )}
                          </div>
                          {/* Latency: current vs target */}
                          <div className="w-20 text-center">
                            <span className={cn('text-xs tabular-nums font-mono', s.latency.pct > 50 ? 'text-success' : s.latency.pct > 0 ? 'text-warning' : 'text-danger')}>
                              {s.latency.current > 0 ? formatLatency(s.latency.current) : '—'}
                            </span>
                            {s.latency.current > s.latency.target && (
                              <span className="text-2xs text-danger font-mono ml-1">
                                +{formatLatency(s.latency.current - s.latency.target)}
                              </span>
                            )}
                          </div>
                          {/* Burn rate badge */}
                          <div className="w-24 flex justify-center">
                            {s.burnRate > 1 ? (
                              <span className={cn('text-2xs font-mono px-2 py-0.5 rounded-full border',
                                s.burnRate >= 10 ? 'bg-danger/15 text-danger border-danger/30' :
                                s.burnRate >= 3  ? 'bg-warning/15 text-warning border-warning/30' :
                                                   'bg-surface-700 text-surface-400 border-surface-600'
                              )} title={`Burning budget ${s.burnRate}× faster than baseline`}>
                                {s.burnRate}× burn
                              </span>
                            ) : (
                              <span className="text-2xs text-success font-mono">nominal</span>
                            )}
                          </div>
                          {/* Budget bar + % */}
                          <div className="w-20 flex items-center gap-1.5">
                            <div className="flex-1 h-1.5 bg-surface-800 rounded-full overflow-hidden">
                              <div className={cn('h-full rounded-full transition-all', budgetColor)}
                                style={{ width: `${s.overall}%` }} />
                            </div>
                            <span className={cn('text-2xs tabular-nums font-mono w-8 text-right', statusColor)}>
                              {s.overall > 0 ? `${Math.round(s.overall)}%` : statusLabel}
                            </span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'Logs' && (
          <div className="space-y-4">

            {/* ── Loki Log Search ──────────────────────────────────────── */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-2 flex-wrap">
                <FileText className="w-4 h-4 text-brand-400 flex-shrink-0" />
                <span className="text-sm font-semibold text-white">Loki Log Search</span>
                {lokiAvailable === null && <span className="text-2xs text-surface-600 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />probing…</span>}
                {lokiAvailable === true  && <span className="text-2xs px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20">Connected</span>}
                {lokiAvailable === false && <span className="text-2xs px-2 py-0.5 rounded-full bg-surface-800 text-surface-500 border border-surface-700">Unavailable</span>}
                {lokiLabels.length > 0 && <span className="text-2xs text-surface-600">{lokiLabels.length} labels</span>}
              </div>
              {lokiAvailable === false ? (
                <div className="px-4 py-5 flex items-start gap-2">
                  <Info className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-white">Loki not configured for this cluster</p>
                    <p className="text-2xs text-surface-500 mt-1">Set <code className="text-brand-400">lokiUrl</code> in cluster settings to enable log search across all pods without selecting one individually.</p>
                  </div>
                </div>
              ) : (
                <div className="p-4 space-y-3">
                  {/* Quick presets */}
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      ['{job=~".+"}',                                   'All logs'],
                      ['{job=~".+"} |= "error"',                        'Errors'],
                      ['{job=~".+"} |= "warn"',                         'Warnings'],
                      ['{namespace="monitoring"}',                       'Monitoring ns'],
                      ['{namespace="default"} | json | level="error"',  'Default errors'],
                    ].map(([q, label]) => (
                      <button key={label} onClick={() => { setLokiQuery(q as string); setLokiStart(null); setLokiEnd(null) }}
                        className={cn('text-2xs px-2.5 py-1 rounded-lg border transition-all',
                          lokiQuery === q ? 'bg-brand-500/20 text-brand-400 border-brand-500/30' : 'bg-surface-800 text-surface-500 border-surface-700 hover:text-surface-300'
                        )}>{label}</button>
                    ))}
                  </div>
                  {/* Query bar */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="relative flex-1 min-w-[300px]">
                      <input
                        value={lokiQuery} onChange={e => setLokiQuery(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && fetchLokiLogs()}
                        placeholder='LogQL: {namespace="default"} |= "error"'
                        className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-xs text-white font-mono placeholder-surface-600 outline-none focus:border-brand-500"
                      />
                    </div>
                    <select value={lokiSince} onChange={e => { setLokiSince(e.target.value); setLokiStart(null); setLokiEnd(null) }}
                      className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-brand-500 flex-shrink-0">
                      {[['15','15m'],['30','30m'],['60','1h'],['180','3h'],['360','6h'],['1440','24h']].map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                    <button onClick={fetchLokiLogs} disabled={!lokiQuery.trim() || lokiLoading}
                      className="flex items-center gap-1.5 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-xl text-xs font-medium text-white transition-all flex-shrink-0">
                      {lokiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                      Search
                    </button>
                    {lokiLogs.length > 0 && (
                      <button onClick={() => setLokiLogs([])} className="text-2xs text-surface-500 hover:text-surface-300 px-2 py-1 rounded border border-surface-700 transition-all">Clear</button>
                    )}
                  </div>
                  {lokiError && <p className="text-xs text-danger font-mono">{lokiError}</p>}
                  {/* Spike context banner */}
                  {lokiStart !== null && lokiEnd !== null && (
                    <div className="flex items-center gap-2 text-2xs bg-amber-400/5 border border-amber-400/20 rounded-lg px-3 py-2">
                      <Zap className="w-3 h-3 text-amber-400 flex-shrink-0" />
                      <span className="text-amber-400/80">Spike context: {format(new Date(lokiStart * 1000), 'HH:mm:ss')} – {format(new Date(lokiEnd * 1000), 'HH:mm:ss')}</span>
                      <button onClick={() => { setLokiStart(null); setLokiEnd(null) }} className="ml-auto text-surface-500 hover:text-white transition-colors" title="Clear spike context">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                  {/* Loki results */}
                  {lokiLogs.length > 0 && (
                    <div className="rounded-xl bg-surface-950 border border-surface-800 overflow-hidden">
                      <div className="px-4 py-2 border-b border-surface-800 flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-white">{lokiLogs.length} log lines</span>
                        {(['all','ERROR','WARN','INFO','DEBUG'] as const).map(lvl => {
                          const n = lvl === 'all' ? lokiLogs.length : lokiLogs.filter(l => l.level === lvl).length
                          return (
                            <button key={lvl} onClick={() => setLokiSearch(lvl === 'all' ? '' : lvl)}
                              className={cn('text-2xs px-1.5 py-0.5 rounded transition-all font-semibold',
                                lokiSearch === (lvl === 'all' ? '' : lvl) ? 'bg-surface-700 text-white' : 'text-surface-600 hover:text-surface-400',
                                lvl === 'ERROR' ? 'hover:text-danger' : lvl === 'WARN' ? 'hover:text-warning' : '',
                              )}>{lvl === 'all' ? 'All' : lvl} {n}</button>
                          )
                        })}
                        <div className="ml-auto relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-500" />
                          <input value={lokiSearch} onChange={e => setLokiSearch(e.target.value)} placeholder="Filter…"
                            className="w-32 bg-surface-800 border border-surface-700 rounded-lg pl-6 pr-2 py-0.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500" />
                        </div>
                      </div>
                      <div className="font-mono text-xs max-h-80 overflow-y-auto">
                        {lokiLogs
                          .filter(l => !lokiSearch || l.msg.toLowerCase().includes(lokiSearch.toLowerCase()) || l.level.includes(lokiSearch.toUpperCase()))
                          .map(line => (
                          <div key={line.id} className={cn('flex items-start gap-3 px-4 py-1 border-b border-surface-800/20 group',
                            line.level === 'ERROR' ? 'bg-danger/5' : line.level === 'WARN' ? 'bg-warning/5' : '')}>
                            <span className="text-surface-600 flex-shrink-0 text-2xs w-44">{format(new Date(line.ts), 'HH:mm:ss')}</span>
                            <span className={cn('flex-shrink-0 font-bold w-10 text-2xs',
                              line.level === 'ERROR' ? 'text-danger' : line.level === 'WARN' ? 'text-warning' : line.level === 'DEBUG' ? 'text-surface-600' : 'text-brand-400'
                            )}>{line.level}</span>
                            <span className="text-surface-300 flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">{line.msg}</span>
                            <button onClick={() => navigator.clipboard.writeText(line.msg)}
                              className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 rounded text-surface-600 hover:text-surface-300 transition-opacity" title="Copy">
                              <Copy className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {lokiLogs.length === 0 && !lokiLoading && lokiAvailable && (
                    lokiQueried
                      ? <p className="text-xs text-surface-500 text-center py-4">
                          No logs found {lokiStart !== null && lokiEnd !== null
                            ? <>between <code className="text-surface-400">{format(new Date(lokiStart * 1000), 'HH:mm:ss')}</code> and <code className="text-surface-400">{format(new Date(lokiEnd * 1000), 'HH:mm:ss')}</code></>
                            : <>in the last {Number(lokiSince) >= 1440 ? `${Number(lokiSince)/1440}d` : Number(lokiSince) >= 60 ? `${Number(lokiSince)/60}h` : `${lokiSince}m`}</>
                          }{' '}for <code className="text-surface-400">{lokiQuery}</code>.
                          {' '}Try a broader window, a simpler query, or check that Loki is scraping this namespace.
                        </p>
                      : <p className="text-xs text-surface-600 text-center py-2">Enter a LogQL query and press Search or Enter</p>
                  )}
                </div>
              )}
            </div>

            {/* ── Pod Log Viewer (existing) ─────────────────────────────── */}
            {/* K8s API connection status */}
            {podsLoading && (
              <div className="rounded-xl bg-surface-800/50 border border-surface-700/50 p-3 flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-brand-400 animate-spin flex-shrink-0" />
                <span className="text-xs text-surface-400">Loading pods from Kubernetes API…</span>
              </div>
            )}
            {!podsLive && !podsLoading && (
              <div className="rounded-xl bg-warning/5 border border-warning/20 p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white">Kubernetes API not reachable</p>
                  <p className="text-2xs text-surface-400 mt-0.5"><code className="text-brand-400">{activeCluster?.k8sUrl ?? 'K8S_API_URL'}</code> &mdash; kubectl proxy must be running on the server.</p>
                  {podsError && <p className="text-2xs text-danger/80 mt-1 font-mono truncate">{podsError}</p>}
                  <p className="text-2xs text-surface-500 mt-1">Fix: <code className="text-surface-300">kubectl proxy --address=0.0.0.0 --port=8001 &amp;</code></p>
                </div>
              </div>
            )}
            {/* Pod picker */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
              <div className="flex items-center gap-2 mb-3">
                <Terminal className="w-4 h-4 text-brand-400" />
                <span className="text-sm font-semibold text-white">Live Pod Log Viewer</span>
                {isLiveFeed && <span className="text-2xs px-2 py-0.5 bg-success/10 text-success border border-success/20 rounded-full flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />Live</span>}
                {isLiveFeed && (
                  <>
                    <button onClick={() => setAutoRefresh(r => !r)}
                      className={cn('ml-2 text-2xs px-2 py-0.5 rounded-full border transition-all flex items-center gap-1',
                        autoRefresh ? 'bg-brand-500/10 text-brand-400 border-brand-500/30' : 'text-surface-500 border-surface-700'
                      )}>
                      <Zap className="w-2.5 h-2.5" />{autoRefresh ? `Auto-refresh (${autoRefreshInterval}s)` : 'Auto-refresh'}
                    </button>
                    {autoRefresh && (
                      <select value={autoRefreshInterval} onChange={e => setAutoRefreshInterval(Number(e.target.value))}
                        className="text-2xs bg-surface-800 border border-surface-700 rounded-lg px-1.5 py-0.5 text-surface-400 outline-none">
                        {[5,10,30,60].map(s => <option key={s} value={s}>{s}s</option>)}
                      </select>
                    )}
                    <button onClick={() => setLogTail(t => !t)}
                      className={cn('text-2xs px-2 py-0.5 rounded-full border transition-all',
                        logTail ? 'bg-brand-500/10 text-brand-400 border-brand-500/30' : 'text-surface-500 border-surface-700'
                      )}>Tail</button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex flex-col gap-1">
                  <label className="text-2xs text-surface-500 uppercase tracking-wider">Namespace</label>
                  <select value={logNs} onChange={e => { setLogNs(e.target.value); setLogPod(''); setLiveLogs([]); setIsLiveFeed(false); setAutoRefresh(false) }}
                    className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-sm text-white outline-none focus:border-brand-500 min-w-[160px]">
                    <option value="">Select namespace…</option>
                    {podNamespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-2xs text-surface-500 uppercase tracking-wider">Pod</label>
                  <select value={logPod} onChange={e => { setLogPod(e.target.value); setLogContainer(''); setLiveLogs([]); setIsLiveFeed(false); setAutoRefresh(false) }}
                    disabled={!logNs} className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-sm text-white outline-none focus:border-brand-500 min-w-[240px] disabled:opacity-50">
                    <option value="">Select pod…</option>
                    {podsInNs.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                {containersInPod.length > 1 && (
                  <div className="flex flex-col gap-1">
                    <label className="text-2xs text-surface-500 uppercase tracking-wider">Container</label>
                    <select value={logContainer} onChange={e => { setLogContainer(e.target.value); setLiveLogs([]); setIsLiveFeed(false) }}
                      className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-sm text-white outline-none focus:border-brand-500 min-w-[180px]">
                      <option value="">All containers</option>
                      {containersInPod.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <label className="text-2xs text-surface-500 uppercase tracking-wider">Lines</label>
                  <select value={logTailLines} onChange={e => setLogTailLines(Number(e.target.value))}
                    className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-sm text-white outline-none focus:border-brand-500">
                    {[100, 300, 500, 1000].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1 justify-end mt-auto">
                  <button onClick={fetchPodLogs} disabled={!logNs || !logPod || logLoading}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-xl text-sm font-medium text-white transition-all">
                    {logLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Fetch Logs
                  </button>
                </div>
                {logError && <p className="text-xs text-danger mt-1 w-full">{logError}</p>}
              </div>
            </div>

            {/* Live log output */}
            {liveLogs.length > 0 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-surface-800 flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-white font-mono">{logPod}</span>
                  {logContainer && <span className="text-2xs bg-brand-500/10 text-brand-300 px-1.5 py-0.5 rounded font-mono border border-brand-500/20">{logContainer}</span>}
                  <span className="text-2xs text-surface-500">in {logNs}</span>
                  {/* Level filter quick buttons */}
                  <div className="ml-2 flex items-center gap-0.5">
                    {(['all','ERROR','WARN','INFO','DEBUG'] as const).map(lvl => {
                      const n = lvl === 'all' ? liveLogs.length : liveLogs.filter(l => l.level === lvl).length
                      return (
                        <button key={lvl} onClick={() => setLogLevelFilter(lvl)}
                          className={cn('text-2xs px-2 py-0.5 rounded font-semibold transition-all',
                            logLevelFilter === lvl ? 'bg-surface-700 text-white' : 'text-surface-600 hover:text-surface-400',
                            lvl === 'ERROR' ? 'hover:text-danger' : lvl === 'WARN' ? 'hover:text-warning' : ''
                          )}>{lvl === 'all' ? 'All' : lvl}<span className="ml-0.5 opacity-60">{n}</span></button>
                      )
                    })}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-500" />
                      <input value={logSearch} onChange={e => setLogSearch(e.target.value)} placeholder="Search…"
                        className="w-36 bg-surface-800 border border-surface-700 rounded-lg pl-6 pr-2 py-0.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500" />
                    </div>
                    <span className="text-2xs text-surface-500">{liveLogs.length} lines</span>
                    <button onClick={() => setLogWrap(w => !w)} title="Toggle line wrap"
                      className={cn('text-2xs px-2 py-0.5 rounded border transition-all',
                        logWrap ? 'bg-brand-500/10 text-brand-400 border-brand-500/30' : 'text-surface-500 border-surface-700 hover:text-surface-300'
                      )}>Wrap</button>
                    <button onClick={downloadLogs} title="Download logs as .log file"
                      className="p-1 rounded border border-surface-700 text-surface-500 hover:text-white hover:border-surface-500 transition-all">
                      <Download className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className="font-mono text-xs bg-surface-950 max-h-[480px] overflow-y-auto">
                  {liveLogs
                    .filter(l => {
                      const levelOk  = logLevelFilter === 'all' || l.level === logLevelFilter
                      const searchOk = !logSearch || l.msg.toLowerCase().includes(logSearch.toLowerCase()) || l.level.includes(logSearch.toUpperCase())
                      return levelOk && searchOk
                    })
                    .map((line) => (
                    <div key={line.id} className={cn('group flex items-start gap-3 px-4 py-1 border-b border-surface-800/20',
                      line.level === 'ERROR' ? 'bg-danger/5' : line.level === 'WARN' ? 'bg-warning/5' : '')}>
                      <span className="text-surface-600 flex-shrink-0 text-2xs w-44">{new Date(line.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as any)}</span>
                      <span className={cn('flex-shrink-0 font-bold w-10 text-2xs',
                        line.level === 'ERROR' ? 'text-danger' : line.level === 'WARN' ? 'text-warning' : line.level === 'DEBUG' ? 'text-surface-600' : 'text-brand-400'
                      )}>{line.level}</span>
                      <span className={cn('text-surface-300 flex-1 min-w-0', logWrap ? 'break-all whitespace-pre-wrap' : 'whitespace-nowrap overflow-hidden text-ellipsis')}>{renderLogWithTraceIds(line.msg)}</span>
                      <button onClick={() => navigator.clipboard.writeText(line.msg)}
                        className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 rounded text-surface-600 hover:text-surface-300 transition-opacity" title="Copy line">
                        <Copy className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}

            {/* Empty state when no pod selected */}
            {liveLogs.length === 0 && !logLoading && podsLive && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 p-12 flex flex-col items-center gap-3">
                <Terminal className="w-8 h-8 text-surface-700" />
                <p className="text-sm text-surface-500">Select a namespace and pod above, then click <strong className="text-surface-400">Fetch Logs</strong></p>
                <p className="text-xs text-surface-600">{podsData.pods.length} pods available across {podNamespaces.length} namespaces</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'Traces' && (
          <div className="space-y-4">
            {/* Jaeger status banner */}
            {!tracesData.jaegerAvailable ? (
              <div className="rounded-xl bg-surface-800/50 border border-surface-700/50 p-3 flex items-center gap-2">
                <Info className="w-4 h-4 text-warning flex-shrink-0" />
                <span className="text-xs text-surface-400">
                  Jaeger not reachable — check <code className="text-brand-400">JAEGER_QUERY_URL</code> in your env and ensure the port-forward is running.
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-3 flex-wrap">
                {tracesData.services.length > 0 && (
                  <select value={traceService} onChange={e => setTraceService(e.target.value)}
                    className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-sm text-white outline-none focus:border-brand-500">
                    <option value="">All services</option>
                    {tracesData.services.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
                {/* Status filter */}
                <div className="flex items-center bg-surface-800 rounded-lg p-0.5">
                  {(['all','error','slow'] as const).map(s => (
                    <button key={s} onClick={() => setTraceStatus(s)}
                      className={cn('text-xs px-2.5 py-1 rounded-md font-medium capitalize transition-all',
                        traceStatus === s ? 'bg-surface-700 text-white' : 'text-surface-500 hover:text-surface-300'
                      )}>{s}</button>
                  ))}
                </div>
                {/* Lookback buttons */}
                <div className="flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-surface-500" />
                  {LOOKBACKS.map(l => (
                    <button key={l} onClick={() => setTraceLookback(l)}
                      className={cn('text-xs px-2 py-1 rounded-lg transition-all',
                        traceLookback === l ? 'bg-brand-500/20 text-brand-400' : 'text-surface-500 hover:text-surface-300'
                      )}>{l}</button>
                  ))}
                </div>
                {/* Min duration */}
                <div className="relative">
                  <input value={traceMinDur} onChange={e => setTraceMinDur(e.target.value)} placeholder="Min dur e.g. 500ms"
                    className="w-36 bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500" />
                </div>
                {/* Sort */}
                <select value={traceSort} onChange={e => setTraceSort(e.target.value as typeof traceSort)}
                  className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white outline-none focus:border-brand-500">
                  <option value="newest">Newest first</option>
                  <option value="slowest">Slowest first</option>
                  <option value="spans">Most spans</option>
                </select>
                {/* Operation search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-500" />
                  <input value={traceSearch} onChange={e => setTraceSearch(e.target.value)} placeholder="Search operation…"
                    className="w-44 bg-surface-800 border border-surface-700 rounded-xl pl-7 pr-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500" />
                </div>
                <span className="text-2xs text-surface-500 ml-auto">{filteredTraces.length} / {tracesData.total} traces</span>
              </div>
            )}
            {/* Service RED metrics — Rate / Errors / Duration derived from traces (Honeycomb-style) */}
            {tracesData.jaegerAvailable && serviceRed.length > 0 && (
              <div className="rounded-xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-2 border-b border-surface-800 flex items-center gap-2">
                  <span className="text-xs font-semibold text-white">Service RED Metrics</span>
                  <span className="text-2xs text-surface-500">derived from {tracesData.total} traces</span>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-surface-800">
                      {['Service','Traces','Error %','p50','p95','p99'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {serviceRed.map(s => (
                      <tr key={s.svc} className="border-b border-surface-800/40 hover:bg-surface-800/30 transition-colors">
                        <td className="px-3 py-2 text-xs font-medium text-white">{s.svc}</td>
                        <td className="px-3 py-2 text-xs tabular-nums text-surface-400">{s.total}</td>
                        <td className="px-3 py-2">
                          <span className={cn('text-xs tabular-nums font-mono', s.errorPct > 5 ? 'text-danger' : s.errorPct > 1 ? 'text-warning' : 'text-success')}>
                            {s.errorPct.toFixed(1)}%
                          </span>
                        </td>
                        <td className={cn('px-3 py-2 text-xs tabular-nums font-mono', s.p50 > 1000 ? 'text-warning' : 'text-surface-300')}>{formatLatency(s.p50)}</td>
                        <td className={cn('px-3 py-2 text-xs tabular-nums font-mono', s.p95 > 2000 ? 'text-danger' : s.p95 > 500 ? 'text-warning' : 'text-surface-300')}>{formatLatency(s.p95)}</td>
                        <td className={cn('px-3 py-2 text-xs tabular-nums font-mono', s.p99 > 5000 ? 'text-danger' : s.p99 > 2000 ? 'text-warning' : 'text-surface-300')}>{formatLatency(s.p99)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex gap-4 min-h-[600px]">
            {/* Trace list */}
            <div className="w-72 flex-shrink-0 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wider">Recent Traces</span>
                <span className="text-2xs text-surface-500">
                  {tracesData.jaegerAvailable ? `${tracesData.total} loaded` : 'Jaeger offline'}
                </span>
              </div>
              {filteredTraces
                .map(trace => (
                <div
                  key={trace.id}
                  onClick={() => { setSelectedTrace(trace); setSelectedSpanId(null) }}
                  className={cn(
                    'p-3 rounded-xl border cursor-pointer transition-all',
                    selectedTrace?.id === trace.id
                      ? 'bg-brand-500/10 border-brand-500/40'
                      : 'bg-surface-900 border-surface-800 hover:border-surface-600',
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={cn('w-2 h-2 rounded-full flex-shrink-0',
                      trace.status === 'error' ? 'bg-danger' :
                      trace.status === 'slow'  ? 'bg-warning' : 'bg-success',
                    )} />
                    <span className="text-xs font-mono text-white truncate">{trace.rootOperation}</span>
                  </div>
                  <div className="text-2xs text-surface-500 flex items-center justify-between">
                    <span>{trace.rootService} · {trace.spanCount} spans</span>
                    <span className={cn('font-bold tabular-nums',
                      trace.totalDuration > 2000 ? 'text-danger' :
                      trace.totalDuration > 500  ? 'text-warning' : 'text-success'
                    )}>{formatLatency(trace.totalDuration)}</span>
                  </div>
                  <div className="text-2xs text-surface-600 mt-0.5" suppressHydrationWarning>{relTime(trace.startedAt)}</div>
                </div>
              ))}
              {tracesData.jaegerAvailable && filteredTraces.length === 0 && (
                <div className="text-xs text-surface-500 py-6 text-center">
                  {traceSearch || traceStatus !== 'all' ? 'No traces match filters' : 'No traces yet — hit some API endpoints to generate them.'}
                </div>
              )}
            </div>

            {/* Waterfall */}
            <div className="flex-1 rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              {selectedTrace ? (
                <>
                  {/* Waterfall header */}
                  <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-3">
                    <span className={cn('w-2.5 h-2.5 rounded-full',
                      selectedTrace.status === 'error' ? 'bg-danger' :
                      selectedTrace.status === 'slow' ? 'bg-warning' : 'bg-success'
                    )} />
                    <span className="text-sm font-mono font-semibold text-white">{selectedTrace.rootOperation}</span>
                    <span className="text-2xs text-surface-500 ml-auto">
                      {selectedTrace.spanCount} spans · {selectedTrace.totalDuration}ms · Trace ID: {selectedTrace.id.slice(0, 16)}…
                    </span>
                  </div>

                  {/* Column headers */}
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-950 border-b border-surface-800">
                    <span className="w-48 text-2xs text-surface-500 font-semibold uppercase tracking-wider">Service</span>
                    <span className="w-36 text-2xs text-surface-500 font-semibold uppercase tracking-wider">Operation</span>
                    <span className="flex-1 text-2xs text-surface-500 font-semibold uppercase tracking-wider">Timeline</span>
                    <span className="w-14 text-right text-2xs text-surface-500 font-semibold uppercase tracking-wider">Duration</span>
                  </div>

                  {/* Spans */}
                  <div className="overflow-y-auto max-h-[460px]">
                    <TraceWaterfall trace={selectedTrace} selectedSpanId={selectedSpanId} onSelectSpan={setSelectedSpanId} />
                  </div>

                  {/* Span tag inspector */}
                  {selectedSpanId && (() => {
                    const span = selectedTrace.spans.find(s => s.id === selectedSpanId)
                    if (!span || !span.tags || Object.keys(span.tags).length === 0) return null
                    return (
                      <div className="border-t border-surface-800 p-4">
                        <p className="text-xs font-semibold text-surface-400 mb-2 flex items-center gap-1.5">
                          <Layers className="w-3 h-3" />{span.service} · {span.operation} · {span.duration}ms
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(span.tags).map(([k, v]) => (
                            <span key={k} className="text-2xs bg-surface-800 border border-surface-700 rounded px-2 py-0.5 font-mono">
                              <span className="text-brand-400">{k}</span>=<span className="text-surface-300">{String(v)}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  })()}

                  {/* Error spans detail */}
                  {selectedTrace.spans.filter(s => s.status === 'error').length > 0 && (
                    <div className="border-t border-surface-800 p-4">
                      <p className="text-xs font-semibold text-danger mb-2">Error Spans</p>
                      <div className="space-y-1.5">
                        {selectedTrace.spans.filter(s => s.status === 'error').map(s => (
                          <div key={s.id} className="flex items-start gap-2 text-xs p-2 rounded-lg bg-danger/5 border border-danger/20">
                            <span className="font-mono text-danger font-semibold flex-shrink-0">{s.service}</span>
                            <span className="text-surface-400">{s.operation}</span>
                            {s.tags?.error && <span className="text-danger/80 ml-auto">{s.tags.error}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-surface-500 text-sm">Select a trace to view the waterfall</div>
              )}
            </div>
            </div>
          </div>
        )}

        {activeTab === 'Events' && (
          <div className="space-y-4">
            {/* K8s API connection status */}
            {eventsLoading && (
              <div className="rounded-xl bg-surface-800/50 border border-surface-700/50 p-3 flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-brand-400 animate-spin flex-shrink-0" />
                <span className="text-xs text-surface-400">Loading events from Kubernetes API…</span>
              </div>
            )}
            {!eventsLive && !eventsLoading && (
              <div className="rounded-xl bg-warning/5 border border-warning/20 p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white">Kubernetes API not reachable &mdash; no events loaded</p>
                  <p className="text-2xs text-surface-400 mt-0.5"><code className="text-brand-400">K8S_API_URL=http://80.225.224.1:8001</code> &mdash; ensure kubectl proxy is running.</p>
                  {eventsError && <p className="text-2xs text-danger/80 mt-1 font-mono truncate">{eventsError}</p>}
                  <p className="text-2xs text-surface-500 mt-1">Fix: <code className="text-surface-300">kubectl proxy --address=0.0.0.0 --port=8001 &amp;</code></p>
                </div>
              </div>
            )}
            {/* Summary row */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'Total Events',     value: eventsData.summary.total,            color: 'text-white' },
                { label: 'Warnings',         value: eventsData.summary.warnings,         color: 'text-warning' },
                { label: 'High Repeat',      value: eventsData.summary.highRepeat,       color: 'text-orange-400' },
                { label: 'Recent (15m)',     value: eventsData.summary.recentWarnings15m,color: 'text-brand-400' },
                { label: 'Anomaly Bursts',   value: eventsData.summary.anomalyBursts,    color: eventsData.summary.anomalyBursts > 0 ? 'text-danger' : 'text-surface-500' },
              ].map(s => (
                <div key={s.label} className="rounded-xl bg-surface-900 border border-surface-800 px-4 py-3">
                  <div className="text-2xs text-surface-500 mb-1">{s.label}</div>
                  <div className={cn('text-xl font-bold tabular-nums', s.color)}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Event volume timeline — 12 × 30-min bars = last 6h (Datadog-style) */}
            {(() => {
              const maxH = Math.max(...evtTimeline.map(b => b.n + b.w), 1)
              const hasData = evtTimeline.some(b => b.n + b.w > 0)
              if (!hasData) return null
              return (
                <div className="rounded-xl bg-surface-900 border border-surface-800 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-2xs text-surface-500 font-semibold uppercase tracking-wider">Event Volume — last 6h</span>
                    <div className="flex items-center gap-3 text-2xs text-surface-600">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-warning/60 inline-block" />Warning</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-brand-400/40 inline-block" />Normal</span>
                    </div>
                  </div>
                  <div className="flex items-end gap-0.5 h-10">
                    {evtTimeline.map((b, i) => {
                      const total = b.n + b.w
                      const h = total ? Math.max(Math.round((total / maxH) * 36), 2) : 0
                      const color = b.w > 0 ? 'bg-warning/65' : 'bg-brand-400/40'
                      return (
                        <div key={i} className="flex-1 flex items-end">
                          {total > 0 && <div className={cn('w-full rounded-sm', color)} style={{ height: `${h}px` }} title={`${total} events (${b.w} warn)`} />}
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex justify-between mt-1 text-2xs text-surface-700">
                    <span>6h ago</span><span>3h ago</span><span>now</span>
                  </div>
                </div>
              )
            })()}

            {/* Anomaly bursts — only shown when detected */}
            {eventsData.anomalies.length > 0 && (
              <div className="rounded-2xl bg-danger/5 border border-danger/20 overflow-hidden">
                <div className="px-4 py-3 border-b border-danger/20 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-danger" />
                  <span className="text-sm font-semibold text-white">Anomaly Bursts Detected</span>
                  <span className="text-2xs text-danger ml-1">{eventsData.anomalies.length} reason{eventsData.anomalies.length !== 1 ? 's' : ''} spiking above normal</span>
                </div>
                <div className="divide-y divide-danger/10">
                  {(eventsData.anomalies as any[]).map((a: any) => (
                    <div key={`${a.type}:${a.reason}`} className="flex items-center gap-3 px-4 py-2.5">
                      <span className={cn('text-2xs px-2 py-0.5 rounded font-bold',
                        a.severity === 'critical' ? 'bg-danger/20 text-danger' : 'bg-warning/20 text-warning'
                      )}>{a.severity}</span>
                      <span className="text-sm font-medium text-white">{a.reason}</span>
                      <span className="text-2xs text-surface-500 ml-auto">{a.count} occurrences</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* View toggle + filters */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center bg-surface-800 rounded-lg p-0.5">
                {(['list', 'groups'] as const).map(v => (
                  <button key={v} onClick={() => setEvtView(v)}
                    className={cn('text-xs px-3 py-1.5 rounded-md font-medium capitalize transition-all',
                      evtView === v ? 'bg-surface-700 text-white' : 'text-surface-500 hover:text-surface-300'
                    )}>{v === 'groups' ? 'By Workload' : 'Event List'}</button>
                ))}
              </div>
              <button onClick={() => setEvtAutoRefresh(r => !r)}
                className={cn('flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-all',
                  evtAutoRefresh ? 'bg-success/10 text-success border-success/30' : 'text-surface-500 border-surface-700 hover:text-surface-300'
                )}>
                <RefreshCw className={cn('w-3 h-3', evtAutoRefresh && 'animate-spin')} />
                {evtAutoRefresh ? 'Live (15s)' : 'Auto-refresh'}
              </button>
              {/* Text search */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-500" />
                <input value={evtSearch} onChange={e => { setEvtSearch(e.target.value); setEvtPage(50) }} placeholder="Search events…"
                  className="w-48 bg-surface-800 border border-surface-700 rounded-lg pl-7 pr-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500" />
              </div>
              <select value={evtNs} onChange={e => setEvtNs(e.target.value)}
                className="bg-surface-800 border border-surface-700 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-brand-500">
                <option value="">All namespaces</option>
                {evtNamespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
              </select>
              <select value={evtType} onChange={e => setEvtType(e.target.value)}
                className="bg-surface-800 border border-surface-700 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-brand-500">
                <option value="all">All types</option>
                <option value="Warning">Warning only</option>
                <option value="Normal">Normal only</option>
              </select>
              {/* Reason filter */}
              {evtReasons.length > 0 && (
                <select value={evtReason} onChange={e => setEvtReason(e.target.value)}
                  className="bg-surface-800 border border-surface-700 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-brand-500">
                  <option value="">All reasons</option>
                  {evtReasons.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
              {(evtSearch || evtNs || evtType !== 'all' || evtReason) && (
                <button onClick={() => { setEvtSearch(''); setEvtNs(''); setEvtType('all'); setEvtReason('') }}
                  className="text-2xs text-surface-500 hover:text-surface-300 px-2 py-1 rounded border border-surface-700 hover:border-surface-600 transition-all">Clear</button>
              )}
              <span className="text-2xs text-surface-500 ml-auto">{filteredEvents.length} events</span>
              <button onClick={() => setShowSuppressionModal(true)}
                className={cn('flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-all',
                  suppressionRules.some(r => r.expiresAt > Date.now()) ? 'bg-warning/10 text-warning border-warning/30' : 'text-surface-500 border-surface-700 hover:text-surface-300'
                )}>
                <BellOff className="w-3 h-3" /> Suppress
              </button>
              <button onClick={() => { setWebhookInput(webhookUrl); setShowWebhookModal(true) }}
                className={cn('flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-all',
                  webhookUrl ? 'bg-brand-500/10 text-brand-400 border-brand-500/30' : 'text-surface-500 border-surface-700 hover:text-surface-300'
                )}>
                <Link2 className="w-3 h-3" /> Webhook
              </button>
              <button onClick={() => setShowAutoEsc(true)}
                className={cn('flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-all',
                  autoEscRules.length > 0 ? 'bg-orange-500/10 text-orange-400 border-orange-500/30' : 'text-surface-500 border-surface-700 hover:text-surface-300'
                )}>
                <Bell className="w-3 h-3" /> Auto-Esc
              </button>
              <button
                onClick={() => exportCSV(filteredEvents.map((e: any) => ({ type: e.type, reason: e.reason, object: e.involvedObject?.name ?? '', namespace: e.namespace, message: e.message, count: e.count, lastSeen: e.lastTime })), 'events.csv')}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-surface-700 text-surface-500 hover:text-surface-300 transition-all">
                <Download className="w-3 h-3" /> Export CSV
              </button>
            </div>

            {/* Correlated groups view */}
            {evtView === 'groups' && (
              <div className="space-y-3">
                {(eventsData.correlatedGroups as any[]).length === 0 && (
                  <div className="text-center text-surface-500 text-sm py-8">No warning clusters detected</div>
                )}
                {(eventsData.correlatedGroups as any[]).map((g: any) => (
                  <div key={g.key} className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                    <div className="flex items-center gap-3 px-4 py-3 bg-surface-800/40 cursor-pointer"
                      onClick={() => setExpandedEvt(expandedEvt === g.key ? null : g.key)}>
                      <span className={cn('text-2xs px-2 py-0.5 rounded font-semibold',
                        g.warningCount > 2 ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
                      )}>{g.warningCount} warnings</span>
                      <span className="text-sm font-medium text-white truncate">{g.owner}</span>
                      <span className="text-2xs text-surface-500">{g.namespace}</span>
                      <span className="text-2xs text-surface-600 ml-auto">{g.totalOccurrences} total</span>
                      {expandedEvt === g.key ? <ChevronDown className="w-3.5 h-3.5 text-surface-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-surface-500 flex-shrink-0" />}
                    </div>
                    {expandedEvt === g.key && (
                      <div className="divide-y divide-surface-800/50">
                        {(g.events as any[]).map((ev: any) => (
                          <div key={ev.id} className="flex items-start gap-3 px-4 py-2.5">
                            <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0', ev.type === 'Warning' ? 'bg-warning' : 'bg-info')} />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-white">{ev.reason}
                                {ev.count > 1 && <span className="ml-1.5 text-2xs bg-surface-800 px-1.5 py-0.5 rounded text-surface-400">×{ev.count}</span>}
                              </p>
                              <p className="text-2xs text-surface-500 truncate">{ev.message}</p>
                            </div>
                            <span className="text-2xs text-surface-600 flex-shrink-0">{new Date(ev.lastTime).toLocaleTimeString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Flat event list */}
            {evtView === 'list' && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 divide-y divide-surface-800/50">
                {filteredEvents.slice(0, evtPage).map((ev: any) => (
                  <div key={ev.id}
                    onClick={() => setExpandedEvt(expandedEvt === ev.id ? null : ev.id)}
                    className="hover:bg-surface-800/40 cursor-pointer transition-colors">
                    <div className="flex items-start gap-3 px-4 py-3">
                      <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0',
                        ev.type === 'Warning' ? 'bg-warning' : 'bg-info',
                      )} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white flex items-center gap-2">
                          <span className="text-surface-400 text-xs">[{ev.involvedObject?.kind}/{ev.involvedObject?.name}]</span>
                          {ev.reason}
                          {ev.count > 1 && <span className="text-2xs bg-surface-800 border border-surface-700 px-1.5 py-0.5 rounded text-surface-400">×{ev.count}</span>}
                        </p>
                        <p className="text-xs text-surface-400 mt-0.5 truncate">{ev.message}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <span suppressHydrationWarning className="text-2xs text-surface-500">{relTime(ev.lastTime)}</span>
                        {ev.namespace && <span className="text-2xs text-surface-600 font-mono">{ev.namespace}</span>}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0 ml-1" onClick={e => e.stopPropagation()}>
                        {ev.linkedIncidentId && (
                          <span className="text-2xs px-1.5 py-0.5 rounded bg-danger/10 text-danger border border-danger/20 font-mono">⚡ {ev.linkedIncidentId}</span>
                        )}
                        <button
                          onClick={() => { setEvtCreateModal({ reason: ev.reason, message: ev.message, namespace: ev.namespace ?? ev.involvedObject?.namespace ?? '' }); setEvtCreateForm(f => ({ ...f, title: `${ev.reason}: ${(ev.involvedObject?.name ?? ev.namespace ?? '')}` })) }}
                          className="text-2xs px-1.5 py-0.5 rounded border border-surface-700 text-surface-500 hover:text-danger hover:border-danger/40 transition-all"
                          title="Create incident from this event"
                        >+</button>
                        {webhookUrl && ev.type === 'Warning' && (
                          <button
                            onClick={() => handleTriggerWebhook(ev)}
                            className="text-2xs px-1.5 py-0.5 rounded border border-surface-700 text-surface-500 hover:text-brand-400 hover:border-brand-500/40 transition-all"
                            title="Send to webhook"
                          >↗</button>
                        )}
                      </div>
                      {expandedEvt === ev.id ? <ChevronDown className="w-3.5 h-3.5 text-surface-500 flex-shrink-0 mt-0.5" /> : <ChevronRight className="w-3.5 h-3.5 text-surface-500 flex-shrink-0 mt-0.5" />}
                    </div>
                    {expandedEvt === ev.id && (
                      <div className="px-7 pb-3 pt-0 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                        {[
                          ['Source', ev.sourceComponent],
                          ['Host', ev.sourceHost],
                          ['First seen', ev.firstTime ? relTime(ev.firstTime) : '—'],
                          ['Last seen', ev.lastTime ? new Date(ev.lastTime).toLocaleString() : '—'],
                        ].map(([k, v]) => v ? (
                          <div key={k} className="text-2xs">
                            <span className="text-surface-600">{k}: </span>
                            <span className="text-surface-400 font-mono">{v}</span>
                          </div>
                        ) : null)}
                      </div>
                    )}
                  </div>
                ))}
                {filteredEvents.length === 0 && (
                  <div className="px-4 py-8 text-center text-surface-500 text-sm">No events matching filters</div>
                )}
                {filteredEvents.length > evtPage && (
                  <div className="px-4 py-3 text-center">
                    <button onClick={() => setEvtPage(p => p + 50)}
                      className="text-xs text-brand-400 hover:text-brand-300 transition-colors">
                      Load {Math.min(50, filteredEvents.length - evtPage)} more ({filteredEvents.length - evtPage} remaining)
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Suppression Rules Modal ── */}
      {showSuppressionModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2"><BellOff className="w-4 h-4 text-warning" /> Event Suppression Rules</h3>
              <button onClick={() => setShowSuppressionModal(false)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-4">
              {suppressionRules.filter(r => r.expiresAt > Date.now()).length > 0 && (
                <div className="space-y-2">
                  <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Active Rules</p>
                  {suppressionRules.filter(r => r.expiresAt > Date.now()).map(r => (
                    <div key={r.id} className="flex items-center gap-3 bg-surface-800/50 rounded-xl px-3 py-2">
                      <span className="flex-1 text-xs font-mono text-warning">{r.reason}</span>
                      <span className="text-2xs text-surface-500">expires {new Date(r.expiresAt).toLocaleTimeString()}</span>
                      <button onClick={() => handleRemoveSuppressionRule(r.id)} className="text-danger hover:text-danger/80"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-2">
                <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Add Rule</p>
                <div className="flex gap-2">
                  <input value={newSupRule.reason} onChange={e => setNewSupRule(prev => ({ ...prev, reason: e.target.value }))}
                    placeholder="Reason (e.g. BackOff)" className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500" />
                  <select value={newSupRule.durationMin} onChange={e => setNewSupRule(prev => ({ ...prev, durationMin: parseInt(e.target.value) }))}
                    className="bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500">
                    <option value={60}>1h</option><option value={240}>4h</option><option value={1440}>24h</option><option value={4320}>72h</option>
                  </select>
                  <button onClick={handleAddSuppressionRule} disabled={!newSupRule.reason.trim()}
                    className="px-3 py-1.5 text-xs rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 transition-all">Add</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Webhook Config Modal ── */}
      {showWebhookModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2"><Link2 className="w-4 h-4 text-brand-400" /> Webhook Configuration</h3>
              <button onClick={() => setShowWebhookModal(false)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-surface-400">Warning events will POST a JSON payload to this URL.</p>
              <input value={webhookInput} onChange={e => setWebhookInput(e.target.value)}
                placeholder="https://hooks.slack.com/…"
                className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-brand-500" />
              {webhookUrl && (
                <button onClick={() => handleTriggerWebhook({ type: 'Warning', reason: 'Test', message: 'VynOps test event', count: 1, namespace: 'test' })}
                  className="text-2xs text-brand-400 hover:text-brand-300">Send test event</button>
              )}
            </div>
            <div className="px-5 py-3 border-t border-surface-800 flex justify-end gap-3">
              {webhookUrl && <button onClick={() => { setWebhookInput(''); handleSaveWebhook() }} className="px-3 py-1.5 text-sm text-danger hover:text-danger/80 transition-colors">Clear</button>}
              <button onClick={() => setShowWebhookModal(false)} className="px-3 py-1.5 text-sm text-surface-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={handleSaveWebhook} className="px-4 py-1.5 text-sm rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 transition-all">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Auto-Escalation Config Panel ── */}
      {showAutoEsc && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2"><Bell className="w-4 h-4 text-orange-400" /> Auto-Escalation Rules</h3>
              <button onClick={() => setShowAutoEsc(false)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-4">
              {autoEscRules.length > 0 && (
                <div className="space-y-2">
                  <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Active Rules</p>
                  {autoEscRules.map(r => (
                    <div key={r.reason} className="flex items-center gap-3 bg-surface-800/50 rounded-xl px-3 py-2">
                      <span className="flex-1 text-xs font-mono text-orange-300">{r.reason}</span>
                      <span className="text-2xs text-surface-500">threshold {r.minCount}×</span>
                      <span className={cn('text-2xs font-bold px-1.5 py-0.5 rounded', r.severity === 'critical' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning')}>{r.severity}</span>
                      <button onClick={() => setAutoEscRules(prev => prev.filter(x => x.reason !== r.reason))} className="text-danger hover:text-danger/80"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-2">
                <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Add Rule</p>
                <div className="flex gap-2">
                  <input value={newEscRule.reason} onChange={e => setNewEscRule(prev => ({ ...prev, reason: e.target.value }))}
                    placeholder="Reason (e.g. OOMKilling)"
                    className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500" />
                  <input type="number" value={newEscRule.minCount} onChange={e => setNewEscRule(prev => ({ ...prev, minCount: parseInt(e.target.value) }))}
                    className="w-16 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500" />
                  <select value={newEscRule.severity} onChange={e => setNewEscRule(prev => ({ ...prev, severity: e.target.value as any }))}
                    className="bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500">
                    <option value="medium">medium</option><option value="high">high</option><option value="critical">critical</option>
                  </select>
                  <button onClick={handleAddAutoEscRule} disabled={!newEscRule.reason.trim()}
                    className="px-3 py-1.5 text-xs rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 transition-all">Add</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Incident from Event Modal ── */}
      {evtCreateModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2"><Siren className="w-4 h-4 text-danger" /> Create Incident from Event</h3>
              <button onClick={() => setEvtCreateModal(null)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            {evtCreateSuccess ? (
              <div className="p-5">
                <p className={cn('text-sm font-semibold', evtCreateSuccess.startsWith('error:') ? 'text-danger' : 'text-success')}>
                  {evtCreateSuccess.startsWith('error:') ? evtCreateSuccess.replace('error:', '') : `Incident ${evtCreateSuccess} created`}
                </p>
              </div>
            ) : (
              <div className="p-5 space-y-4">
                <div className="rounded-lg bg-surface-800/50 px-3 py-2">
                  <p className="text-2xs text-surface-500 font-mono">{evtCreateModal.reason} · {evtCreateModal.namespace}</p>
                  <p className="text-xs text-surface-400 mt-0.5 line-clamp-2">{evtCreateModal.message}</p>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1">Incident Title *</label>
                    <input value={evtCreateForm.title} onChange={e => setEvtCreateForm(f => ({ ...f, title: e.target.value }))}
                      className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500"
                      placeholder="Describe the incident…" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1">Severity</label>
                      <select value={evtCreateForm.severity} onChange={e => setEvtCreateForm(f => ({ ...f, severity: e.target.value as any }))}
                        className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-brand-500">
                        {(['critical', 'high', 'medium'] as const).map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1">Owner</label>
                      <input value={evtCreateForm.owner} onChange={e => setEvtCreateForm(f => ({ ...f, owner: e.target.value }))}
                        className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-brand-500" />
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEvtCreateModal(null)} className="flex-1 px-4 py-2 rounded-xl bg-surface-800 border border-surface-700 text-sm text-surface-300 hover:text-white transition-all">Cancel</button>
                  <button onClick={handleCreateIncidentFromEvent} disabled={!evtCreateForm.title.trim()}
                    className="flex-1 px-4 py-2 rounded-xl bg-danger hover:bg-danger/80 disabled:opacity-40 text-white text-sm font-semibold flex items-center justify-center gap-1.5 transition-all">
                    <Siren className="w-3.5 h-3.5" /> Create Incident
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Metric Popup Modal ───────────────────────────────────────────── */}
      {metricPopup && (
        <>
          <div className="fixed inset-0 bg-black/60 z-50" onClick={() => { setMetricPopup(null); setPopupDrill(null); setPopupSub(null) }} />
          <div
            className="fixed inset-x-4 top-[5%] bottom-[5%] sm:inset-x-[10%] sm:top-[8%] sm:bottom-[8%] z-50 flex flex-col rounded-2xl bg-surface-900 border border-brand-500/30 shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-800 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: metricPopup.color }} />
                <span className="text-base font-semibold text-white">{metricPopup.label}</span>
                <span className="text-2xs text-surface-500 bg-surface-800 px-2 py-0.5 rounded-full">{metricPopup.unit.trim()}</span>
              </div>
              <button
                onClick={() => { setMetricPopup(null); setPopupDrill(null); setPopupSub(null) }}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-800 text-surface-400 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto">
              {/* Chart */}
              <div className="px-5 pt-4 pb-2">
                <MetricChart
                  data={metricPopup.data}
                  label=""
                  unit={metricPopup.unit}
                  color={metricPopup.color}
                  height={280}
                  onPointClick={(ts, value) => openPopupDrill(metricPopup.metricKey, metricPopup.label, ts, value)}
                />
                <p className="text-2xs text-surface-600 mt-1.5 text-center">click graph to drill down</p>
              </div>

              {/* Popup Drill panel */}
              {popupDrill && (
                <div className="mx-5 mb-5 rounded-xl bg-surface-950 border border-brand-500/30 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-brand-400" />
                      <span className="text-sm font-semibold text-white">{popupDrill.label} breakdown</span>
                      <span className="text-2xs text-surface-500">
                        at {format(new Date(popupDrill.ts * 1000), 'HH:mm:ss')} — value: {popupDrill.value.toFixed(2)}
                      </span>
                    </div>
                    <button onClick={() => { setPopupDrill(null); setPopupSub(null) }} className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-700 text-surface-400 hover:text-white">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="px-4 py-3 space-y-1">
                    {popupDrill.loading && (
                      <div className="flex items-center gap-2 text-surface-500 text-sm py-4 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading breakdown…
                      </div>
                    )}
                    {!popupDrill.loading && (!popupDrill.rows || popupDrill.rows.length === 0) && (
                      <p className="text-sm text-surface-500 py-4 text-center">No breakdown data available</p>
                    )}
                    {!popupDrill.loading && popupDrill.rows && popupDrill.rows.map(row => (
                      <div key={row.name}>
                        <div
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-800 cursor-pointer group/row transition-colors"
                          onClick={() => togglePopupSub(row)}
                        >
                          <ChevronRight className={cn('w-3 h-3 text-surface-500 transition-transform flex-shrink-0', popupSub?.rowName === row.name && 'rotate-90')} />
                          <span className="text-xs text-surface-300 flex-1 font-mono truncate">{row.name}</span>
                          <span className="text-xs font-mono tabular-nums text-surface-400">{row.value.toFixed(2)}{row.unit}</span>
                          <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
                            <button
                              onClick={e => { e.stopPropagation(); setActiveTab('Logs'); setLokiQuery(`{namespace="${(row.meta?.namespace ?? row.name.split('/')[0])}",pod=~"${row.meta?.pod ?? row.name.split('/')[1] ?? row.name}.*"}`); setLokiSince('30'); const tsS = popupDrill.ts; setLokiStart(tsS - 900); setLokiEnd(tsS + 900); pendingLokiFetch.current = true; setMetricPopup(null); setPopupDrill(null); setPopupSub(null) }}
                              className="px-1.5 py-0.5 rounded text-2xs bg-brand-500/10 hover:bg-brand-500/20 text-brand-400 flex items-center gap-1"
                            >
                              <ScrollText className="w-2.5 h-2.5" /> logs
                            </button>
                            <button
                              onClick={e => { e.stopPropagation(); const ns = row.meta?.namespace ?? row.name.split('/')[0]; const pod = row.meta?.pod ?? row.name.split('/')[1] ?? row.name; window.location.href = `/kubernetes?tab=Pods&pod=${pod}`; }}
                              className="px-1.5 py-0.5 rounded text-2xs bg-surface-700 hover:bg-surface-600 text-surface-300 flex items-center gap-1"
                            >
                              <ExternalLink className="w-2.5 h-2.5" /> k8s
                            </button>
                          </div>
                        </div>
                        {popupSub?.rowName === row.name && (
                          <div className="ml-5 pl-2 border-l border-surface-700 space-y-0.5 mt-0.5 mb-1">
                            {popupSub.loading && <div className="text-2xs text-surface-500 py-2 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> loading…</div>}
                            {!popupSub.loading && (!popupSub.rows || popupSub.rows.length === 0) && <p className="text-2xs text-surface-500 py-1">No data</p>}
                            {!popupSub.loading && popupSub.rows?.map(sr => (
                              <div key={sr.name} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-800 group/sr transition-colors">
                                <span className="text-2xs text-surface-400 flex-1 font-mono truncate">{sr.name}</span>
                                <span className="text-2xs font-mono tabular-nums text-surface-500">{sr.value.toFixed(2)}{sr.unit}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default function ObservabilityPage() {
  return (
    <Suspense>
      <ObservabilityInner />
    </Suspense>
  )
}

