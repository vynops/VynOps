'use client'

import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  GitCommit, AlertTriangle, CheckCircle2, XCircle, RotateCcw,
  Clock, User, Search, ChevronRight, Rocket, GitBranch, Zap,
  TrendingUp, ArrowUpRight, Package, Loader2, ScrollText,
  FileSearch, FileCode2, Activity, RefreshCw, BarChart3, Download,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { LogViewer } from '@/components/k8s/LogViewer'
import { DescribeViewer } from '@/components/k8s/DescribeViewer'
import { YamlViewer } from '@/components/k8s/YamlViewer'
import type { DeploymentEvent } from '@/types'
import { cn, exportCSV } from '@/lib/utils'
import { formatDistanceToNow, format, isToday, isYesterday, subDays, isWithinInterval } from 'date-fns'
import { useLiveData } from '@/hooks/useLiveData'
import { getClusterHeaders, useDashboardStore } from '@/store'

// -- Helpers -------------------------------------------------------------------

/** Deterministic color from any string � gives every service a consistent colour */
function serviceColor(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const palette = [
    'bg-blue-500/15 text-blue-300 border-blue-500/30',
    'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    'bg-violet-500/15 text-violet-300 border-violet-500/30',
    'bg-orange-500/15 text-orange-300 border-orange-500/30',
    'bg-pink-500/15 text-pink-300 border-pink-500/30',
    'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
    'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
    'bg-rose-500/15 text-rose-300 border-rose-500/30',
    'bg-teal-500/15 text-teal-300 border-teal-500/30',
    'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    'bg-amber-500/15 text-amber-300 border-amber-500/30',
    'bg-lime-500/15 text-lime-300 border-lime-500/30',
  ]
  return palette[h % palette.length]
}

const METHOD_LABELS: Record<string, string> = { rolling: 'Rolling', canary: 'Canary', 'blue-green': 'Blue-Green', recreate: 'Recreate' }
const METHOD_COLORS: Record<string, string>  = {
  rolling:      'text-brand-400 bg-brand-500/10',
  canary:       'text-success bg-success/10',
  'blue-green': 'text-blue-400 bg-blue-500/10',
  recreate:     'text-warning bg-warning/10',
}

const BAND_COLOR: Record<string, string> = {
  elite:  'text-success',
  high:   'text-brand-400',
  medium: 'text-warning',
  low:    'text-danger',
}

function statusIcon(status: DeploymentEvent['status'], size = 'w-4 h-4') {
  if (status === 'success')     return <CheckCircle2 className={cn(size, 'text-success')} />
  if (status === 'failed')      return <XCircle className={cn(size, 'text-danger')} />
  if (status === 'in-progress') return <Zap className={cn(size, 'text-brand-400 animate-pulse')} />
  if (status === 'rolled-back') return <RotateCcw className={cn(size, 'text-warning')} />
  return null
}

function riskBadge(score: number) {
  if (score >= 70) return <span className="text-2xs font-bold px-1.5 py-0.5 rounded-full bg-danger/15 text-danger border border-danger/30">Risk {score}</span>
  if (score >= 40) return <span className="text-2xs font-bold px-1.5 py-0.5 rounded-full bg-warning/15 text-warning border border-warning/30">Risk {score}</span>
  return <span className="text-2xs px-1.5 py-0.5 rounded-full bg-success/10 text-success border border-success/20">Risk {score}</span>
}

