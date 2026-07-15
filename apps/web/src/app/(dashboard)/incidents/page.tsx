'use client'

import { useState, useMemo, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Siren, Search, Plus, Clock, X, AlertTriangle, CheckCircle2,
  RefreshCw, ExternalLink, ChevronRight, ShieldAlert, Users,
  Zap, Timer, Flame, Activity, Radio, Download,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useLiveData } from '@/hooks/useLiveData'
import { cn, exportCSV } from '@/lib/utils'
import type { Severity } from '@/types'
import { useDashboardStore, getClusterHeaders } from '@/store'

// -- API response types ----------------------------------------

type AlertDoc = {
  id: string; name: string; severity: string; state: string
  summary: string; labels: Record<string, string>; startsAt: string
  source: string; affectedServices: string[]
}

type TimelineEvent = {
  id: string; ts: string; type: string; title: string; description: string
  severity?: string; actor?: string
}

type BlastRadius = {
  affectedServices: string[]; affectedUsers: number; affectedRegions: string[]
  slaBreached: boolean; dependentServices: string[]
}

type IncidentDoc = {
  id: string; title: string; description: string; severity: string; state: string
  owner: string; team: string; service: string; environment: string
  labels: Record<string, string>; createdAt: string; updatedAt: string
  resolvedAt?: string; slaDeadline: string; slaBreached: boolean
  alertCount: number; alerts: AlertDoc[]; timeline: TimelineEvent[]
  blastRadius: BlastRadius; runbookUrls: string[]; linkedDeployments: string[]
  source: 'auto' | 'manual'; durationMinutes: number; escalationLevel?: number
}

type Metrics = {
  open: number; critical: number; slaBreached: number; slaBreaching: number
  avgMttrMinutes: number | null; slaCompliancePct: number; totalAlerts: number
}

type ApiResponse = { incidents: IncidentDoc[]; metrics: Metrics; source: string }

// -- Constants -------------------------------------------------

const EMPTY: ApiResponse = {
  incidents: [],
  metrics: {
    open: 0, critical: 0, slaBreached: 0, slaBreaching: 0,
    avgMttrMinutes: null, slaCompliancePct: 100, totalAlerts: 0,
  },
  source: 'unknown',
}

const PAGE_SIZE = 25

const STATE_FILTERS = ['all', 'open', 'investigating', 'identified', 'monitoring', 'resolved'] as const

const STATE_COLORS: Record<string, string> = {
  open:          'text-danger  bg-danger/10  border-danger/20',
  investigating: 'text-warning bg-warning/10 border-warning/20',
  identified:    'text-blue-400 bg-blue-400/10 border-blue-400/20',
  monitoring:    'text-brand-400 bg-brand-400/10 border-brand-400/20',
  resolved:      'text-success bg-success/10 border-success/20',
}

const SEV_BAR: Record<string, string> = {
  critical: 'bg-danger', high: 'bg-warning', medium: 'bg-blue-400', low: 'bg-surface-500',
}

const SEV_BADGE: Record<string, string> = {
  critical: 'text-danger  border-danger/30  bg-danger/10',
  high:     'text-warning border-warning/30 bg-warning/10',
  medium:   'text-blue-400 border-blue-400/30 bg-blue-400/10',
  low:      'text-surface-400 border-surface-600 bg-surface-800',
}

const TL_ICONS: Record<string, React.ReactNode> = {
  alert:       <AlertTriangle className="w-3 h-3 text-warning" />,
  ai_insight:  <Zap className="w-3 h-3 text-brand-400" />,
  deployment:  <Activity className="w-3 h-3 text-blue-400" />,
  user_action: <Users className="w-3 h-3 text-surface-400" />,
  escalation:  <ShieldAlert className="w-3 h-3 text-danger" />,
  k8s_event:   <Activity className="w-3 h-3 text-info" />,
  resolution:  <CheckCircle2 className="w-3 h-3 text-success" />,
}

// -- Helpers ---------------------------------------------------

function fmtDuration(minutes: number): string {
  if (minutes < 60)   return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
}

// -- Sub-components --------------------------------------------

function SlaTag({ deadline, breached }: { deadline: string; breached: boolean }) {
  const minsLeft = Math.round((new Date(deadline).getTime() - Date.now()) / 60000)
  if (breached)        return <span className="text-2xs px-1.5 py-0.5 rounded font-semibold text-white bg-danger">SLA BREACHED</span>
  if (minsLeft < 30)   return <span className="text-2xs px-1.5 py-0.5 rounded font-semibold text-warning bg-warning/10 border border-warning/30">{minsLeft}m left</span>
  return                      <span className="text-2xs px-1.5 py-0.5 rounded font-semibold text-success bg-success/10 border border-success/20">SLA OK</span>
}

