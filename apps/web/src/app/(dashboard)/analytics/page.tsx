'use client'

import { useState, useMemo, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { useDashboardStore } from '@/store'
import {
  BarChart3, TrendingUp, TrendingDown, Target, Wifi, WifiOff,
  RefreshCw, Rocket, Activity, Server, ChevronDown, AlertTriangle,
  CheckCircle2, Clock, Flame, Shield, Download, Pencil, Check, X as XIcon,
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { format, formatDistanceToNow } from 'date-fns'
import { useLiveData } from '@/hooks/useLiveData'
import { cn } from '@/lib/utils'

// -- Types -----------------------------------------------------------------
interface TsPoint { ts: number; value: number; forecast?: boolean }
interface DayCount  { date: string; count: number }
interface SlaService {
  name: string; namespace: string; desired: number; available: number
  availability: number; slaTarget: number; slaStatus: string
  budgetUsedPct: number; budgetRemainingMins: number; updatedAt: string
  avail1h: number; avail6h: number; avail30d: number
  burnRate1h: number; burnRate6h: number
  fastBurn: boolean; slowBurn: boolean
  historyPts: { ts: number; value: number }[]
}
interface AnalyticsData {
  window: string; windowLabel: string
  infra: {
    cpu:    { current: number; avg: number; peak: number; history: TsPoint[]; forecast: TsPoint[]; etaDays: number | null }
    memory: { current: number; avg: number; peak: number; history: TsPoint[]; forecast: TsPoint[]; etaDays: number | null }
    pods:   { current: number; history: TsPoint[] }
    restarts24h: number
  }
  dora: {
    deployFrequency7d: number; band: string; successRate: number
    changeFailureRate: number; failedDeploys: number; totalDeploys7d: number
    activeDeploys: number; deployFrequencyHistory: DayCount[]
  }
  sla: SlaService[]
  source: string
}

const EMPTY: AnalyticsData = {
  window: '24h', windowLabel: '24 Hours',
  infra: {
    cpu:    { current: 0, avg: 0, peak: 0, history: [], forecast: [], etaDays: null },
    memory: { current: 0, avg: 0, peak: 0, history: [], forecast: [], etaDays: null },
    pods:   { current: 0, history: [] },
    restarts24h: 0,
  },
  dora: {
    deployFrequency7d: 0, band: 'low', successRate: 100, changeFailureRate: 0,
    failedDeploys: 0, totalDeploys7d: 0, activeDeploys: 0, deployFrequencyHistory: [],
  },
  sla: [],
  source: 'loading',
}

function exportSlaCSV(sla: SlaService[]) {
  const headers = ['Service','Namespace','SLA Target','Availability Now','1h Avail','6h Avail','30d Avail','Status','Budget Used %','Budget Remaining (min)','Burn Rate 1h','Burn Rate 6h','Replicas']
  const rows = sla.map(s => [
    s.name, s.namespace, `${s.slaTarget}%`,
    `${s.availability.toFixed(2)}%`, `${s.avail1h.toFixed(3)}%`, `${s.avail6h.toFixed(3)}%`, `${s.avail30d.toFixed(3)}%`,
    s.slaStatus, `${s.budgetUsedPct}%`, s.budgetRemainingMins.toFixed(1),
    `${s.burnRate1h}x`, `${s.burnRate6h}x`, `${s.available}/${s.desired}`,
  ])
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const a = document.createElement('a')
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.href = blobUrl
  a.download = `vynops-sla-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(blobUrl), 100)
}

const TABS = ['Overview', 'SLA / Error Budget', 'Capacity', 'Latency (p95)'] as const
type Tab = typeof TABS[number]

interface LatencyData {
  window: string; windowLabel: string; hasData: boolean
  current: { p50ms: number|null; p95ms: number|null; p99ms: number|null; rps: number|null; errRps: number|null }
  history: { p50: TsPoint[]; p95: TsPoint[]; p99: TsPoint[]; rps: TsPoint[]; err: TsPoint[] }
  services: { ingress: string; service: string; namespace: string; p95ms: number|null }[]
  source: string
}

const EMPTY_LAT: LatencyData = {
  window: '1h', windowLabel: '1 Hour', hasData: false,
  current: { p50ms: null, p95ms: null, p99ms: null, rps: null, errRps: null },
  history: { p50: [], p95: [], p99: [], rps: [], err: [] },
  services: [], source: 'loading',
}
const WINDOWS = ['1h', '6h', '24h', '7d', '30d'] as const
type WinOption = typeof WINDOWS[number]

/** Map global header timeRange to analytics-supported window */
function toAnalyticsWindow(tr: string): WinOption {
  if (tr === '30d')                return '30d'
  if (tr === '7d')                 return '7d'
  if (tr === '24h' || tr === '12h') return '24h'
  if (tr === '6h'  || tr === '3h')  return '6h'
  return '1h'
}

// -- Helpers ----------------------------------------------------------------
const BAND_LABEL: Record<string, string> = {
  elite: 'Elite', high: 'High', medium: 'Medium', low: 'Low',
}
const BAND_CLR: Record<string, string> = {
  elite: 'text-success bg-success/10 border-success/20',
  high:  'text-teal-400 bg-teal-500/10 border-teal-500/20',
  medium:'text-warning bg-warning/10 border-warning/20',
  low:   'text-danger  bg-danger/10  border-danger/20',
}
const SLA_CLR: Record<string, string> = {
  healthy: 'text-success', 'at-risk': 'text-warning', breached: 'text-danger',
}

const CustomTooltip = ({ active, payload, label, unit }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface-900 border border-surface-700 rounded-xl px-3 py-2 text-xs shadow-xl">
      {label && <p className="text-surface-400 mb-1">{typeof label === 'number' ? format(new Date(label), 'HH:mm') : label}</p>}
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color ?? p.stroke }} className="font-medium">
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(1) : p.value}{unit ?? ''}
        </p>
      ))}
    </div>
  )
}

function KpiCard({ label, value, sub, trend, color = 'text-white', badge }: {
  label: string; value: string; sub: string; trend?: 'up' | 'down' | 'neutral'
  color?: string; badge?: { label: string; cls: string }
}) {
  return (
    <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
      <p className="text-2xs text-surface-500 uppercase tracking-wider font-medium">{label}</p>
      <div className="flex items-end gap-2 mt-1">
        <p className={cn('text-2xl font-black tabular-nums', color)}>{value}</p>
        {badge && <span className={cn('text-2xs px-1.5 py-0.5 rounded border font-medium mb-0.5', badge.cls)}>{badge.label}</span>}
      </div>
      <p className={cn('text-xs mt-1 flex items-center gap-1',
        trend === 'up'   ? 'text-success' :
        trend === 'down' ? 'text-danger'  : 'text-surface-500')}>
        {trend === 'up'   && <TrendingUp   className="w-3 h-3" />}
        {trend === 'down' && <TrendingDown className="w-3 h-3" />}
        {sub}
      </p>
    </div>
  )
}

// -- Main --------------------------------------------------------------------
function AnalyticsInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get('tab')
    return (TABS as readonly string[]).includes(t ?? '') ? t as Tab : 'Overview'
  })
  const { timeRange, activeCluster } = useDashboardStore()
  const win = toAnalyticsWindow(timeRange)

  const { data: latData, refresh: latRefresh, loading: latLoading } = useLiveData<LatencyData>(
    '/api/analytics/latency?window=' + win,
    EMPTY_LAT, undefined, 30_000,
  )

  const { data, isLive, refresh, loading, error } = useLiveData<AnalyticsData>(
    '/api/analytics?window=' + win,
    EMPTY, undefined, 60_000,
  )
  const { infra, dora, sla } = data

  // Merge actual + forecast for capacity charts
  const cpuFull = useMemo(() => [
    ...infra.cpu.history,
    ...infra.cpu.forecast,
  ], [infra.cpu.history, infra.cpu.forecast])

  const memFull = useMemo(() => [
    ...infra.memory.history,
    ...infra.memory.forecast,
  ], [infra.memory.history, infra.memory.forecast])

  const slaBreached = sla.filter(s => s.slaStatus === 'breached').length
  const slaAtRisk   = sla.filter(s => s.slaStatus === 'at-risk').length

  // Fleet 30d compliance trend — average availability across all services per day
  const fleetHistory = useMemo(() => {
    if (!sla.some(s => s.historyPts && s.historyPts.length > 2)) return []
    // Pre-build Map<ts, value[]> to avoid O(n²) .find() in render
    const tsValMap = new Map<number, number[]>()
    sla.forEach(s => (s.historyPts ?? []).forEach(p => {
      const arr = tsValMap.get(p.ts)
      if (arr) arr.push(p.value)
      else tsValMap.set(p.ts, [p.value])
    }))
    return Array.from(tsValMap.keys()).sort((a, b) => a - b).map(ts => {
      const vals = tsValMap.get(ts)!
      return {
        ts,
        value: parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)),
      }
    }).filter(p => p.value > 0)
  }, [sla])

  return (
    <div className="flex flex-col h-full">
      {/* -- Header -- */}
      <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-brand-400" /> Analytics &amp; SLA
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">
            {activeCluster && <><span className="text-surface-300 font-medium">{activeCluster.name ?? activeCluster.displayName}</span>{' · '}</>}DORA metrics · SLA tracking · capacity forecasting · live cluster data
          </p>
        </div>
        <div className="flex items-center gap-2">
              <span className="text-xs text-surface-500">Window: <span className="text-brand-400 font-medium">{win}</span></span>
          {isLive
            ? <span className="flex items-center gap-1.5 px-2.5 py-1 bg-success/10 border border-success/20 rounded-xl text-xs text-success"><Wifi className="w-3 h-3" /> Live</span>
            : <span className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-800 border border-surface-700 rounded-xl text-xs text-surface-400"><WifiOff className="w-3 h-3" /> Offline</span>
          }
          {error && (
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-warning/5 border border-warning/20 rounded-xl text-xs text-warning/80">
              <AlertTriangle className="w-3 h-3" /> {error}
            </span>
          )}
          <button onClick={refresh} disabled={loading}
            className="w-8 h-8 flex items-center justify-center bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-surface-400 hover:text-white disabled:opacity-50 transition-all">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* -- Tabs -- */}
      <div className="flex items-center gap-1 px-3 sm:px-6 pt-2 sm:pt-3 border-b border-surface-800 overflow-x-auto scrollbar-none flex-shrink-0">
        {TABS.map(t => (
          <button key={t} onClick={() => { setTab(t); router.replace(`?tab=${encodeURIComponent(t)}`, { scroll: false }) }}
            className={cn('px-3 py-2 text-sm font-medium border-b-2 transition-all',
              tab === t ? 'border-brand-500 text-brand-400' : 'border-transparent text-surface-400 hover:text-surface-300')}>
            {t}
            {t === 'SLA / Error Budget' && slaBreached > 0 && (
              <span className="ml-1.5 text-2xs px-1.5 py-0.5 bg-danger/20 text-danger rounded-full">{slaBreached}</span>
            )}
          {t === 'SLA / Error Budget' && (
            <button
              onClick={e => { e.stopPropagation(); exportSlaCSV(sla) }}
              className="ml-1 p-1 rounded text-surface-500 hover:text-brand-400 hover:bg-surface-800 transition-colors"
              title="Export SLA data as CSV"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          )}
          {t === 'Latency (p95)' && !latData.hasData && (
            <span className="ml-1 text-2xs px-1.5 py-0.5 bg-surface-800 text-surface-500 border border-surface-700 rounded-full">awaiting traffic</span>
          )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-5">

        {/* -- OVERVIEW -------------------------------------------------------- */}
        {tab === 'Overview' && (
          <>
            {/* DORA KPI strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                label="Deploy Frequency"
                value={`${dora.deployFrequency7d}/day`}
                sub={`${dora.totalDeploys7d} deploys in 7d`}
                badge={{ label: BAND_LABEL[dora.band] ?? dora.band, cls: BAND_CLR[dora.band] ?? BAND_CLR['low']! }}
                trend={dora.deployFrequency7d >= 1 ? 'up' : 'neutral'}
                color="text-white"
              />
              <KpiCard
                label="Success Rate"
                value={`${dora.successRate}%`}
                sub={dora.failedDeploys > 0 ? `${dora.failedDeploys} deployments currently degraded` : 'All deployments healthy'}
                color={dora.successRate >= 99 ? 'text-success' : 'text-warning'}
                trend={dora.successRate >= 99 ? 'up' : 'down'}
              />
              <KpiCard
                label="Change Failure Rate"
                value={`${dora.changeFailureRate}%`}
                sub="deployments with unavailable replicas"
                color={dora.changeFailureRate === 0 ? 'text-success' : dora.changeFailureRate < 5 ? 'text-warning' : 'text-danger'}
                trend={dora.changeFailureRate === 0 ? 'up' : 'down'}
              />
              <KpiCard
                label="SLA Compliance"
                value={`${sla.length > 0 ? Math.round((sla.filter(s => s.slaStatus === 'healthy').length / sla.length) * 100) : 100}%`}
                sub={`${slaBreached} breached · ${slaAtRisk} at-risk`}
                color={slaBreached > 0 ? 'text-danger' : slaAtRisk > 0 ? 'text-warning' : 'text-success'}
                trend={slaBreached > 0 ? 'down' : 'up'}
              />
            </div>

            {/* Deploy frequency heatmap */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Rocket className="w-4 h-4 text-brand-400" /> Deploy Frequency (Last 7 Days)
                </h3>
                <span className={cn('text-2xs px-2 py-0.5 rounded border font-medium', BAND_CLR[dora.band] ?? BAND_CLR['low']!)}>
                  {BAND_LABEL[dora.band] ?? dora.band} · {dora.deployFrequency7d}/day
                </span>
              </div>
              <ResponsiveContainer width="100%" height={130}>
                <BarChart data={dora.deployFrequencyHistory} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={v => format(new Date(v), 'EEE d')} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip content={<CustomTooltip unit=" deploys" />} />
                  <Bar dataKey="count" name="Deploys" fill="#6366f1" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Infrastructure charts */}
            <div className="grid lg:grid-cols-2 gap-4">
              <InfraChart
                label={`CPU Utilization (${win})`}
                history={infra.cpu.history}
                current={infra.cpu.current}
                avg={infra.cpu.avg}
                peak={infra.cpu.peak}
                unit="%"
                color="#6366f1"
                threshold={80}
              />
              <InfraChart
                label={`Memory Utilization (${win})`}
                history={infra.memory.history}
                current={infra.memory.current}
                avg={infra.memory.avg}
                peak={infra.memory.peak}
                unit="%"
                color="#06b6d4"
                threshold={85}
              />
            </div>

            {/* Pod count + restarts */}
            <div className="grid lg:grid-cols-2 gap-4">
              <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-white">Pod Count</h3>
                  <span className="text-xl font-black text-white tabular-nums">{infra.pods.current}</span>
                </div>
                <ResponsiveContainer width="100%" height={100}>
                  <AreaChart data={infra.pods.history} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                    <defs>
                      <linearGradient id="podGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0}  />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="ts" tickFormatter={(() => { const s = (infra.pods.history.length >= 2 ? infra.pods.history[infra.pods.history.length-1]!.ts - infra.pods.history[0]!.ts : 0); return s > 2*24*3600*1000 ? (v: number) => format(new Date(v),'MMM d') : (v: number) => format(new Date(v),'HH:mm') })()} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} />
                    <Tooltip content={<CustomTooltip unit=" pods" />} />
                    <Area type="monotone" dataKey="value" name="Pods" stroke="#22c55e" strokeWidth={2} fill="url(#podGrad)" dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                <h3 className="text-sm font-semibold text-white mb-3">Infrastructure Health (24h)</h3>
                <div className="space-y-3">
                  {[
                    { label: 'CPU Average',       val: `${infra.cpu.avg.toFixed(1)}%`,    ok: infra.cpu.avg < 70 },
                    { label: 'CPU Peak',           val: `${infra.cpu.peak.toFixed(1)}%`,   ok: infra.cpu.peak < 80 },
                    { label: 'Memory Average',     val: `${infra.memory.avg.toFixed(1)}%`, ok: infra.memory.avg < 80 },
                    { label: 'Memory Peak',        val: `${infra.memory.peak.toFixed(1)}%`,ok: infra.memory.peak < 90 },
                    { label: 'Pod Restarts (24h)', val: `${infra.restarts24h}`,             ok: infra.restarts24h === 0 },
                    { label: 'Active Pods',        val: `${infra.pods.current}`,            ok: true },
                  ].map(({ label, val, ok }) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="text-xs text-surface-400">{label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-white tabular-nums">{val}</span>
                        {ok
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                          : <AlertTriangle className="w-3.5 h-3.5 text-warning" />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {/* -- SLA / ERROR BUDGET ---------------------------------------------- */}
        {tab === 'SLA / Error Budget' && (
          <>
            {/* Summary KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                label="Fleet Compliance"
                value={sla.length > 0 ? `${((sla.filter(s => s.slaStatus === 'healthy').length / sla.length) * 100).toFixed(0)}%` : '—'}
                sub={`${sla.filter(s => s.slaStatus === 'healthy').length} of ${sla.length} services healthy`}
                color={sla.every(s => s.slaStatus === 'healthy') ? 'text-success' : slaBreached > 0 ? 'text-danger' : 'text-warning'}
                badge={sla.length > 0 && sla.every(s => s.slaStatus === 'healthy') ? { label: 'All healthy', cls: 'bg-success/10 text-success border-success/20' } : undefined}
              />
              <KpiCard label="SLA Breached" value={String(slaBreached)} sub={slaBreached > 0 ? 'Immediate action required' : 'No breaches'} color={slaBreached > 0 ? 'text-danger' : 'text-success'} />
              <KpiCard label="At Risk" value={String(slaAtRisk)} sub={slaAtRisk > 0 ? 'Budget < 20% remaining' : 'No services at risk'} color={slaAtRisk > 0 ? 'text-warning' : 'text-success'} />
              <KpiCard label="Fast Burns" value={String(sla.filter(s => s.fastBurn).length)} sub="Budget exhausts in <1h" color={sla.some(s => s.fastBurn) ? 'text-danger' : 'text-success'} badge={sla.some(s => s.fastBurn) ? { label: 'Action needed', cls: 'bg-danger/10 text-danger border-danger/20' } : undefined} />
            </div>

            {/* Fast burn alert banner */}
            {sla.some(s => s.fastBurn) && (
              <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 flex items-start gap-3">
                <Flame className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-danger">Fast Burn Alert — Budget exhaustion imminent</p>
                  <p className="text-2xs text-surface-400 mt-0.5">
                    Services burning &gt;14x normal:{' '}<span className="font-mono text-white">{sla.filter(s => s.fastBurn).map(s => s.name).join(', ')}</span>
                    {' '}— 30-day error budget exhausts within the hour.
                  </p>
                </div>
              </div>
            )}

            {/* SLO methodology note */}
            <div className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-surface-900/60 border border-surface-800/50">
              <Shield className="w-4 h-4 text-brand-400 flex-shrink-0 mt-0.5" />
              <p className="text-2xs text-surface-500 leading-relaxed">
                <span className="text-surface-300 font-semibold">SLO:</span> 99.9% availability &middot;{' '}
                <span className="text-surface-300 font-semibold">Error budget:</span> 43.2 min/month (30d rolling) &middot;{' '}
                <span className="text-surface-300 font-semibold">Burn rate:</span> 1x = normal &middot; &gt;14.4x in 1h = fast burn &middot; &gt;6x in 6h = slow burn.
                {' '}SLI: replica availability via kube-state-metrics.
              </p>
            </div>

            {/* SLO cards grid */}
            {sla.length === 0 ? (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 px-4 py-12 text-center text-surface-500">No deployments found</div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {[...sla]
                  .sort((a, b) => {
                    const rank = (s: SlaService) => s.fastBurn ? 0 : s.slaStatus === 'breached' ? 1 : s.slowBurn ? 2 : s.slaStatus === 'at-risk' ? 3 : 4
                    return rank(a) - rank(b) || b.burnRate1h - a.burnRate1h
                  })
                  .map((svc, idx) => <SloCard key={`${svc.namespace}/${svc.name}`} svc={svc} idx={idx} onRefresh={refresh} />)}
              </div>
            )}

            {/* Fleet 30d compliance trend */}
            {fleetHistory.length > 2 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-white">Fleet Compliance Trend — 30d</h3>
                  <span className="text-2xs text-surface-500">Fleet average &middot; SLO target 99.9%</span>
                </div>
                <ResponsiveContainer width="100%" height={120}>
                  <AreaChart data={fleetHistory} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                    <defs>
                      <linearGradient id="grad-fleet-slo" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0}   />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis dataKey="ts" tickFormatter={(v: number) => format(new Date(v), 'MMM d')} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis domain={[99, 100]} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
                    <Tooltip content={<CustomTooltip unit="%" />} />
                    <ReferenceLine y={99.9} stroke="#6366f1" strokeDasharray="4 4" label={{ value: '99.9%', fill: '#6366f1', fontSize: 9, position: 'right' }} />
                    <Area type="monotone" dataKey="value" name="Fleet Availability" stroke="#22c55e" strokeWidth={2} fill="url(#grad-fleet-slo)" dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
        {/* -- CAPACITY -------------------------------------------------------- */}
        {tab === 'Capacity' && (
          <>
            {/* ETA cards */}
            <div className="grid grid-cols-2 gap-4">
              <div className={cn('rounded-2xl border p-4', infra.cpu.etaDays !== null ? 'bg-warning/5 border-warning/20' : 'bg-surface-900 border-surface-800')}>
                <p className="text-2xs text-surface-500 uppercase tracking-wider mb-1">CPU 80% Saturation ETA</p>
                <p className={cn('text-2xl font-black', infra.cpu.etaDays !== null ? 'text-warning' : 'text-success')}>
                  {infra.cpu.etaDays !== null ? `~${infra.cpu.etaDays}d` : 'No risk'}
                </p>
                <p className="text-xs text-surface-500 mt-1">
                  {infra.cpu.etaDays !== null
                    ? `Current trend reaches 80% in ~${infra.cpu.etaDays} days`
                    : `CPU at ${infra.cpu.current.toFixed(1)}% · well below saturation`}
                </p>
              </div>
              <div className={cn('rounded-2xl border p-4', infra.memory.etaDays !== null ? 'bg-warning/5 border-warning/20' : 'bg-surface-900 border-surface-800')}>
                <p className="text-2xs text-surface-500 uppercase tracking-wider mb-1">Memory 80% Saturation ETA</p>
                <p className={cn('text-2xl font-black', infra.memory.etaDays !== null ? 'text-warning' : 'text-success')}>
                  {infra.memory.etaDays !== null ? `~${infra.memory.etaDays}d` : 'No risk'}
                </p>
                <p className="text-xs text-surface-500 mt-1">
                  {infra.memory.etaDays !== null
                    ? `Current trend reaches 80% in ~${infra.memory.etaDays} days`
                    : `Memory at ${infra.memory.current.toFixed(1)}% · well below saturation`}
                </p>
              </div>
            </div>

            {/* CPU forecast */}
            <ForecastChart
              label="CPU Utilization · Actual + 48h Forecast"
              data={cpuFull}
              color="#6366f1"
              threshold={80}
              unit="%"
            />

            {/* Memory forecast */}
            <ForecastChart
              label="Memory Utilization · Actual + 48h Forecast"
              data={memFull}
              color="#06b6d4"
              threshold={85}
              unit="%"
            />

            <p className="text-2xs text-surface-600 text-center">
              Forecast uses linear regression on {data.windowLabel.toLowerCase()} of actual data. Predictions assume stable workload.
            </p>

          </>
        )}

        {/* -- LATENCY (p95) -------------------------------------------------- */}
        {tab === 'Latency (p95)' && (
          <>
            {!latData.hasData ? (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 px-6 py-16 text-center space-y-3">
                <Activity className="w-10 h-10 text-surface-700 mx-auto" />
                <p className="text-sm font-semibold text-surface-400">No latency data yet</p>
                <p className="text-xs text-surface-600 max-w-sm mx-auto">
                  nginx-ingress metrics are enabled and Prometheus is scraping. Latency histograms will appear automatically once HTTP traffic flows through an Ingress resource.
                </p>
                <button onClick={latRefresh} disabled={latLoading}
                  className="mx-auto flex items-center gap-2 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-300 transition-all">
                  <RefreshCw className={cn('w-3 h-3', latLoading && 'animate-spin')} /> Refresh
                </button>
              </div>
            ) : (
              <>
                {/* KPI strip */}
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                  {[
                    { label: 'p50 Latency',   val: latData.current.p50ms,  unit: 'ms', ok: (latData.current.p50ms ?? 0) < 200  },
                    { label: 'p95 Latency',   val: latData.current.p95ms,  unit: 'ms', ok: (latData.current.p95ms ?? 0) < 500  },
                    { label: 'p99 Latency',   val: latData.current.p99ms,  unit: 'ms', ok: (latData.current.p99ms ?? 0) < 1000 },
                    { label: 'Request Rate',  val: latData.current.rps,    unit: 'rps', ok: true },
                    { label: 'Error Rate',    val: latData.current.errRps, unit: 'err/s', ok: (latData.current.errRps ?? 0) === 0 },
                  ].map(({ label, val, unit, ok }) => (
                    <div key={label} className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                      <p className="text-2xs text-surface-500 uppercase tracking-wider font-medium">{label}</p>
                      <p className={cn('text-2xl font-black tabular-nums mt-1', ok ? 'text-success' : label.includes('Error') ? 'text-danger' : 'text-warning')}>
                        {val !== null ? val.toFixed(val < 10 ? 2 : 0) : '—'}
                      </p>
                      <p className="text-2xs text-surface-500 mt-0.5">{unit}</p>
                    </div>
                  ))}
                </div>

                {/* p50 / p95 / p99 history chart */}
                <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-white">Request Latency — {latData.windowLabel}</h3>
                    <div className="flex items-center gap-4 text-2xs text-surface-500">
                      <span className="flex items-center gap-1"><span className="w-4 h-0.5 inline-block bg-brand-400" /> p50</span>
                      <span className="flex items-center gap-1"><span className="w-4 h-0.5 inline-block bg-yellow-400" /> p95</span>
                      <span className="flex items-center gap-1"><span className="w-4 h-0.5 inline-block bg-red-400" /> p99</span>
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={latData.history.p95} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="ts" type="number" domain={['auto','auto']}
                        tickFormatter={(v: number) => format(new Date(v), latData.history.p95.length > 100 ? 'MMM d' : 'HH:mm')}
                        tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={v => `${v}ms`} />
                      <Tooltip content={<CustomTooltip unit="ms" />} />
                      <ReferenceLine y={200} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: '200ms', fill: '#f59e0b', fontSize: 8, position: 'right' }} />
                      <ReferenceLine y={500} stroke="#ef4444" strokeDasharray="3 3" label={{ value: '500ms', fill: '#ef4444', fontSize: 8, position: 'right' }} />
                      <Line data={latData.history.p50} type="monotone" dataKey="value" name="p50" stroke="#06b6d4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      <Line data={latData.history.p95} type="monotone" dataKey="value" name="p95" stroke="#facc15" strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line data={latData.history.p99} type="monotone" dataKey="value" name="p99" stroke="#f87171" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Request rate chart */}
                <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                  <h3 className="text-sm font-semibold text-white mb-3">Request Rate (req/s)</h3>
                  <ResponsiveContainer width="100%" height={120}>
                    <AreaChart data={latData.history.rps} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                      <defs>
                        <linearGradient id="rpsGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#06b6d4" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#06b6d4" stopOpacity={0}   />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="ts" tickFormatter={(v: number) => format(new Date(v), 'HH:mm')} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={v => `${v}rps`} />
                      <Tooltip content={<CustomTooltip unit=" req/s" />} />
                      <Area type="monotone" dataKey="value" name="RPS" stroke="#06b6d4" strokeWidth={2} fill="url(#rpsGrad)" dot={false} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Error rate chart */}
                {latData.history.err.length > 0 && (
                  <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                    <h3 className="text-sm font-semibold text-white mb-3">Error Rate (5xx / s)</h3>
                    <ResponsiveContainer width="100%" height={100}>
                      <AreaChart data={latData.history.err} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                        <defs>
                          <linearGradient id="errGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.25} />
                            <stop offset="95%" stopColor="#ef4444" stopOpacity={0}    />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="ts" tickFormatter={(v: number) => format(new Date(v), 'HH:mm')} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={v => `${v}`} />
                        <Tooltip content={<CustomTooltip unit=" err/s" />} />
                        <Area type="monotone" dataKey="value" name="Errors" stroke="#ef4444" strokeWidth={2} fill="url(#errGrad)" dot={false} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Per-ingress p95 table */}
                {latData.services.length > 0 && (
                  <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                    <h3 className="text-sm font-semibold text-white mb-3">Per-Ingress p95 Latency</h3>
                    <div className="space-y-2">
                      {latData.services.map(svc => (
                        <div key={`${svc.namespace}/${svc.ingress}`} className="flex items-center gap-3 py-2 border-b border-surface-800/50 last:border-0">
                          <div className="flex-1 min-w-0">
                            <p className="font-mono text-xs text-white truncate">{svc.ingress}</p>
                            <p className="text-2xs text-surface-500">{svc.namespace}{svc.service ? ` · ${svc.service}` : ''}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-24 h-1.5 rounded-full bg-surface-800 overflow-hidden">
                              <div className={cn('h-full rounded-full',
                                (svc.p95ms ?? 0) < 200 ? 'bg-success' :
                                (svc.p95ms ?? 0) < 500 ? 'bg-warning' : 'bg-danger')}
                                style={{ width: `${Math.min(100, ((svc.p95ms ?? 0) / 1000) * 100)}%` }} />
                            </div>
                            <span className={cn('text-xs font-mono font-bold tabular-nums w-16 text-right',
                              (svc.p95ms ?? 0) < 200 ? 'text-success' :
                              (svc.p95ms ?? 0) < 500 ? 'text-warning' : 'text-danger')}>
                              {svc.p95ms?.toFixed(0)}ms
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

      </div>
    </div>
  )
}

// -- Sub-components ---------------------------------------------------------

function budgetMinsLabel(mins: number): string {
  const m = Math.abs(mins)
  if (m < 1)       return '<1m'
  if (m < 60)      return `${Math.round(m)}m`
  const h = Math.floor(m / 60), rem = Math.round(m % 60)
  if (m < 24 * 60) return rem > 0 ? `${h}h ${rem}m` : `${h}h`
  const d = Math.floor(m / (24 * 60)), rh = Math.round((m % (24 * 60)) / 60)
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`
}

/** Format availability %: show '100' for perfect, otherwise up to 3 significant decimal places */
const fmtAvail = (v: number, decimals = 3) => v >= 100 ? '100' : v.toFixed(decimals)

function BurnRateBar({ label, rate, threshold }: { label: string; rate: number; threshold: number }) {
  const pct   = Math.min(100, (rate / (threshold * 2)) * 100)
  const isFast = rate > threshold
  const isElev = !isFast && rate > threshold / 3
  const exhaustHours = rate > 0 ? parseFloat((24 / rate).toFixed(1)) : null
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-2xs text-surface-500">{label}</span>
        <span className={cn('text-2xs font-mono font-bold',
          isFast ? 'text-danger' : isElev ? 'text-warning' : 'text-success')}>
          {rate > 0 ? `${rate.toFixed(1)}×` : '0×'}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-800 overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all',
            isFast ? 'bg-danger' : isElev ? 'bg-warning' : 'bg-success')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-2xs text-surface-600 mt-0.5 leading-tight">
        {isFast
          ? `Exhausts budget in ~${Math.max(1, Math.round((exhaustHours ?? 1) * 60))}m`
          : isElev
          ? 'Elevated — monitor closely'
          : 'Normal'}
      </p>
    </div>
  )
}