function groupByDay(deploys: DeploymentEvent[]) {
  const groups: { label: string; items: DeploymentEvent[] }[] = []
  const now = new Date()
  const buckets = [
    { label: 'Today',        test: (d: Date) => isToday(d) },
    // B1: use rolling windows so there are no calendar-boundary gaps
    { label: 'Yesterday',    test: (d: Date) => !isToday(d) && d.getTime() > subDays(now, 2).getTime() },
    { label: '2 days ago',   test: (d: Date) => d.getTime() <= subDays(now, 2).getTime() && d.getTime() > subDays(now, 3).getTime() },
    { label: '3 days ago',   test: (d: Date) => d.getTime() <= subDays(now, 3).getTime() && d.getTime() > subDays(now, 4).getTime() },
    { label: '4 days ago',   test: (d: Date) => d.getTime() <= subDays(now, 4).getTime() && d.getTime() > subDays(now, 5).getTime() },
    { label: '5 days ago',   test: (d: Date) => d.getTime() <= subDays(now, 5).getTime() && d.getTime() > subDays(now, 6).getTime() },
    { label: '6–7 days ago', test: (d: Date) => isWithinInterval(d, { start: subDays(now, 8), end: subDays(now, 6) }) },
    { label: 'Older',        test: (d: Date) => d < subDays(now, 8) },
  ]
  for (const b of buckets) {
    const items = deploys.filter(d => b.test(new Date(d.startedAt)))
    if (items.length) groups.push({ label: b.label, items })
  }
  return groups
}

function fmtDuration(s: number) {
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// -- Deploy row ----------------------------------------------------------------

function DeployRow({ dep, selected, onSelect }: { dep: DeploymentEvent; selected: boolean; onSelect: () => void }) {
  const isBroken = !!dep.linkedIncidentId
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      onClick={onSelect}
      className={cn(
        'flex items-start gap-3 px-4 py-3 cursor-pointer transition-all border-l-2',
        selected    ? 'bg-brand-500/10 border-l-brand-500'
        : isBroken  ? 'bg-danger/5 border-l-danger hover:bg-danger/10'
        : 'border-l-transparent hover:bg-surface-800/60',
      )}
    >
      <div className="mt-0.5 flex-shrink-0">{statusIcon(dep.status)}</div>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('text-2xs font-semibold px-2 py-0.5 rounded-full border', serviceColor(dep.service))}>{dep.service}</span>
          <span className="text-sm font-mono font-semibold text-white">{dep.version}</span>
          {isBroken && (
            <span className="flex items-center gap-1 text-2xs font-bold px-2 py-0.5 rounded-full bg-danger text-white animate-pulse">
              <AlertTriangle className="w-2.5 h-2.5" /> BROKE IT · {dep.linkedIncidentId?.toUpperCase()}
            </span>
          )}
          {dep.rollbackOf && (
            <span className="flex items-center gap-1 text-2xs font-semibold px-2 py-0.5 rounded-full bg-warning/15 text-warning border border-warning/30">
              <RotateCcw className="w-2.5 h-2.5" /> Rollback
            </span>
          )}
          {riskBadge(dep.riskScore)}
        </div>
        <div className="flex items-center gap-3 text-2xs text-surface-400 flex-wrap">
          <span className="flex items-center gap-1"><User className="w-3 h-3" />{dep.deployer}</span>
          <span className="font-mono text-surface-600">{dep.namespace}</span>
          {dep.branch !== '—' && <span className="flex items-center gap-1"><GitBranch className="w-3 h-3" />{dep.branch}</span>}
          <span className={cn('px-1.5 py-0.5 rounded font-medium', METHOD_COLORS[dep.method] ?? 'text-surface-400 bg-surface-800')}>{METHOD_LABELS[dep.method] ?? dep.method}</span>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{dep.isEstimated ? '\u007e' : ''}{fmtDuration(dep.durationSeconds)}</span>
          <span className="flex items-center gap-1 text-surface-500"><GitCommit className="w-3 h-3" />{dep.commitSha.slice(0, 7)}</span>
          <span suppressHydrationWarning className="text-surface-500 ml-auto">{formatDistanceToNow(new Date(dep.startedAt), { addSuffix: true })}</span>
        </div>
        {/* Replica progress for in-progress */}
        {dep.status === 'in-progress' && dep.replicas.desired > 0 && (
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1 bg-surface-700 rounded-full overflow-hidden">
              <div className="h-full bg-brand-500 rounded-full transition-all"
                style={{ width: `${Math.round(dep.replicas.ready / dep.replicas.desired * 100)}%` }} />
            </div>
            <span className="text-2xs text-brand-400 tabular-nums">{dep.replicas.ready}/{dep.replicas.desired} ready</span>
          </div>
        )}
      </div>
      <ChevronRight className={cn('w-4 h-4 text-surface-600 flex-shrink-0 mt-0.5 transition-transform', selected && 'rotate-90')} />
    </motion.div>
  )
}