// -- Main page -------------------------------------------------

function IncidentsPage() {
  const { activeCluster, timeRange } = useDashboardStore()
  const searchParams = useSearchParams()
  const [stateFilter, setStateFilter] = useState<string>('all')
  const [sevFilter,   setSevFilter]   = useState<string>('all')
  const [search,      setSearch]      = useState('')
  const [selected,    setSelected]    = useState<IncidentDoc | null>(null)
  const [showModal,   setShowModal]   = useState(false)
  const [page,        setPage]        = useState(0)

  // New incident form
  const [newTitle,    setNewTitle]    = useState('')
  const [newSeverity, setNewSeverity] = useState<Severity>('medium')
  const [newDesc,     setNewDesc]     = useState('')
  const [newService,  setNewService]  = useState('')
  const [creating,    setCreating]    = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const { data, loading, error, isLive, refresh } = useLiveData<ApiResponse>(
    '/api/incidents', EMPTY, undefined, 30_000,
  )

  // Auto-select incident from ?id= query param (e.g. from Slack notification link)
  useEffect(() => {
    const targetId = searchParams.get('id')
    if (!targetId || !data.incidents.length) return
    const match = data.incidents.find(inc => inc.id === targetId)
    if (match) setSelected(match)
  }, [searchParams, data.incidents])

  const { data: oncallData } = useLiveData(
    '/api/settings/oncall',
    { schedules: [] as any[] },
    (r) => ({ schedules: r.schedules ?? [] }),
    120_000,
  )
  const currentOnCall = useMemo(() => {
    const primary = (oncallData.schedules as any[]).find((s: any) => s.id === 'primary') ?? (oncallData.schedules as any[])[0]
    return primary?.currentOnCall ?? null
  }, [oncallData.schedules])

  // Convert global timeRange to ms for resolved-incident age filtering
  const windowMs = useMemo(() => {
    const tr = timeRange ?? '24h'
    if (tr.endsWith('m')) return parseInt(tr) * 60_000
    if (tr.endsWith('h')) return parseInt(tr) * 3_600_000
    if (tr.endsWith('d')) return parseInt(tr) * 86_400_000
    return 24 * 3_600_000
  }, [timeRange])

  const filtered = useMemo(() => {
    const cutoff = Date.now() - windowMs
    return data.incidents.filter(inc => {
      if (stateFilter !== 'all' && inc.state !== stateFilter) return false
      if (sevFilter   !== 'all' && inc.severity !== sevFilter) return false
      // Hide resolved incidents older than the selected time window
      if (inc.state === 'resolved' && inc.resolvedAt && new Date(inc.resolvedAt).getTime() < cutoff) return false
      if (search) {
        const q = search.toLowerCase()
        if (!inc.title.toLowerCase().includes(q) &&
            !inc.id.toLowerCase().includes(q) &&
            !inc.service.toLowerCase().includes(q) &&
            !inc.description?.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [data.incidents, stateFilter, sevFilter, search, windowMs])
  // Reset page when filters change
  useEffect(() => setPage(0), [stateFilter, sevFilter, search, windowMs])

  const paginated = useMemo(() =>
    filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
  [filtered, page])
  // B3: counts must reflect same time-window + sev + search filters as the visible list
  const counts = useMemo(() => {
    const cutoff = Date.now() - windowMs
    const base = data.incidents.filter(inc => {
      if (sevFilter !== 'all' && inc.severity !== sevFilter) return false
      if (inc.state === 'resolved' && inc.resolvedAt && new Date(inc.resolvedAt).getTime() < cutoff) return false
      if (search) {
        const q = search.toLowerCase()
        if (!inc.title.toLowerCase().includes(q) && !inc.id.toLowerCase().includes(q) &&
            !inc.service.toLowerCase().includes(q) && !inc.description?.toLowerCase().includes(q)) return false
      }
      return true
    })
    const c: Record<string, number> = { all: base.length }
    for (const f of STATE_FILTERS.slice(1)) c[f] = base.filter(i => i.state === f).length
    return c
  }, [data.incidents, sevFilter, search, windowMs])

  const { open, critical, slaBreached, slaBreaching, avgMttrMinutes, slaCompliancePct, totalAlerts } = data.metrics

  async function declareIncident() {
    if (!newTitle.trim()) return
    setCreating(true); setCreateError(null)
    try {
      const res = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getClusterHeaders() },
        body: JSON.stringify({
          title:       newTitle.trim(),
          severity:    newSeverity,
          description: newDesc.trim(),
          service:     newService.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setCreateError((d as any).error ?? `Server error ${res.status}`)
        return
      }
      setNewTitle(''); setNewSeverity('medium'); setNewDesc(''); setNewService('')
      setShowModal(false)
      refresh()
    } catch (e) {
      setCreateError(String(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full overflow-hidden">

      {/* Main list panel */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800 flex-shrink-0">
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <Siren className="w-5 h-5 text-danger" /> Incident Command Center
            </h1>
            <p className="text-xs text-surface-500 mt-0.5 flex items-center gap-1.5">
              {activeCluster && <><span className="text-surface-300 font-medium">{activeCluster.name ?? activeCluster.displayName}</span><span className="mx-1">·</span></>}
              {isLive ? (
                <>
                  <Radio className="w-3 h-3 text-success animate-pulse" />
                  Live · {totalAlerts} active alert{totalAlerts !== 1 ? 's' : ''} · source: {data.source}
                  {currentOnCall && (
                    <span className="flex items-center gap-1.5 ml-2 text-surface-400 bg-surface-800 border border-surface-700 rounded-full px-2 py-0.5">
                      <Users className="w-3 h-3 text-success" />
                      On-call: <span className="text-white font-medium">{currentOnCall.name}</span>
                    </span>
                  )}
                </>
              ) : loading ? (
                <><RefreshCw className="w-3 h-3 animate-spin" /> Loading...</>
              ) : error ? (
                <span className="text-warning">⚠ {error}</span>
              ) : 'Not connected'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500" />
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search incidents…"
                className="w-48 bg-surface-800 border border-surface-700 rounded-xl pl-8 pr-3 py-1.5 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500"
              />
            </div>
            <button onClick={refresh} className="p-2 rounded-xl bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-white transition-all" title="Refresh">
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            </button>
            <button onClick={() => exportCSV(
              filtered.map(i => ({
                id: i.id, title: i.title, severity: i.severity, state: i.state,
                service: i.service, owner: i.owner, team: i.team, environment: i.environment,
                source: i.source, sla_breached: i.slaBreached, alert_count: i.alertCount,
                duration_min: i.durationMinutes, created_at: i.createdAt,
                resolved_at: i.resolvedAt ?? '',
              })),
              'incidents.csv'
            )} className="p-2 rounded-xl bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-white transition-all" title="Export CSV">
              <Download className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setShowModal(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-danger hover:bg-danger/90 rounded-xl text-sm font-medium text-white transition-all">
              <Plus className="w-3.5 h-3.5" /> Declare
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-surface-800 border-b border-surface-800 flex-shrink-0">
          {[
            { label: 'Open Incidents',  value: open,     sub: slaBreaching > 0 ? `${slaBreaching} SLA at risk` : 'No SLA risk',  color: open > 0 ? 'text-white' : 'text-surface-500',     icon: <Flame className="w-4 h-4" />,        iconCls: open > 0 ? 'text-danger' : 'text-surface-600',  onClick: () => { setStateFilter('open');     setSevFilter('all') } },
            { label: 'Critical Active', value: critical, sub: slaBreached > 0 ? `${slaBreached} SLA breached` : 'SLA compliant', color: critical > 0 ? 'text-danger' : 'text-surface-500', icon: <AlertTriangle className="w-4 h-4" />, iconCls: critical > 0 ? 'text-danger' : 'text-surface-600', onClick: () => { setStateFilter('all');       setSevFilter('critical') } },
            { label: 'Avg MTTR',        value: avgMttrMinutes !== null ? fmtDuration(avgMttrMinutes) : '\u2014', sub: 'resolved incidents', color: 'text-white', icon: <Timer className="w-4 h-4" />, iconCls: 'text-brand-400', onClick: () => { setStateFilter('resolved'); setSevFilter('all') } },
            { label: 'SLA Compliance',  value: `${slaCompliancePct}%`, sub: `${slaBreached} breached`, color: slaCompliancePct >= 90 ? 'text-success' : slaCompliancePct >= 70 ? 'text-warning' : 'text-danger', icon: <ShieldAlert className="w-4 h-4" />, iconCls: slaCompliancePct >= 90 ? 'text-success' : slaCompliancePct >= 70 ? 'text-warning' : 'text-danger', onClick: () => { setStateFilter('all'); setSevFilter('all') } },
          ].map(kpi => (
            <button key={kpi.label} onClick={kpi.onClick} className="bg-surface-900 px-5 py-3 flex items-center gap-3 hover:bg-surface-800/60 transition-colors text-left w-full">
              <span className={kpi.iconCls}>{kpi.icon}</span>
              <div>
                <p className="text-2xs text-surface-500 font-medium uppercase tracking-wide">{kpi.label}</p>
                <p className={cn('text-xl font-bold tabular-nums', kpi.color)}>{kpi.value}</p>
                <p className="text-2xs text-surface-600 mt-0.5">{kpi.sub}</p>
              </div>
            </button>
          ))}
        </div>

        {/* State filter tabs + severity pills */}
        <div className="flex flex-wrap items-center gap-1 px-3 sm:px-6 py-2.5 border-b border-surface-800 overflow-x-auto scrollbar-none flex-shrink-0">
          {STATE_FILTERS.map(f => (
            <button key={f} onClick={() => setStateFilter(f)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium capitalize transition-all flex-shrink-0',
                stateFilter === f ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30' : 'text-surface-400 hover:text-surface-300 hover:bg-surface-800',
              )}
            >
              {f}
              <span className={cn('text-2xs px-1.5 py-0.5 rounded-full', stateFilter === f ? 'bg-brand-500/30 text-brand-300' : 'bg-surface-800 text-surface-500')}>
                {counts[f] ?? 0}
              </span>
            </button>
          ))}
          <span className="w-px h-4 bg-surface-700 mx-1 flex-shrink-0" />
          {(['critical', 'high', 'medium', 'low'] as const).map(f => (
            <button key={f} onClick={() => setSevFilter(sevFilter === f ? 'all' : f)}
              className={cn('px-2.5 py-1 rounded-lg text-xs font-medium capitalize transition-all flex-shrink-0 border',
                sevFilter === f ? SEV_BADGE[f] : 'text-surface-500 border-transparent hover:text-surface-300')}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Incident list */}
        <div className="flex-1 overflow-y-auto">
          {loading && data.incidents.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-surface-500 gap-2">
              <RefreshCw className="w-5 h-5 animate-spin" /> Loading incidents...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-surface-500 gap-3">
              <Siren className="w-10 h-10 opacity-20" />
              <p className="text-sm">{data.incidents.length === 0 ? 'No incidents detected' : 'No incidents match your filter'}</p>
              {data.incidents.length === 0 && <p className="text-xs text-success flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> All systems nominal</p>}
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {paginated.map((inc, i) => (
                <motion.div key={inc.id}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  transition={{ delay: i * 0.03 }}
                  onClick={() => setSelected(selected?.id === inc.id ? null : inc)}
                  className={cn('flex items-center gap-3 px-4 py-3 border-b border-surface-800/60 cursor-pointer hover:bg-surface-800/50 group transition-colors', selected?.id === inc.id && 'bg-surface-800/70')}
                >
                  <span className={cn('w-1 self-stretch rounded-full flex-shrink-0', SEV_BAR[inc.severity] ?? 'bg-surface-600')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-mono text-surface-500">{inc.id}</span>
                      <span className={cn('text-2xs px-1.5 py-0.5 rounded border capitalize font-medium', SEV_BADGE[inc.severity])}>{inc.severity}</span>
                      <span className={cn('text-2xs px-1.5 py-0.5 rounded border capitalize font-medium', STATE_COLORS[inc.state])}>{inc.state}</span>
                      {inc.source === 'auto' && <span className="text-2xs px-1.5 py-0.5 rounded border font-medium text-surface-500 bg-surface-800 border-surface-700">auto-detected</span>}
                    </div>
                    <p className="text-sm font-semibold text-white mt-1 truncate">{inc.title}</p>
                    <div className="flex items-center gap-3 mt-1 text-2xs text-surface-500 flex-wrap">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /><span suppressHydrationWarning>{fmtDuration(inc.durationMinutes)}</span></span>
                      <span>{inc.service}</span>
                      {inc.alertCount > 0 && <span className="flex items-center gap-0.5 text-warning"><AlertTriangle className="w-3 h-3" />{inc.alertCount} alert{inc.alertCount !== 1 ? 's' : ''}</span>}
                      {inc.blastRadius.affectedServices.length > 0 && <span>{inc.blastRadius.affectedServices.length} svc affected</span>}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <SlaTag deadline={inc.slaDeadline} breached={inc.slaBreached} />
                    <span className="text-2xs text-surface-600">{inc.owner}</span>
                  </div>
                  <Link href={`/incidents/${inc.id}`} onClick={e => e.stopPropagation()}
                    className="p-1 rounded-lg hover:bg-surface-700 transition-colors flex-shrink-0" title="Open full page">
                    <ExternalLink className="w-3.5 h-3.5 text-surface-600 hover:text-brand-400" />
                  </Link>
                </motion.div>
              ))}
            </AnimatePresence>
          )}
          {/* -- Pagination controls -- */}
          {filtered.length > PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-surface-800 text-xs text-surface-500">
              <span>{page * PAGE_SIZE + 1}\u2013{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-2.5 py-1 rounded-lg bg-surface-800 border border-surface-700 disabled:opacity-40 hover:bg-surface-700 transition-all">
                  &#8592; Prev
                </button>
                <button
                  onClick={() => setPage(p => Math.min(Math.ceil(filtered.length / PAGE_SIZE) - 1, p + 1))}
                  disabled={(page + 1) * PAGE_SIZE >= filtered.length}
                  className="px-2.5 py-1 rounded-lg bg-surface-800 border border-surface-700 disabled:opacity-40 hover:bg-surface-700 transition-all">
                  Next &#8594;
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      <AnimatePresence>
        {selected && (
          <motion.div key="detail"
            initial={{ width: 0, opacity: 0 }} animate={{ width: 420, opacity: 1 }} exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="flex-shrink-0 border-l border-surface-800 bg-surface-950 overflow-hidden"
          >
            <div className="w-[420px] h-full overflow-y-auto p-5 space-y-5">
              {/* Header */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                    <span className="text-xs font-mono text-surface-500">{selected.id}</span>
                    <span className={cn('text-2xs px-1.5 py-0.5 rounded border capitalize font-medium', SEV_BADGE[selected.severity])}>{selected.severity}</span>
                    <span className={cn('text-2xs px-1.5 py-0.5 rounded border capitalize font-medium', STATE_COLORS[selected.state])}>{selected.state}</span>
                  </div>
                  <h2 className="text-sm font-bold text-white leading-snug">{selected.title}</h2>
                </div>
                <button onClick={() => setSelected(null)} className="w-7 h-7 flex items-center justify-center rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-white transition-all flex-shrink-0">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {[
                  { label: 'Duration', value: fmtDuration(selected.durationMinutes), danger: false },
                  { label: 'Alerts',   value: String(selected.alertCount),            danger: false },
                  { label: 'SLA',      value: selected.slaBreached ? 'Breached' : 'OK', danger: selected.slaBreached },
                ].map(s => (
                  <div key={s.label} className="bg-surface-800 rounded-xl p-3 text-center">
                    <p className="text-2xs text-surface-500 mb-1">{s.label}</p>
                    <p className={cn('text-sm font-bold', s.danger ? 'text-danger' : 'text-white')}>{s.value}</p>
                  </div>
                ))}
              </div>

              {/* Description */}
              {selected.description && (
                <p className="text-xs text-surface-400 leading-relaxed p-3 bg-surface-800/50 rounded-xl">{selected.description}</p>
              )}

              {/* Meta */}
              <div className="space-y-2">
                {[
                  { label: 'Service',      value: selected.service },
                  { label: 'Owner',        value: selected.owner },
                  { label: 'Team',         value: selected.team },
                  { label: 'Environment',  value: selected.environment },
                  { label: 'Created',      value: new Date(selected.createdAt).toLocaleString() },
                  { label: 'SLA Deadline', value: new Date(selected.slaDeadline).toLocaleString() },
                ].map(m => (
                  <div key={m.label} className="flex items-center justify-between text-xs">
                    <span className="text-surface-500">{m.label}</span>
                    <span className="text-white font-medium">{m.value}</span>
                  </div>
                ))}
              </div>

              {/* Runbooks */}
              {selected.runbookUrls.length > 0 && (
                <div>
                  <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2">Runbooks</p>
                  <div className="space-y-1.5">
                    {selected.runbookUrls.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300 transition-colors">
                        <ExternalLink className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{url.split('/').pop() ?? url}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Blast radius */}
              {selected.blastRadius.affectedServices.length > 0 && (
                <div>
                  <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2">Blast Radius</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.blastRadius.affectedServices.map(s => (
                      <span key={s} className="text-2xs px-2 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/20">{s}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Alerts */}
              {selected.alerts.length > 0 && (
                <div>
                  <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2">Active Alerts ({selected.alerts.length})</p>
                  <div className="space-y-1.5">
                    {selected.alerts.map(a => (
                      <div key={a.id} className="flex items-start gap-2 p-2.5 bg-surface-800 rounded-xl">
                        <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0', SEV_BAR[a.severity] ?? 'bg-surface-500')} />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-white">{a.name}</p>
                          <p className="text-2xs text-surface-500 mt-0.5 truncate">{a.labels.job ?? a.labels.namespace ?? a.labels.instance ?? '�'}</p>
                          <p className="text-2xs text-surface-600 mt-0.5" suppressHydrationWarning>Firing for {formatDistanceToNow(new Date(a.startsAt))}</p>
                        </div>
                        <span className={cn('text-2xs px-1.5 py-0.5 rounded border flex-shrink-0', SEV_BADGE[a.severity])}>{a.severity}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Timeline */}
              {selected.timeline.length > 0 && (
                <div>
                  <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-3">Timeline</p>
                  <div className="relative">
                    <div className="absolute left-3 top-0 bottom-0 w-px bg-surface-800" />
                    <div className="space-y-4">
                      {selected.timeline.map(ev => (
                        <div key={ev.id} className="flex gap-3 relative">
                          <div className="w-6 h-6 rounded-full bg-surface-800 border border-surface-700 flex items-center justify-center flex-shrink-0 z-10">
                            {TL_ICONS[ev.type] ?? <Activity className="w-3 h-3 text-surface-400" />}
                          </div>
                          <div className="flex-1 min-w-0 pb-1">
                            <p className="text-xs font-semibold text-white">{ev.title}</p>
                            <p className="text-2xs text-surface-500 mt-0.5 leading-relaxed">{ev.description}</p>
                            {ev.actor && <p className="text-2xs text-surface-600 mt-0.5">{ev.actor}</p>}
                            <p className="text-2xs text-surface-700 mt-1" suppressHydrationWarning>
                              {formatDistanceToNow(new Date(ev.ts), { addSuffix: true })}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Declare Incident Modal */}
      <AnimatePresence>
        {showModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={e => { if (e.target === e.currentTarget) setShowModal(false) }}
          >
            <motion.div initial={{ scale: 0.95, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 16 }}
              className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Siren className="w-4 h-4 text-danger" /> Declare Incident
                </h2>
                <button onClick={() => setShowModal(false)} className="w-7 h-7 flex items-center justify-center rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-white transition-all">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-surface-400 mb-1">Title *</label>
                  <input value={newTitle} onChange={e => setNewTitle(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && declareIncident()}
                    placeholder="Brief description of the incident"
                    className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-surface-400 mb-1">Severity</label>
                    <select value={newSeverity} onChange={e => setNewSeverity(e.target.value as Severity)}
                      className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-brand-500">
                      {(['critical', 'high', 'medium', 'low'] as Severity[]).map(s => (
                        <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-surface-400 mb-1">Affected Service</label>
                    <input value={newService} onChange={e => setNewService(e.target.value)}
                      placeholder="e.g. api-gateway"
                      className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-surface-400 mb-1">Description</label>
                  <textarea value={newDesc} onChange={e => setNewDesc(e.target.value)} rows={3}
                    placeholder="What is happening? What is the user impact?"
                    className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500 resize-none" />
                </div>
                <p className="text-2xs text-surface-500">
                  SLA window for <span className="font-semibold text-surface-300">{newSeverity}</span>:{' '}
                  {newSeverity === 'critical' ? '30 minutes' : newSeverity === 'high' ? '2 hours' : newSeverity === 'medium' ? '8 hours' : '48 hours'}
                </p>
                {createError && (
                  <p className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-xl px-3 py-2">{createError}</p>
                )}
                <div className="flex gap-2 pt-1">
                  <button onClick={() => { setShowModal(false); setCreateError(null) }} className="flex-1 px-3 py-2 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-sm text-surface-400 transition-all">Cancel</button>
                  <button onClick={declareIncident} disabled={!newTitle.trim() || creating}
                    className="flex-1 px-3 py-2 bg-danger hover:bg-danger/90 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-50">
                    {creating ? 'Declaring...' : 'Declare Incident'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function IncidentsPageWrapper() {
  return (
    <Suspense fallback={null}>
      <IncidentsPage />
    </Suspense>
  )
}