function SloCard({ svc, idx, onRefresh }: { svc: SlaService; idx: number; onRefresh?: () => void }) {
  const [editing, setEditing] = useState(false)
  const [targetVal, setTargetVal] = useState(String(svc.slaTarget))
  const [saving, setSaving] = useState(false)

  async function saveTarget() {
    const t = parseFloat(targetVal)
    if (isNaN(t) || t <= 0 || t > 100) return
    setSaving(true)
    await fetch('/api/analytics/slo-targets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `${svc.namespace}/${svc.name}`, target: t }),
    })
    setSaving(false)
    setEditing(false)
    onRefresh?.()
  }
  async function resetTarget() {
    await fetch('/api/analytics/slo-targets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `${svc.namespace}/${svc.name}` }),
    })
    onRefresh?.()
  }
  const budgetTotalMins = (1 - svc.slaTarget / 100) * 30 * 24 * 60
  const sparkColor = svc.avail30d >= svc.slaTarget
    ? '#22c55e'
    : svc.avail30d >= svc.slaTarget - 0.5 ? '#f59e0b' : '#ef4444'
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.04 }}
      className={cn('rounded-2xl border p-4 space-y-3',
        svc.fastBurn               ? 'bg-danger/5  border-danger/30' :
        svc.slowBurn               ? 'bg-warning/5 border-warning/20' :
        svc.slaStatus === 'breached' ? 'bg-danger/3  border-danger/20' :
        'bg-surface-900 border-surface-800')}>

      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-white truncate">{svc.name}</p>
          <p className="text-2xs text-surface-500">{svc.namespace}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 flex-wrap justify-end">
          {svc.fastBurn && (
            <span className="flex items-center gap-1 text-2xs px-1.5 py-0.5 bg-danger/15 text-danger border border-danger/30 rounded-full font-bold">
              <Flame className="w-3 h-3" /> FAST BURN
            </span>
          )}
          {svc.slowBurn && !svc.fastBurn && (
            <span className="text-2xs px-1.5 py-0.5 bg-warning/10 text-warning border border-warning/20 rounded-full font-semibold">
              Slow Burn
            </span>
          )}
          <span className={cn('text-2xs px-1.5 py-0.5 rounded-full border font-medium capitalize',
            svc.slaStatus === 'healthy'  ? 'bg-success/10 text-success border-success/20' :
            svc.slaStatus === 'at-risk'  ? 'bg-warning/10 text-warning border-warning/20' :
            'bg-danger/10 text-danger border-danger/20')}>
            {svc.slaStatus}
          </span>
          {editing ? (
            <div className="flex items-center gap-1">
              <input
                type="number" min="90" max="100" step="0.01"
                value={targetVal}
                onChange={e => setTargetVal(e.target.value)}
                className="w-20 text-xs bg-surface-800 border border-brand-500 rounded px-1.5 py-0.5 text-white tabular-nums focus:outline-none"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') saveTarget(); if (e.key === 'Escape') setEditing(false) }}
              />
              <button onClick={saveTarget} disabled={saving} className="p-0.5 text-success hover:bg-success/10 rounded"><Check className="w-3.5 h-3.5" /></button>
              <button onClick={() => setEditing(false)} className="p-0.5 text-surface-500 hover:bg-surface-700 rounded"><XIcon className="w-3.5 h-3.5" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setTargetVal(String(svc.slaTarget)); setEditing(true) }}
                className="group flex items-center gap-1 text-2xs px-1.5 py-0.5 bg-surface-800 text-surface-500 border border-surface-700 rounded-full hover:border-brand-500 hover:text-brand-400 transition-colors"
                title="Edit SLO target"
              >
                {svc.slaTarget}%
                <Pencil className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              {svc.slaTarget !== 99.9 && (
                <button
                  onClick={resetTarget}
                  className="text-2xs px-1 py-0.5 text-surface-600 hover:text-surface-400 rounded transition-colors"
                  title="Reset to default 99.9%"
                >
                  <XIcon className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 30d availability big number + sparkline */}
      <div className="flex items-end gap-4">
        <div className="flex-shrink-0">
          <p className="text-2xs text-surface-500 mb-0.5">30d Availability</p>
          <p className={cn('text-2xl font-black tabular-nums leading-none',
            svc.avail30d >= svc.slaTarget ? 'text-success' :
            svc.avail30d >= svc.slaTarget - 0.5 ? 'text-warning' : 'text-danger')}>
            {fmtAvail(svc.avail30d)}%
          </p>
          <p className="text-2xs text-surface-600 mt-0.5">
            target <span className="text-surface-400">{svc.slaTarget}%</span>
          </p>
        </div>
        <div className="flex-1" style={{ height: 44 }}>
          {(svc.historyPts ?? []).length > 2 ? (
            <ResponsiveContainer width="100%" height={44}>
              <LineChart data={svc.historyPts} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
                <Line type="monotone" dataKey="value" stroke={sparkColor} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <ReferenceLine y={svc.slaTarget} stroke="#475569" strokeDasharray="3 3" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-2xs text-surface-700 italic">No history yet</div>
          )}
        </div>
      </div>

      {/* Error budget bar */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-2xs text-surface-500">Error Budget (30d rolling)</span>
          <span className={cn('text-2xs font-semibold',
            svc.budgetRemainingMins <= 0  ? 'text-danger' :
            svc.budgetRemainingMins < budgetTotalMins * 0.2 ? 'text-warning' : 'text-success')}>
            {svc.budgetRemainingMins > 0
              ? `${budgetMinsLabel(svc.budgetRemainingMins)} remaining`
              : `Exhausted ${budgetMinsLabel(Math.abs(svc.budgetRemainingMins))} ago`}
          </span>
        </div>
        <div className="h-2 rounded-full bg-surface-800 overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all',
              svc.budgetUsedPct >= 100 ? 'bg-danger' :
              svc.budgetUsedPct >= 80  ? 'bg-warning' : 'bg-success')}
            style={{ width: `${Math.min(100, Math.max(0, svc.budgetUsedPct))}%` }}
          />
        </div>
        <div className="flex justify-between mt-0.5">
          <span className={cn('text-2xs', svc.budgetUsedPct >= 100 ? 'text-danger font-semibold' : 'text-surface-600')}>
            {svc.budgetUsedPct}% used{svc.budgetUsedPct > 100 ? ` (+${svc.budgetUsedPct - 100}% over)` : ''}
          </span>
          <span className="text-2xs text-surface-600">{budgetTotalMins.toFixed(0)}m total</span>
        </div>
      </div>

      {/* Burn rates */}
      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-surface-800/50">
        <BurnRateBar label="1h burn rate" rate={svc.burnRate1h} threshold={14.4} />
        <BurnRateBar label="6h burn rate" rate={svc.burnRate6h} threshold={6} />
      </div>

      {/* Multi-window availability + replicas footer */}
      <div className="flex items-center justify-between text-2xs text-surface-600 pt-1 border-t border-surface-800/50">
        <span className="flex items-center gap-1"><Server className="w-3 h-3" /> {svc.available}/{svc.desired} replicas</span>
        <span>1h: <span className="font-mono text-surface-400">{fmtAvail(svc.avail1h, 2)}%</span></span>
        <span>Now: <span className="font-mono text-surface-400">{fmtAvail(svc.availability, 2)}%</span></span>
      </div>
    </motion.div>
  )
}