// -- Detail panel --------------------------------------------------------------

function DeployDetail({ dep, onViewLogs, onDescribe, onViewYaml, onViewTraces }: {
  dep: DeploymentEvent
  onViewLogs: (pod: string, namespace: string) => void
  onDescribe: (kind: string, namespace: string, name: string) => void
  onViewYaml: (kind: string, namespace: string, name: string) => void
  onViewTraces: (service: string) => void
}) {
  const [rolling, setRolling]       = useState(false)
  const [rollResult, setRollResult]   = useState<{ ok: boolean; msg: string } | null>(null)
  const [podLoading, setPodLoading]   = useState(false)
  const [restarting, setRestarting]   = useState(false)
  const [restartResult, setRestartResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [revisions, setRevisions]     = useState<any[]>([])
  const [revLoading, setRevLoading]   = useState(false)
  const [showRevisions, setShowRevisions] = useState(false)

  const handleViewLogs = async () => {
    setPodLoading(true)
    try {
      const r = await fetch(`/api/k8s/pods?namespace=${encodeURIComponent(dep.namespace)}`, { headers: getClusterHeaders() })
      const j = await r.json()
      const pods: any[] = j.pods ?? []
      const pod = pods.find(p => p.name.startsWith(dep.service) && p.status === 'Running')
             ?? pods.find(p => p.name.startsWith(dep.service))
      onViewLogs(pod?.name ?? dep.service, dep.namespace)
    } catch { onViewLogs(dep.service, dep.namespace) }
    finally { setPodLoading(false) }
  }

  const handleRollback = async () => {
    setRolling(true); setRollResult(null)
    try {
      const res  = await fetch(`/api/k8s/deployments/${dep.namespace}/${dep.service}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getClusterHeaders() },
        body: JSON.stringify({ rsName: dep.previousRsName }),
      })
      const data = await res.json()
      setRollResult({ ok: res.ok, msg: data.message ?? data.error ?? 'Unknown response' })
    } catch (e) { setRollResult({ ok: false, msg: String(e) }) }
    finally { setRolling(false) }
  }

  // M3: rollback to any specific RS revision
  const handleRollbackTo = async (rsName: string) => {
    setRolling(true); setRollResult(null)
    try {
      const res  = await fetch(`/api/k8s/deployments/${dep.namespace}/${dep.service}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getClusterHeaders() },
        body: JSON.stringify({ rsName }),
      })
      const data = await res.json()
      setRollResult({ ok: res.ok, msg: data.message ?? data.error ?? 'Unknown' })
    } catch (e) { setRollResult({ ok: false, msg: String(e) }) }
    finally { setRolling(false) }
  }

  // M1: rolling restart
  const handleRestart = async () => {
    setRestarting(true); setRestartResult(null)
    try {
      const res  = await fetch(`/api/k8s/deployments/${dep.namespace}/${dep.service}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getClusterHeaders() },
      })
      const data = await res.json()
      setRestartResult({ ok: res.ok, msg: data.message ?? data.error ?? (res.ok ? 'Restart initiated' : 'Unknown error') })
    } catch (e) { setRestartResult({ ok: false, msg: String(e) }) }
    finally { setRestarting(false) }
  }

  // M3: load revision history from API
  const handleLoadRevisions = async () => {
    if (revisions.length > 0) { setShowRevisions(v => !v); return }
    setRevLoading(true)
    try {
      const res  = await fetch(`/api/k8s/deployments/${dep.namespace}/${dep.service}/history`, {
        headers: getClusterHeaders(),
      })
      const data = await res.json()
      setRevisions(data.revisions ?? [])
      setShowRevisions(true)
    } catch { setRevisions([]) }
    finally { setRevLoading(false) }
  }

  return (
    <div className="space-y-5 p-5">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {statusIcon(dep.status, 'w-5 h-5')}
          <span className="text-white font-bold text-base">{dep.service}</span>
          <span className="font-mono text-brand-400 font-semibold">{dep.version}</span>
        </div>
          <span suppressHydrationWarning className="text-xs text-surface-400">
            {format(new Date(dep.startedAt), 'MMM d, HH:mm:ss')} &middot; {dep.cluster} &middot; {dep.namespace}
          </span>
        {dep.linkedIncidentId && (
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-danger/10 border border-danger/20 text-sm text-danger">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>Correlated with incident <strong>{dep.linkedIncidentId.toUpperCase()}</strong></span>
          </div>
        )}
        {dep.rollbackOf && (
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-warning/10 border border-warning/20 text-xs text-warning">
            <RotateCcw className="w-3.5 h-3.5 flex-shrink-0" /> Rollback of {dep.rollbackOf}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: 'Replicas',   value: `${dep.replicas.ready}/${dep.replicas.desired}`, ok: dep.replicas.ready === dep.replicas.desired },
          { label: 'Duration',   value: `${dep.isEstimated ? '\u007e' : ''}${fmtDuration(dep.durationSeconds)}`, ok: dep.durationSeconds < 600 },
          { label: 'Method',     value: METHOD_LABELS[dep.method] ?? dep.method, ok: true },
          { label: 'Risk Score', value: `${dep.riskScore}/100`, ok: dep.riskScore < 40 },
        ].map(s => (
          <div key={s.label} className="flex flex-col gap-0.5 px-3 py-2.5 rounded-xl bg-surface-950 border border-surface-800">
            <span className="text-2xs text-surface-500">{s.label}</span>
            <span className={cn('text-sm font-bold', s.ok ? 'text-white' : 'text-danger')}>{s.value}</span>
          </div>
        ))}
      </div>

      {/* Changes */}
      <div>
        <p className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">Changes ({dep.changes.length})</p>
        <div className="space-y-1.5">
          {dep.changes.map((c, i) => (
            <div key={i} className="rounded-xl bg-surface-950 border border-surface-800 p-3 text-xs space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-2xs px-1.5 py-0.5 rounded bg-surface-800 text-surface-400 uppercase font-semibold">{c.type}</span>
                <span className="font-mono text-surface-300 font-medium truncate">{c.field}</span>
              </div>
              <div className="font-mono space-y-0.5">
                <div className="text-danger opacity-70 truncate">- {c.from}</div>
                <div className="text-success truncate">+ {c.to}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Meta */}
      <div className="text-xs text-surface-500 space-y-1.5 pt-2 border-t border-surface-800">
        <div className="flex justify-between"><span>Namespace</span><span className="text-surface-300 font-mono">{dep.namespace}</span></div>
        <div className="flex justify-between"><span>Environment</span><span className="text-surface-300 capitalize">{dep.environment}</span></div>
        <div className="flex justify-between"><span>Deployer</span><span className="text-surface-300 font-mono">{dep.deployer}</span></div>
        <div className="flex justify-between"><span>Commit</span><span className="text-surface-300 font-mono">{dep.commitSha}</span></div>
        <div className="flex justify-between"><span>Branch</span><span className="text-surface-300 font-mono">{dep.branch}</span></div>
      </div>

      {/* Quick actions */}
      <div className="space-y-2 pt-3 border-t border-surface-800">
        <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider mb-2">Quick Actions</p>
        <div className="grid grid-cols-2 gap-1.5">
          <button onClick={handleViewLogs} disabled={podLoading}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-800 hover:bg-surface-700 border border-surface-700 text-xs text-surface-300 hover:text-white transition-all disabled:opacity-50">
            {podLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScrollText className="w-3.5 h-3.5 text-brand-400" />}
            View Logs
          </button>
          <button onClick={() => onDescribe('Deployment', dep.namespace, dep.service)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-800 hover:bg-surface-700 border border-surface-700 text-xs text-surface-300 hover:text-white transition-all">
            <FileSearch className="w-3.5 h-3.5 text-brand-400" /> Describe
          </button>
          <button onClick={() => onViewYaml('Deployment', dep.namespace, dep.service)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-800 hover:bg-surface-700 border border-surface-700 text-xs text-surface-300 hover:text-white transition-all">
            <FileCode2 className="w-3.5 h-3.5 text-brand-400" /> View YAML
          </button>
          <button onClick={() => onViewTraces(dep.service)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-800 hover:bg-surface-700 border border-surface-700 text-xs text-surface-300 hover:text-white transition-all">
            <Activity className="w-3.5 h-3.5 text-brand-400" /> View Traces
          </button>
          {/* M1: Restart */}
          <button onClick={handleRestart} disabled={restarting}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-800 hover:bg-surface-700 border border-surface-700 text-xs text-surface-300 hover:text-white transition-all disabled:opacity-50">
            {restarting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 text-warning" />}
            Restart
          </button>
          {/* M3: Revision History toggle */}
          <button onClick={handleLoadRevisions} disabled={revLoading}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-800 hover:bg-surface-700 border border-surface-700 text-xs text-surface-300 hover:text-white transition-all disabled:opacity-50">
            {revLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCommit className="w-3.5 h-3.5 text-brand-400" />}
            {showRevisions ? 'Hide History' : 'Revision History'}
          </button>
        </div>
        {restartResult && (
          <div className={cn('text-xs px-3 py-2 rounded-xl border', restartResult.ok ? 'bg-success/10 border-success/30 text-success' : 'bg-danger/10 border-danger/30 text-danger')}>
            {restartResult.msg}
          </div>
        )}
      </div>

      {/* Rollback & Revision History */}
      <div className="pt-3 border-t border-surface-800 space-y-2">
        {rollResult && (
          <div className={cn('text-xs px-3 py-2 rounded-xl border', rollResult.ok ? 'bg-success/10 border-success/30 text-success' : 'bg-danger/10 border-danger/30 text-danger')}>
            {rollResult.msg}
          </div>
        )}
        {dep.status !== 'rolled-back' && dep.previousRsName && (
          <button onClick={handleRollback} disabled={rolling}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-warning/10 hover:bg-warning/20 border border-warning/30 rounded-xl text-sm text-warning font-medium transition-all disabled:opacity-60">
            {rolling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            {rolling ? 'Rolling back…' : `Rollback to ${dep.previousVersion}`}
          </button>
        )}
        {/* M3: Revision picker */}
        {showRevisions && revisions.length > 0 && (
          <div className="rounded-xl border border-surface-800 overflow-hidden">
            <div className="px-3 py-2 bg-surface-950 border-b border-surface-800 text-2xs font-semibold text-surface-500 uppercase tracking-wider">
              Revision history — click ↩ to rollback
            </div>
            <div className="divide-y divide-surface-800/40 max-h-52 overflow-y-auto">
              {revisions.map((r: any) => (
                <div key={r.revision} className={cn('flex items-center gap-2 px-3 py-2 hover:bg-surface-800/40', r.current && 'bg-success/5')}>
                  <span className={cn('text-2xs px-1.5 py-0.5 rounded-full border font-semibold flex-shrink-0',
                    r.current ? 'bg-success/10 text-success border-success/20' : 'bg-surface-800 text-surface-400 border-surface-700'
                  )}>r{r.revision}</span>
                  <span className="font-mono text-2xs text-surface-300 flex-1 truncate" title={r.image}>{r.imageTag}</span>
                  <span className="text-2xs text-surface-600 flex-shrink-0">{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</span>
                  {!r.current && (
                    <button onClick={() => handleRollbackTo(r.rsName)} disabled={rolling}
                      className="flex-shrink-0 text-2xs px-2 py-0.5 rounded bg-warning/10 text-warning border border-warning/20 hover:bg-warning/20 transition-all disabled:opacity-50">
                      ↩ Use
                    </button>
                  )}
                  {r.current && <span className="text-2xs text-success flex-shrink-0 font-semibold">current</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {showRevisions && revisions.length === 0 && !revLoading && (
          <p className="text-2xs text-surface-600 italic text-center py-2">No revision history available</p>
        )}
      </div>
    </div>
  )
}

// -- Main page -----------------------------------------------------------------

type DoraMetrics = {
  deployFrequency7d: number; deployFrequency30d: number
  changeFailureRate: number; successRate: number
  totalDeploys: number; serviceCount: number; inProgress: number
  frequencyBand: string; cfrBand: string
}

const EMPTY_DORA: DoraMetrics = {
  deployFrequency7d: 0, deployFrequency30d: 0, changeFailureRate: 0,
  successRate: 0, totalDeploys: 0, serviceCount: 0, inProgress: 0,
  frequencyBand: 'low', cfrBand: 'elite',
}

export default function DeploymentsPage() {
  const { activeCluster } = useDashboardStore()
  const router = useRouter()
  const [search, setSearch]         = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [envFilter, setEnvFilter]   = useState<string>('all')
  const [selected, setSelected]     = useState<DeploymentEvent | null>(null)
  const [logTarget, setLogTarget]   = useState<{ pod: string; namespace: string } | null>(null)
  const [describeTarget, setDescribeTarget] = useState<{ kind: string; namespace: string; name: string } | null>(null)
  const [yamlTarget, setYamlTarget] = useState<{ kind: string; namespace: string; name: string } | null>(null)

  const { data: liveData, loading: historyLoading, refresh, isLive, error } = useLiveData(
    '/api/k8s/deployments-history',
    { events: [] as DeploymentEvent[], dora: EMPTY_DORA },
    (r) => ({
      events: (r.events ?? []) as DeploymentEvent[],
      dora:   (r.dora ?? EMPTY_DORA) as DoraMetrics,
    }),
  )
  const deploymentHistory = liveData.events
  const dora = liveData.dora

  const filtered = useMemo(() => deploymentHistory.filter(d => {
    const q           = search.toLowerCase()
    const matchSearch = !q || d.service.includes(q) || d.version.includes(q) || d.deployer.includes(q) || d.branch.toLowerCase().includes(q) || d.namespace.includes(q)
    const matchStatus = statusFilter === 'all' || d.status === statusFilter
    const matchEnv    = envFilter === 'all'    || d.environment === envFilter
    return matchSearch && matchStatus && matchEnv
  }), [search, statusFilter, envFilter, deploymentHistory])

  const groups = useMemo(() => groupByDay(filtered), [filtered])

  // KPIs from live data
  const todayDeploys = deploymentHistory.filter(d => isToday(new Date(d.startedAt)))
  const failedCount  = deploymentHistory.filter(d => d.status === 'failed').length

  const STATUS_FILTERS = [
    { label: 'All',         value: 'all',         count: deploymentHistory.length },
    { label: 'Success',     value: 'success',     count: deploymentHistory.filter(d => d.status === 'success').length },
    { label: 'Failed',      value: 'failed',      count: failedCount },
    { label: 'In Progress', value: 'in-progress', count: dora.inProgress },
    { label: 'Rolled Back', value: 'rolled-back', count: deploymentHistory.filter(d => d.rollbackOf).length },
  ]

  const ENV_FILTERS = [
    { label: 'All Envs',    value: 'all' },
    { label: 'Production',  value: 'production' },
    { label: 'Staging',     value: 'staging' },
    { label: 'Development', value: 'development' },
  ]

  // -- DORA band tooltip labels ------------------------------------------------
  const freqLabel = { elite: '=1/day (Elite)', high: '1-6/week (High)', medium: '1-4/month (Medium)', low: '<1/month (Low)' }
  const cfrLabel  = { elite: '<5% (Elite)', high: '5-15% (High)', medium: '15-30% (Medium)', low: '>30% (Low)' }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800 flex-shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Rocket className="w-5 h-5 text-brand-400" />
            Deployments
            {historyLoading && <RefreshCw className="w-3.5 h-3.5 text-surface-500 animate-spin" />}
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">
            {activeCluster && <><span className="text-surface-300 font-medium">{activeCluster.name ?? activeCluster.displayName}</span>{' · '}</>}Change history from K8s ReplicaSets · {dora.serviceCount} services
            {isLive && <span className="ml-2 text-success">● Live</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="service, namespace, deployer…"
              className="w-56 bg-surface-800 border border-surface-700 rounded-xl pl-8 pr-3 py-1.5 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500" />
          </div>
          <button onClick={refresh} title="Refresh"
            className="p-1.5 rounded-xl border border-surface-700 text-surface-500 hover:text-white hover:border-surface-500 transition-all">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {/* M4: CSV export */}
          <button onClick={() => exportCSV(filtered.map(d => ({
            id: d.id, service: d.service, version: d.version, status: d.status,
            environment: d.environment, namespace: d.namespace, deployer: d.deployer,
            method: d.method, risk_score: d.riskScore, duration_s: d.durationSeconds,
            started_at: d.startedAt, branch: d.branch, commit: d.commitSha,
          })), 'deployments.csv')} title="Export CSV"
            className="p-1.5 rounded-xl border border-surface-700 text-surface-500 hover:text-white hover:border-surface-500 transition-all">
            <Download className="w-3.5 h-3.5" />
          </button>
          {error && (
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-warning/5 border border-warning/20 rounded-xl text-xs text-warning/80">
              <AlertTriangle className="w-3 h-3" /> {error}
            </span>
          )}
        </div>
      </div>

      {/* DORA Metrics Panel */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px border-b border-surface-800 bg-surface-800 flex-shrink-0">
        {[
          {
            label: 'Deploy Frequency',
            value: dora.deployFrequency7d > 0 ? `${dora.deployFrequency7d}/day` : `${dora.deployFrequency30d}/day`,
            sub:   (freqLabel as any)[dora.frequencyBand] ?? dora.frequencyBand,
            icon: <BarChart3 className="w-7 h-7" />,
            color: BAND_COLOR[dora.frequencyBand] ?? 'text-surface-400',
          },
          {
            label: 'Success Rate',
            value: `${dora.successRate}%`,
            sub:   `${dora.totalDeploys} total · ${failedCount} failed`,
            icon: <CheckCircle2 className="w-7 h-7" />,
            color: dora.successRate >= 95 ? 'text-success' : dora.successRate >= 80 ? 'text-warning' : 'text-danger',
          },
          {
            label: 'Change Failure Rate',
            value: `${dora.changeFailureRate}%`,
            sub:   (cfrLabel as any)[dora.cfrBand] ?? dora.cfrBand,
            icon: <AlertTriangle className="w-7 h-7" />,
            color: BAND_COLOR[dora.cfrBand] ?? 'text-surface-400',
          },
          {
            label: 'Deploys Today',
            value: todayDeploys.length,
            sub:   `${dora.inProgress} in progress · ${dora.serviceCount} services`,
            icon: <TrendingUp className="w-7 h-7" />,
            color: 'text-brand-400',
          },
        ].map(k => (
          <div key={k.label} className="bg-surface-950 px-5 py-3 flex items-center gap-3">
            <span className={cn('flex-shrink-0 opacity-70', k.color)}>{k.icon}</span>
            <div>
              <div className={cn('text-xl font-bold tabular-nums', k.color)}>{k.value}</div>
              <div className="text-2xs text-surface-500">{k.label}</div>
              <div className="text-2xs text-surface-600 mt-0.5">{k.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-2 px-3 sm:px-6 py-2 border-b border-surface-800 bg-surface-950 flex-shrink-0 flex-wrap">
        {/* Status filters */}
        {STATUS_FILTERS.map(f => (
          <button key={f.value} onClick={() => setStatusFilter(f.value)}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all',
              statusFilter === f.value
                ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30'
                : 'text-surface-400 hover:text-surface-300 hover:bg-surface-800')}>
            {f.label}
            <span className={cn('text-2xs px-1.5 py-0.5 rounded-full', statusFilter === f.value ? 'bg-brand-500/20 text-brand-400' : 'bg-surface-800 text-surface-500')}>
              {f.count}
            </span>
          </button>
        ))}

        <div className="w-px h-5 bg-surface-700 mx-1" />

        {/* Environment filters */}
        {ENV_FILTERS.map(f => (
          <button key={f.value} onClick={() => setEnvFilter(f.value)}
            className={cn('px-3 py-1.5 rounded-xl text-xs font-medium transition-all',
              envFilter === f.value
                ? 'bg-surface-700 text-white border border-surface-600'
                : 'text-surface-500 hover:text-surface-300 hover:bg-surface-800')}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Timeline */}
        <div className="flex-1 overflow-y-auto scrollbar-none">
          {historyLoading && deploymentHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-surface-500 gap-3">
              <RefreshCw className="w-8 h-8 animate-spin opacity-40" />
              <p className="text-sm">Loading deployment history...</p>
            </div>
          ) : groups.length > 0 ? (
            groups.map(group => (
              <div key={group.label}>
                <div className="sticky top-0 px-4 py-2 bg-surface-900/90 backdrop-blur-sm border-b border-surface-800 z-10">
                  <span className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">{group.label}</span>
                  <span className="ml-2 text-2xs text-surface-600">{group.items.length} deploy{group.items.length > 1 ? 's' : ''}</span>
                </div>
                {group.items.map(dep => (
                  <DeployRow key={dep.id} dep={dep} selected={selected?.id === dep.id}
                    onSelect={() => setSelected(dep.id === selected?.id ? null : dep)} />
                ))}
              </div>
            ))
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-surface-500">
              <Package className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">No deployments match your filters</p>
              <p className="text-xs mt-1 text-surface-600">Try adjusting the status or environment filter</p>
            </div>
          )}
        </div>

        {/* Detail panel */}
        <AnimatePresence>
          {selected && (
            <motion.div
              initial={{ width: 0, opacity: 0 }} animate={{ width: 340, opacity: 1 }} exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="border-l border-surface-800 bg-surface-900 overflow-y-auto scrollbar-none flex-shrink-0">
              <div className="sticky top-0 px-4 py-3 border-b border-surface-800 bg-surface-900 flex items-center justify-between">
                <span className="text-sm font-semibold text-white">Deploy Details</span>
                <button onClick={() => setSelected(null)} className="text-surface-500 hover:text-white text-lg leading-none">&times;</button>
              </div>
              <DeployDetail dep={selected}
                onViewLogs={(pod, ns) => setLogTarget({ pod, namespace: ns })}
                onDescribe={(kind, ns, name) => setDescribeTarget({ kind, namespace: ns, name })}
                onViewYaml={(kind, ns, name) => setYamlTarget({ kind, namespace: ns, name })}
                onViewTraces={(svc) => router.push(`/observability?tab=Traces&service=${encodeURIComponent(svc)}`)} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Modals */}
      {logTarget      && <LogViewer     pod={logTarget.pod} namespace={logTarget.namespace} onClose={() => setLogTarget(null)} />}
      {describeTarget && <DescribeViewer kind={describeTarget.kind} namespace={describeTarget.namespace} name={describeTarget.name} onClose={() => setDescribeTarget(null)} />}
      {yamlTarget     && <YamlViewer    kind={yamlTarget.kind}     namespace={yamlTarget.namespace}     name={yamlTarget.name}  onClose={() => setYamlTarget(null)} />}

      {/* Incident correlation bar (only when a linked deploy is selected) */}
      <AnimatePresence>
        {selected?.linkedIncidentId && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="border-t border-danger/30 bg-danger/5 px-6 py-3 flex items-center gap-4 overflow-hidden flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-danger flex-shrink-0" />
            <div className="flex-1 text-sm">
              <span className="font-semibold text-danger">{selected.service} {selected.version}</span>
              <span className="text-surface-300"> linked to incident </span>
              <span className="font-semibold text-danger">{selected.linkedIncidentId?.toUpperCase()}</span>
            </div>
            <div className="flex items-center gap-2 text-2xs">
              <a href={`/dashboard/incidents/${selected.linkedIncidentId}`}
                className="flex items-center gap-1 px-2 py-1 rounded-full bg-surface-800 text-surface-300 hover:text-white border border-surface-700 transition-colors">
                View incident <ArrowUpRight className="w-3 h-3" />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