function InfraChart({ label, history, current, avg, peak, unit, color, threshold }: {
  label: string; history: TsPoint[]; current: number; avg: number; peak: number
  unit: string; color: string; threshold: number
}) {
  const spanMs = history.length >= 2 ? history[history.length - 1]!.ts - history[0]!.ts : 0
  const xFmt = spanMs > 2 * 24 * 3600 * 1000
    ? (v: number) => format(new Date(v), 'MMM d')
    : (v: number) => format(new Date(v), 'HH:mm')
  return (
    <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">{label}</h3>
        <div className="flex items-center gap-3 text-2xs text-surface-500">
          <span>Now: <span className="text-white font-bold">{current.toFixed(1)}{unit}</span></span>
          <span>Avg: <span className="text-surface-300">{avg.toFixed(1)}{unit}</span></span>
          <span>Peak: <span className={peak >= threshold ? 'text-warning' : 'text-surface-300'}>{peak.toFixed(1)}{unit}</span></span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <AreaChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
          <defs>
            <linearGradient id={`grad-${label.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0}    />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis dataKey="ts" tickFormatter={xFmt} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} />
          <Tooltip content={<CustomTooltip unit={unit} />} />
          <ReferenceLine y={threshold} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: `${threshold}%`, fill: '#f59e0b', fontSize: 9, position: 'right' }} />
          <Area type="monotone" dataKey="value" name={label.split(' ')[0]} stroke={color} strokeWidth={2} fill={`url(#grad-${label.replace(/\s/g, '')})`} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function ForecastChart({ label, data, color, threshold, unit }: {
  label: string; data: (TsPoint & { forecast?: boolean })[]; color: string; threshold: number; unit: string
}) {
  const actual   = data.filter(p => !p.forecast)
  const forecast = data.filter(p => p.forecast)
  const split    = actual.length > 0 ? actual[actual.length - 1] : null
  const forecastWithBridge = split ? [{ ...split, forecast: true }, ...forecast] : forecast
  const spanMs = data.length >= 2 ? data[data.length - 1]!.ts - data[0]!.ts : 0
  const xFmt = spanMs > 2 * 24 * 3600 * 1000
    ? (v: number) => format(new Date(v), 'MMM d')
    : (v: number) => format(new Date(v), 'HH:mm')

  return (
    <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
      <h3 className="text-sm font-semibold text-white mb-3">{label}</h3>
      <div className="flex items-center gap-4 text-2xs text-surface-500 mb-3">
        <span className="flex items-center gap-1"><span className="w-6 h-0.5 inline-block" style={{ background: color }} /> Actual</span>
        <span className="flex items-center gap-1"><span className="w-6 h-0.5 inline-block border-t-2 border-dashed" style={{ borderColor: color }} /> Forecast (48h)</span>
        <span className="flex items-center gap-1"><span className="w-6 h-0.5 inline-block border-t border-dashed border-warning" /> {threshold}% threshold</span>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
          <defs>
            <linearGradient id={`fcast-${label.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.2} />
              <stop offset="95%" stopColor={color} stopOpacity={0}   />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis dataKey="ts" type="number" domain={['auto', 'auto']} tickFormatter={xFmt} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} />
          <Tooltip content={<CustomTooltip unit={unit} />} />
          <ReferenceLine y={threshold} stroke="#f59e0b" strokeDasharray="4 4" />
          <Area data={actual} type="monotone" dataKey="value" name="Actual" stroke={color} strokeWidth={2} fill={`url(#fcast-${label.replace(/\s/g, '')})`} dot={false} isAnimationActive={false} />
          <Area data={forecastWithBridge} type="monotone" dataKey="value" name="Forecast" stroke={color} strokeWidth={1.5} strokeDasharray="5 3" fill="none" dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsInner />
    </Suspense>
  )
}
