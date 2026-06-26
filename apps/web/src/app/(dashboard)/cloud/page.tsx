'use client'

import { useState, useMemo, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Cloud, DollarSign, TrendingDown, TrendingUp, AlertTriangle, CheckCircle2,
  Wifi, WifiOff, RefreshCw, Database, Server, Layers, Package,
  Zap, HardDrive, ArrowUpRight, ArrowDownRight, Info, BarChart3,
  ChevronUp, ChevronDown, Activity, Cpu, MemoryStick, Terminal,
  Copy, Check, Target, Gauge, Boxes, ShieldCheck, ShieldAlert, ShieldX,
  Settings, Save, Download, Search,
  Clock,
} from 'lucide-react'
import { useLiveData } from '@/hooks/useLiveData'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────
type NodeRow = {
  name: string; status: string; cpuCores: number; cpuUsagePct: number
  memGiB: number; memUsagePct: number; podCount: number; podCapacity: number
  uptimeHours: number; instanceType: string; os: string; arch: string
}
interface NsCost {
  namespace: string; workloadCount: number; podCount: number
  cpuRequestedCores: number; memRequestedGiB: number
  cpuActualCores: number; memActualGiB: number
  cpuEfficiency: number | null; memEfficiency: number | null; overallEfficiency: number | null
  costPerMo: number; wastedPerMo: number; costSharePct: number
}
interface WorkloadCost {
  namespace: string; kind: string; name: string
  podCount: number; cpuCores: number; memGiB: number; costPerMo: number
}
interface PvcInfo {
  name: string; namespace: string; capacityGiB: number; usedGiB: number
  usagePct: number; storageClass: string; status: string; costPerMo: number
}
interface Optimization {
  type: string; namespace: string; workload: string
  currentCost: number; savingsPotential: number; reason: string
  severity: 'critical' | 'warning' | 'info'
  // enriched
  cpuRequested?: number; cpuActual?: number; cpuEfficiency?: number | null
  memRequestedGiB?: number; memActualGiB?: number; memEfficiency?: number | null
  recommendedCpuM?: number; recommendedMemMiB?: number
  wastedCpuCores?: number; wastedMemGiB?: number
  podCount?: number; workloadCount?: number
  rightSizeSavings?: number; cpuSavings?: number; memSavings?: number
  kubectl?: string
  priorityScore?: number
}
interface CloudData {
  cluster: { name: string; provider: string; region: string; version: string; namespaceCount: number }
  nodes: NodeRow[]
  cost: {
    totalPerMo: number; computePerMo: number; storagePerMo: number; wastedPerMo: number
    cpuEfficiency: number; memEfficiency: number
    byNamespace: NsCost[]; byWorkload: WorkloadCost[]
    ratesUsed: { cpuPerCoreHr: number; memPerGiBHr: number; storagePerGiBMo: number }
  }
  storage: { totalPVCs: number; totalCapacityGiB: number; totalUsedGiB: number; costPerMo: number; pvcs: PvcInfo[] }
  totalPodCount: number
  optimizations: Optimization[]
}

const EMPTY: CloudData = {
  cluster: { name: '—', provider: '—', region: '—', version: '—', namespaceCount: 0 },
  nodes: [],
  cost: {
    totalPerMo: 0, computePerMo: 0, storagePerMo: 0, wastedPerMo: 0,
    cpuEfficiency: 0, memEfficiency: 0, byNamespace: [], byWorkload: [],
    ratesUsed: { cpuPerCoreHr: 0.048, memPerGiBHr: 0.006, storagePerGiBMo: 0.05 },
  },
  storage: { totalPVCs: 0, totalCapacityGiB: 0, totalUsedGiB: 0, costPerMo: 0, pvcs: [] },
  totalPodCount: 0,
  optimizations: [],
}

const TABS = ['Overview', 'Nodes', 'Namespaces', 'Workloads', 'Storage', 'Optimizations'] as const
type Tab = typeof TABS[number]

// ── CSV export helper ────────────────────────────────────────────────────
function exportCsv(filename: string, headers: string[], rows: (string | number)[][][]) {
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(row.map(cell => {
      const v = String(cell ?? '')
      return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v
    }).join(','))
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click()
}

// ── Helpers ───────────────────────────────────────────────────────────────
const fmt$ = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`

function effColor(e: number | null) {
  if (e === null) return 'text-surface-500'
  if (e >= 70) return 'text-success'
  if (e >= 40) return 'text-warning'
  return 'text-danger'
}
function effBg(e: number | null) {
  if (e === null) return 'bg-surface-700'
  if (e >= 70) return 'bg-success'
  if (e >= 40) return 'bg-warning'
  return 'bg-danger'
}

function fmtUptime(hours: number) {
  if (hours < 1)   return '<1h'
  if (hours < 24)  return `${hours}h`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function UsageBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={cn('h-1.5 rounded-full bg-surface-700 overflow-hidden', className)}>
      <div className={cn('h-full rounded-full transition-all', pct > 85 ? 'bg-danger' : pct > 65 ? 'bg-warning' : 'bg-success')}
        style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

const SEV_STYLE = {
  critical: { bar: 'bg-danger/10 border-danger/30',    badge: 'bg-danger/10  text-danger  border-danger/20',  icon: AlertTriangle },
  warning:  { bar: 'bg-warning/10 border-warning/30',  badge: 'bg-warning/10 text-warning border-warning/20', icon: AlertTriangle },
  info:     { bar: 'bg-brand-500/5 border-brand-500/20', badge: 'bg-brand-500/10 text-brand-400 border-brand-500/20', icon: Info },
}

const TYPE_LABEL: Record<string, string> = {
  'over-provisioned':     'Over-Provisioned',
  'cpu-over-provisioned': 'CPU Waste',
  'mem-over-provisioned': 'Mem Waste',
  'workload-rightsizing': 'Right-size',
  'no-requests':          'No Requests',
  'storage-full':         'Storage Full',
}

// ── Copy button ───────────────────────────────────────────────────────────
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={() => { navigator.clipboard.writeText(text).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="p-1 rounded hover:bg-surface-700 text-surface-500 hover:text-surface-300 transition-all flex-shrink-0" title="Copy command">
      {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}

// ── Risk info per optimization type ──────────────────────────────────────
type RiskLevel = 'low' | 'medium' | 'high'
const RISK_INFO: Record<string, { level: RiskLevel; note: string }> = {
  'over-provisioned':     { level: 'low',    note: 'Changes requests only — pods will not be killed. Scheduler re-evaluates placement on next restart.' },
  'cpu-over-provisioned': { level: 'low',    note: 'Reduces CPU requests only. Limits are untouched — pods can still burst if node has free capacity.' },
  'mem-over-provisioned': { level: 'medium', note: 'Memory spikes are silent until OOMKill. Monitor for 24h after applying and watch for pod restarts.' },
  'workload-rightsizing': { level: 'medium', note: 'Per-workload change triggers a rolling restart. Verify under realistic load before applying to production.' },
  'no-requests':          { level: 'low',    note: 'Adding requests is always safe — improves scheduling decisions and enables HPA. Causes a rolling restart.' },
  'storage-full':         { level: 'high',   note: 'PVC expansion requires StorageClass with allowVolumeExpansion: true. Verify before patching — data loss risk if expansion fails.' },
}

const OUTCOME_NOTE: Record<string, string> = {
  'over-provisioned':     'Target is 2.2× peak actual usage — leaves headroom for traffic spikes. Apply during a low-traffic window and monitor pods for 30 min.',
  'cpu-over-provisioned': 'CPU requests reduced to 2.2× peak. Pods can still burst beyond requests when node capacity allows.',
  'mem-over-provisioned': 'Memory reduced to 2.2× peak. Watch for OOMKill events — memory usage can spike during GC or batch jobs.',
  'workload-rightsizing': 'Per-workload right-sizing. Test under peak load in staging first. A rolling restart will occur on apply.',
  'no-requests':          'No direct cost savings, but prevents scheduler failures and enables autoscaling. Rolling restart on apply.',
  'storage-full':         'Expands PVC capacity. No downtime expected on most CSI drivers. Verify StorageClass supports live expansion.',
}

function getVerifyCmd(type: string, ns: string, workload: string): string {
  const parts = workload.includes('/') ? workload.split('/') : ['deployment', workload]
  const kind = parts[0]!.toLowerCase()
  const name = parts[1]!
  switch (type) {
    case 'over-provisioned':     return `kubectl top pods -n ${ns}`
    case 'cpu-over-provisioned': return `kubectl top pods -n ${ns}`
    case 'mem-over-provisioned': return `kubectl top pods -n ${ns} --sort-by=memory`
    case 'workload-rightsizing': return `kubectl describe ${kind} ${name} -n ${ns}`
    case 'no-requests':          return `kubectl get pods -n ${ns} -o wide`
    case 'storage-full':         return `kubectl get pvc -n ${ns} -o wide`
    default:                     return `kubectl get pods -n ${ns}`
  }
}

// ── Resource bar ──────────────────────────────────────────────────────────
function ResBar({ label, requested, actual, recommended, unit = 'c', color = 'text-brand-400' }: {
  label: string; requested: number; actual: number; recommended?: number; unit?: string; color?: string
}) {
  if (requested <= 0) return null
  const effPct = Math.min(100, Math.round(actual / requested * 100))
  const recPct = recommended !== undefined ? Math.min(100, Math.round(recommended / requested * 100)) : undefined
  const barColor = effPct >= 70 ? 'bg-success' : effPct >= 40 ? 'bg-warning' : 'bg-danger'
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-2xs">
        <span className="text-surface-500 font-medium">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-surface-600">{requested}{unit} req</span>
          <span className="text-surface-400">→ {actual}{unit} actual</span>
          {recommended !== undefined && <span className="text-success font-medium">→ {recommended}{unit} target</span>}
        </div>
      </div>
      <div className="relative h-2 rounded-full bg-surface-800 overflow-visible">
        <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${effPct}%` }} />
        {recPct !== undefined && (
          <div className="absolute top-0 h-full w-0.5 bg-success/70 rounded-full" style={{ left: `${recPct}%` }} title={`Target: ${recommended}${unit}`} />
        )}
      </div>
      <div className="flex items-center justify-between text-2xs">
        <span className={effPct >= 70 ? 'text-success' : effPct >= 40 ? 'text-warning' : 'text-danger'}>{effPct}% efficiency</span>
        {recommended !== undefined && <span className="text-success">{Math.round(100 - recPct!)}% reduction target</span>}
      </div>
    </div>
  )
}

// ── Efficiency gauge (SVG ring) ───────────────────────────────────────────
function EffGauge({ value, label, size = 80 }: { value: number; label: string; size?: number }) {
  const r = size * 0.38; const circ = 2 * Math.PI * r
  const dash = (value / 100) * circ
  const color = value >= 70 ? '#22c55e' : value >= 40 ? '#f59e0b' : '#ef4444'
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1e293b" strokeWidth={size * 0.1} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={size * 0.1}
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.8s ease' }} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm font-bold tabular-nums" style={{ color }}>{value}%</p>
        </div>
      </div>
      <p className="text-2xs text-surface-500">{label}</p>
    </div>
  )
}

// ── Sort hook ─────────────────────────────────────────────────────────────
function useSort<T>(data: T[], defaultKey: keyof T, defaultDir: 'asc' | 'desc' = 'desc') {
  const [key, setKey] = useState<keyof T>(defaultKey)
  const [dir, setDir] = useState<'asc' | 'desc'>(defaultDir)
  const toggle = (k: keyof T) => {
    if (k === key) setDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setKey(k); setDir('desc') }
  }
  const sorted = useMemo(() => [...data].sort((a, b) => {
    const av = a[key] as any; const bv = b[key] as any
    if (av == null) return 1; if (bv == null) return -1
    if (av === bv) return 0
    return dir === 'desc' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1)
  }), [data, key, dir])
  return { sorted, key, dir, toggle }
}

function SortTh<T>({ label, k, current, dir, onSort, cls }: {
  label: string; k: keyof T; current: keyof T; dir: 'asc' | 'desc'; onSort: (k: keyof T) => void; cls?: string
}) {
  const active = k === current
  return (
    <th className={cn('px-3 py-2 text-left cursor-pointer select-none group', cls)}
      onClick={() => onSort(k)}>
      <span className={cn('flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider',
        active ? 'text-brand-400' : 'text-surface-500 group-hover:text-surface-300')}>
        {label}
        {active ? (dir === 'desc' ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />) : null}
      </span>
    </th>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────
function CloudInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { data, isLive, loading, refresh, error } = useLiveData<CloudData>(
    '/api/cloud/overview', EMPTY, undefined, 60_000,
  )
  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get('tab')
    return (TABS as readonly string[]).includes(t ?? '') ? t as Tab : 'Overview'
  })
  const [rateOpen,  setRateOpen]  = useState(false)
  const [rateCpu,   setRateCpu]   = useState('')
  const [rateMem,   setRateMem]   = useState('')
  const [rateStore, setRateStore] = useState('')
  const [rateSaved, setRateSaved] = useState(false)

  // Search / filter state (M2, M3)
  const [nodeSearch,  setNodeSearch]  = useState('')
  const [nsSearch,    setNsSearch]    = useState('')
  const [wlSearch,    setWlSearch]    = useState('')
  const [wlNsFilter,  setWlNsFilter]  = useState('(all)')
  const [pvcSearch,   setPvcSearch]   = useState('')
  const [optSearch,   setOptSearch]   = useState('')

  const saveRates = async () => {
    const body: Record<string, number> = {}
    const cpu = parseFloat(rateCpu); if (!isNaN(cpu) && cpu > 0) body.finops_cpu_per_core_hr = cpu
    const mem = parseFloat(rateMem); if (!isNaN(mem) && mem > 0) body.finops_mem_per_gib_hr = mem
    const sto = parseFloat(rateStore); if (!isNaN(sto) && sto > 0) body.finops_storage_per_gib_mo = sto
    if (!Object.keys(body).length) return
    await fetch('/api/settings/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setRateSaved(true); setTimeout(() => setRateSaved(false), 2000)
    refresh()
  }

  const { cost, storage, optimizations, cluster, nodes, totalPodCount } = data

  // Populate rate inputs from live data once loaded
  const ratesUsed = cost.ratesUsed
  useEffect(() => {
    if (ratesUsed && !rateCpu) {
      setRateCpu(String(ratesUsed.cpuPerCoreHr))
      setRateMem(String(ratesUsed.memPerGiBHr))
      setRateStore(String(ratesUsed.storagePerGiBMo))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratesUsed?.cpuPerCoreHr, ratesUsed?.memPerGiBHr, ratesUsed?.storagePerGiBMo])

  const totalSavings = optimizations.reduce((s, o) => s + o.savingsPotential, 0)
  // B2: use != null so 0% efficiency doesn't falsely zero the gauge
  const efficiencyScore = cost.cpuEfficiency != null && cost.memEfficiency != null
    ? Math.round((cost.cpuEfficiency + cost.memEfficiency) / 2) : (cost.cpuEfficiency ?? cost.memEfficiency ?? 0)
  const critCount = optimizations.filter(o => o.severity === 'critical').length

  // ── Node cost enrichment ──────────────────────────────────────────────────
  type NodeRowWithCost = NodeRow & { costPerMo: number; idleCostPerMo: number }
  const nodeWithCost = useMemo<NodeRowWithCost[]>(() => {
    const cpu$ = cost.ratesUsed.cpuPerCoreHr || 0.048
    const mem$ = cost.ratesUsed.memPerGiBHr  || 0.006
    return nodes.map(n => {
      const costPerMo    = Math.round((n.cpuCores * cpu$ + n.memGiB * mem$) * 730 * 100) / 100
      const idleCpuCores = n.cpuCores * Math.max(0, 1 - n.cpuUsagePct / 100)
      const idleMemGiB   = n.memGiB   * Math.max(0, 1 - n.memUsagePct / 100)
      const idleCostPerMo = Math.round((idleCpuCores * cpu$ + idleMemGiB * mem$) * 730 * 100) / 100
      return { ...n, costPerMo, idleCostPerMo }
    })
  }, [nodes, cost.ratesUsed])

  // ── Node sort + filter (M1, M2) ──────────────────────────────────────────
  const nodeSort = useSort<NodeRowWithCost>(nodeWithCost, 'costPerMo')
  const filteredNodes = useMemo(() =>
    nodeSort.sorted.filter(n => !nodeSearch || n.name.toLowerCase().includes(nodeSearch.toLowerCase())),
    [nodeSort.sorted, nodeSearch])

  // ── Namespace sort + filter (M2) ─────────────────────────────────────────
  const nsSort = useSort<NsCost>(cost.byNamespace, 'costPerMo')
  const filteredNs = useMemo(() =>
    nsSort.sorted.filter(n => !nsSearch || n.namespace.toLowerCase().includes(nsSearch.toLowerCase())),
    [nsSort.sorted, nsSearch])

  // ── Workload sort + filter (M2, M3) ──────────────────────────────────────
  const wlSort = useSort<WorkloadCost>(cost.byWorkload, 'costPerMo')
  const wlNamespaces = useMemo(() => ['(all)', ...Array.from(new Set(cost.byWorkload.map(w => w.namespace))).sort()], [cost.byWorkload])
  const filteredWl = useMemo(() =>
    wlSort.sorted.filter(w =>
      (wlNsFilter === '(all)' || w.namespace === wlNsFilter) &&
      (!wlSearch || w.name.toLowerCase().includes(wlSearch.toLowerCase()) || w.namespace.toLowerCase().includes(wlSearch.toLowerCase()))
    ), [wlSort.sorted, wlNsFilter, wlSearch])

  // ── PVC sort + filter (M2) ───────────────────────────────────────────────
  const pvcSort = useSort<PvcInfo>(storage.pvcs, 'costPerMo')
  const filteredPvcs = useMemo(() =>
    pvcSort.sorted.filter(p => !pvcSearch || p.name.toLowerCase().includes(pvcSearch.toLowerCase()) || p.namespace.toLowerCase().includes(pvcSearch.toLowerCase())),
    [pvcSort.sorted, pvcSearch])

  // ── Optimizations filter (M2) ────────────────────────────────────────────
  const filteredOpts = useMemo(() =>
    optimizations.filter(o => !optSearch ||
      o.namespace.toLowerCase().includes(optSearch.toLowerCase()) ||
      o.workload.toLowerCase().includes(optSearch.toLowerCase()) ||
      (TYPE_LABEL[o.type] ?? o.type).toLowerCase().includes(optSearch.toLowerCase())
    ), [optimizations, optSearch])

  const maxNsCost = cost.byNamespace.reduce((m, n) => Math.max(m, n.costPerMo), 0.01)
  const maxWlCost = cost.byWorkload.reduce((m, w) => Math.max(m, w.costPerMo), 0.01)
  // Totals (M5)
  const nsTotal   = cost.byNamespace.reduce((s, n) => ({ cost: s.cost + n.costPerMo, waste: s.waste + n.wastedPerMo, pods: s.pods + n.podCount, wl: s.wl + n.workloadCount }), { cost: 0, waste: 0, pods: 0, wl: 0 })
  const wlTotal   = cost.byWorkload.reduce((s, w) => ({ cost: s.cost + w.costPerMo, pods: s.pods + w.podCount }), { cost: 0, pods: 0 })
  const pvcTotal  = storage.pvcs.reduce((s, p) => ({ cap: s.cap + p.capacityGiB, used: s.used + p.usedGiB, cost: s.cost + p.costPerMo }), { cap: 0, used: 0, cost: 0 })

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800 flex-shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Cloud className="w-5 h-5 text-brand-400" /> Cloud
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">
            {cluster.name} · {cluster.provider} · {cluster.region}
            {nodes.length > 0 && ` · ${nodes.length} nodes · ${totalPodCount} pods`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cost.totalPerMo > 0 && (
            <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-surface-800 border border-surface-700 rounded-xl text-white font-bold">
              <DollarSign className="w-3 h-3 text-brand-400" /> {fmt$(cost.totalPerMo)}/mo
            </span>
          )}
          {totalSavings > 0 && (
            <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-success/10 border border-success/20 rounded-xl text-success font-medium">
              <TrendingDown className="w-3 h-3" /> {fmt$(totalSavings)} potential savings
            </span>
          )}
          {critCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-danger/10 border border-danger/20 rounded-xl text-danger">
              <AlertTriangle className="w-3 h-3" /> {critCount} critical
            </span>
          )}
          {isLive
            ? <span className="flex items-center gap-1 px-2.5 py-1 bg-success/10 border border-success/20 rounded-xl text-xs text-success"><Wifi className="w-3 h-3" /> Live</span>
            : <span className="flex items-center gap-1 px-2.5 py-1 bg-surface-800 border border-surface-700 rounded-xl text-xs text-surface-400"><WifiOff className="w-3 h-3" /> Offline</span>
          }
          {error && (
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-warning/5 border border-warning/20 rounded-xl text-xs text-warning/80">
              <AlertTriangle className="w-3 h-3" /> {error}
            </span>
          )}
          <button onClick={() => setRateOpen(o => !o)} title="Configure cost rates"
            className={cn('w-8 h-8 flex items-center justify-center border rounded-xl transition-all',
              rateOpen ? 'bg-brand-500/20 border-brand-500/40 text-brand-400' : 'bg-surface-800 hover:bg-surface-700 border-surface-700 text-surface-400 hover:text-white')}>
            <Settings className="w-3.5 h-3.5" />
          </button>
          <button onClick={refresh} disabled={loading}
            className="w-8 h-8 flex items-center justify-center bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-surface-400 hover:text-white disabled:opacity-50 transition-all">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* ── Rate editor panel ── */}
      <AnimatePresence>
        {rateOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-surface-800 bg-surface-900/60 flex-shrink-0">
            <div className="px-3 sm:px-6 py-3 flex flex-wrap items-end gap-4">
              <div>
                <p className="text-2xs text-surface-500 mb-1">CPU $/core/hr</p>
                <input value={rateCpu} onChange={e => setRateCpu(e.target.value)} placeholder="0.048"
                  className="w-24 bg-surface-800 border border-surface-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-brand-500 font-mono" />
              </div>
              <div>
                <p className="text-2xs text-surface-500 mb-1">Memory $/GiB/hr</p>
                <input value={rateMem} onChange={e => setRateMem(e.target.value)} placeholder="0.006"
                  className="w-24 bg-surface-800 border border-surface-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-brand-500 font-mono" />
              </div>
              <div>
                <p className="text-2xs text-surface-500 mb-1">Storage $/GiB/mo</p>
                <input value={rateStore} onChange={e => setRateStore(e.target.value)} placeholder="0.05"
                  className="w-24 bg-surface-800 border border-surface-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-brand-500 font-mono" />
              </div>
              <button onClick={saveRates}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 rounded-lg text-xs font-medium text-white transition-all">
                {rateSaved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                {rateSaved ? 'Saved' : 'Apply rates'}
              </button>
              <p className="text-2xs text-surface-600 flex items-center gap-1 ml-auto">
                <Info className="w-3 h-3 flex-shrink-0" />
                Estimates based on resource <em>requests</em>, not actual cloud billing. Use your contract rates for accuracy.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Tabs ── */}
      <div className="flex border-b border-surface-800 flex-shrink-0 px-3 sm:px-6 overflow-x-auto scrollbar-none">
        {TABS.map(t => (
          <button key={t} onClick={() => { setTab(t); router.replace(`?tab=${encodeURIComponent(t)}`, { scroll: false }) }}
            className={cn('px-4 py-3 text-xs font-medium border-b-2 transition-all',
              tab === t ? 'border-brand-500 text-brand-400' : 'border-transparent text-surface-500 hover:text-surface-300')}>
            {t}
            {t === 'Nodes' && nodes.filter(n => n.status !== 'ready').length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-2xs font-bold bg-danger/20 text-danger">
                {nodes.filter(n => n.status !== 'ready').length}
              </span>
            )}
            {t === 'Optimizations' && optimizations.length > 0 && (
              <span className={cn('ml-1.5 px-1.5 py-0.5 rounded-full text-2xs font-bold',
                critCount > 0 ? 'bg-danger/20 text-danger' : 'bg-warning/20 text-warning')}>
                {optimizations.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="p-6 space-y-6">

            {/* ══ OVERVIEW ══════════════════════════════════════════════════ */}
            {tab === 'Overview' && (<>
              {/* KPI row */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: 'Total Monthly Cost', value: fmt$(cost.totalPerMo), sub: 'compute + storage', icon: DollarSign, clr: 'text-white', bg: 'bg-brand-500/10 border-brand-500/20' },
                  { label: 'Compute Cost', value: fmt$(cost.computePerMo), sub: 'CPU + memory requests', icon: Server, clr: 'text-white', bg: 'bg-surface-800 border-surface-700' },
                  { label: 'Storage Cost', value: fmt$(cost.storagePerMo), sub: `${storage.totalPVCs} PVCs · ${storage.totalCapacityGiB.toFixed(0)} GiB`, icon: HardDrive, clr: 'text-white', bg: 'bg-surface-800 border-surface-700' },
                  { label: 'Wasted / Month', value: fmt$(cost.wastedPerMo), sub: 'over-provisioned resources', icon: TrendingDown, clr: cost.wastedPerMo > 5 ? 'text-warning' : 'text-success', bg: cost.wastedPerMo > 5 ? 'bg-warning/5 border-warning/20' : 'bg-success/5 border-success/20' },
                ].map(k => (
                  <div key={k.label} className={cn('rounded-2xl border p-4', k.bg)}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-2xs text-surface-500 uppercase tracking-wider">{k.label}</p>
                      <k.icon className="w-3.5 h-3.5 text-surface-600" />
                    </div>
                    <p className={cn('text-2xl font-bold tabular-nums', k.clr)}>{k.value}</p>
                    <p className="text-2xs text-surface-600 mt-0.5">{k.sub}</p>
                  </div>
                ))}
              </div>

              {/* Efficiency + cost split */}
              <div className="grid lg:grid-cols-3 gap-4">
                {/* Efficiency gauges */}
                <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
                  <p className="text-xs font-semibold text-white mb-4 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-brand-400" /> Resource Efficiency
                  </p>
                  <div className="flex justify-around">
                    <EffGauge value={cost.cpuEfficiency ?? 0} label="CPU" size={90} />
                    <EffGauge value={cost.memEfficiency ?? 0} label="Memory" size={90} />
                    <EffGauge value={efficiencyScore} label="Overall" size={90} />
                  </div>
                  <p className="text-2xs text-surface-500 text-center mt-3">
                    actual usage ÷ requested · higher = better
                  </p>
                </div>

                {/* Cost by node (top nodes) */}
                <div className="lg:col-span-2 rounded-2xl bg-surface-900 border border-surface-800 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-xs font-semibold text-white flex items-center gap-2">
                      <Server className="w-4 h-4 text-brand-400" /> Cost by Node
                    </p>
                    {nodes.length > 0 && (() => {
                      const cpu$ = cost.ratesUsed.cpuPerCoreHr || 0.048
                      const mem$ = cost.ratesUsed.memPerGiBHr  || 0.006
                      return <span className="text-xs font-bold text-emerald-400">{fmt$(nodes.reduce((s, n) => s + n.cpuCores * cpu$ * 730 + n.memGiB * mem$ * 730, 0))}/mo total</span>
                    })()}
                  </div>
                  {nodes.length > 0 ? (() => {
                    const cpu$ = cost.ratesUsed.cpuPerCoreHr || 0.048
                    const mem$ = cost.ratesUsed.memPerGiBHr  || 0.006
                    const nodeRows = nodes.map(n => ({ ...n, costPerMo: n.cpuCores * cpu$ * 730 + n.memGiB * mem$ * 730 })).sort((a, b) => b.costPerMo - a.costPerMo)
                    const maxNodeCost = nodeRows.reduce((m, n) => Math.max(m, n.costPerMo), 0.01)
                    return (
                      <div className="space-y-2.5">
                        {nodeRows.map(n => {
                          const isHighCpu = n.cpuUsagePct >= 80
                          const isHighMem = n.memUsagePct >= 80
                          const isUnderutilized = n.cpuUsagePct < 30 && n.memUsagePct < 30
                          return (
                            <div key={n.name}>
                              <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="text-xs text-surface-300 font-mono truncate max-w-[160px]" title={n.name}>{n.name}</span>
                                  {n.instanceType && <span className="text-2xs text-surface-600 flex-shrink-0">{n.instanceType}</span>}
                                  {isUnderutilized && <span className="text-2xs px-1.5 py-0.5 rounded bg-warning/10 border border-warning/20 text-warning font-semibold flex-shrink-0">underused</span>}
                                  {(isHighCpu || isHighMem) && <span className="text-2xs px-1.5 py-0.5 rounded bg-danger/10 border border-danger/20 text-danger font-semibold flex-shrink-0">{isHighCpu && isHighMem ? 'CPU+Mem pressure' : isHighCpu ? 'CPU pressure' : 'Mem pressure'}</span>}
                                </div>
                                <div className="flex items-center gap-3 flex-shrink-0">
                                  <span className="text-2xs text-surface-500 tabular-nums">{n.cpuCores}c · {n.memGiB}GiB</span>
                                  <span className="text-xs font-bold text-emerald-400 tabular-nums">{fmt$(n.costPerMo)}/mo</span>
                                </div>
                              </div>
                              <div className="h-2 rounded-full bg-surface-800 overflow-hidden">
                                <div className="h-full rounded-full bg-emerald-500/70 transition-all" style={{ width: `${(n.costPerMo / maxNodeCost) * 100}%` }} />
                              </div>
                            </div>
                          )
                        })}
                        <p className="text-2xs text-surface-600 pt-1">
                          Rates: ${cpu$.toFixed(4)}/core-hr · ${mem$.toFixed(4)}/GiB-hr &nbsp;·&nbsp; <span className="text-surface-500">underused = CPU &lt;30% &amp; Mem &lt;30%</span>
                        </p>
                      </div>
                    )
                  })() : <p className="text-xs text-surface-500 py-4 text-center">No node data available</p>}
                </div>
              </div>

              {/* Cost by namespace — B8: show up to 8, add View all link */}
              <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs font-semibold text-white flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-brand-400" /> Cost by Namespace
                  </p>
                  {cost.byNamespace.length > 8 && (
                    <button onClick={() => { setTab('Namespaces'); router.replace('?tab=Namespaces', { scroll: false }) }}
                      className="text-2xs text-brand-400 hover:text-brand-300 transition-colors">
                      View all {cost.byNamespace.length} →
                    </button>
                  )}
                </div>
                <div className="space-y-2.5">
                  {cost.byNamespace.slice(0, 8).map(ns => (
                    <div key={ns.namespace}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-surface-300 font-mono">{ns.namespace}</span>
                        <div className="flex items-center gap-3">
                          {ns.overallEfficiency !== null && (
                            <span className={cn('text-2xs font-medium', effColor(ns.overallEfficiency))}>
                              {ns.overallEfficiency}% eff
                            </span>
                          )}
                          <span className="text-xs font-bold text-white tabular-nums">{fmt$(ns.costPerMo)}/mo</span>
                        </div>
                      </div>
                      <div className="h-2 rounded-full bg-surface-800 overflow-hidden">
                        <div className="h-full rounded-full bg-brand-500 transition-all"
                          style={{ width: `${(ns.costPerMo / maxNsCost) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                  {cost.byNamespace.length === 0 && (
                    <p className="text-xs text-surface-500 py-4 text-center">No cost data — pods may have no resource requests set</p>
                  )}
                </div>
              </div>

              {/* Quick-win optimizations — B5: include all severities not just savings>0 */}
              {optimizations.length > 0 && (
                <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-xs font-semibold text-white flex items-center gap-2">
                      <TrendingDown className="w-4 h-4 text-success" /> Top Optimizations
                    </p>
                    {totalSavings > 0 && (
                      <span className="text-xs font-bold text-success">{fmt$(totalSavings)}/mo potential</span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {optimizations.slice(0, 4).map((o, i) => {
                      const sty = SEV_STYLE[o.severity]
                      const recCpu = o.recommendedCpuM !== undefined ? `${o.recommendedCpuM}m` : null
                      const recMem = o.recommendedMemMiB !== undefined ? `${o.recommendedMemMiB}Mi` : null
                      return (
                        <div key={i} className={cn('rounded-xl border p-4', sty.bar)}>
                          <div className="flex items-start gap-3">
                            <sty.icon className={cn('w-4 h-4 mt-0.5 flex-shrink-0',
                              o.severity === 'critical' ? 'text-danger' : o.severity === 'warning' ? 'text-warning' : 'text-brand-400')} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <span className={cn('text-2xs px-1.5 py-0.5 rounded font-bold border uppercase', sty.badge)}>
                                  {TYPE_LABEL[o.type] ?? o.type}
                                </span>
                                <span className="text-xs font-mono text-surface-300">{o.namespace}</span>
                                {o.workload !== '(all workloads)' && (
                                  <span className="text-2xs text-surface-500 font-mono">{o.workload}</span>
                                )}
                                {/* B9: consistent Score label (not inverted P-label) */}
                                {o.priorityScore !== undefined && (
                                  <span className={cn('ml-auto text-2xs font-medium px-1.5 py-0.5 rounded border',
                                    o.priorityScore >= 70 ? 'text-danger border-danger/30 bg-danger/5' :
                                    o.priorityScore >= 40 ? 'text-warning border-warning/30 bg-warning/5' :
                                    'text-surface-500 border-surface-700 bg-surface-800')}>
                                    Score {o.priorityScore}
                                  </span>
                                )}
                              </div>
                              <p className="text-2xs text-surface-400 leading-relaxed">{o.reason}</p>
                              {(o.cpuRequested !== undefined || o.memRequestedGiB !== undefined) && (
                                <div className="mt-2.5 grid grid-cols-2 gap-3">
                                  {o.cpuRequested !== undefined && o.cpuActual !== undefined && (
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-1 text-2xs text-surface-500">
                                        <Cpu className="w-3 h-3" /> CPU
                                      </div>
                                      <div className="flex items-center gap-2 text-2xs">
                                        <span className="text-surface-400">{o.cpuRequested}c req</span>
                                        <span className="text-surface-600">→</span>
                                        <span className="text-surface-300">{o.cpuActual}c actual</span>
                                        {recCpu && <><span className="text-surface-600">→</span><span className="text-success font-medium">{recCpu} target</span></>}
                                      </div>
                                      {o.cpuEfficiency !== null && o.cpuEfficiency !== undefined && (
                                        <div className="h-1.5 rounded-full bg-surface-800">
                                          <div className={cn('h-full rounded-full', o.cpuEfficiency >= 70 ? 'bg-success' : o.cpuEfficiency >= 40 ? 'bg-warning' : 'bg-danger')}
                                            style={{ width: `${o.cpuEfficiency}%` }} />
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  {o.memRequestedGiB !== undefined && o.memActualGiB !== undefined && (
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-1 text-2xs text-surface-500">
                                        <MemoryStick className="w-3 h-3" /> Memory
                                      </div>
                                      <div className="flex items-center gap-2 text-2xs">
                                        <span className="text-surface-400">{o.memRequestedGiB}Gi req</span>
                                        <span className="text-surface-600">→</span>
                                        <span className="text-surface-300">{o.memActualGiB}Gi actual</span>
                                        {recMem && <><span className="text-surface-600">→</span><span className="text-success font-medium">{recMem} target</span></>}
                                      </div>
                                      {o.memEfficiency !== null && o.memEfficiency !== undefined && (
                                        <div className="h-1.5 rounded-full bg-surface-800">
                                          <div className={cn('h-full rounded-full', o.memEfficiency >= 70 ? 'bg-success' : o.memEfficiency >= 40 ? 'bg-warning' : 'bg-danger')}
                                            style={{ width: `${o.memEfficiency}%` }} />
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="flex-shrink-0 text-right">
                              {o.savingsPotential > 0 ? (<>
                                <p className="text-sm font-bold text-success">{fmt$(o.savingsPotential)}</p>
                                <p className="text-2xs text-surface-500">/mo savings</p>
                              </>) : (
                                <span className={cn('text-2xs px-1.5 py-0.5 rounded border font-bold uppercase',
                                  o.severity === 'critical' ? 'text-danger border-danger/30 bg-danger/5' : 'text-warning border-warning/30 bg-warning/5')}>
                                  Action needed
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {optimizations.length > 4 && (
                    <button onClick={() => { setTab('Optimizations'); router.replace(`?tab=Optimizations`, { scroll: false }) }}
                      className="mt-3 w-full text-2xs text-brand-400 hover:text-brand-300 py-2 border border-surface-800 rounded-xl hover:border-brand-500/30 transition-all">
                      View all {optimizations.length} optimizations →
                    </button>
                  )}
                </div>
              )}

              {/* Rates disclosure */}
              <div className="rounded-xl bg-surface-900/50 border border-surface-800 px-4 py-3 flex flex-wrap gap-4">
                <p className="text-2xs text-surface-500 flex items-center gap-1"><Info className="w-3 h-3" /> Cost model:</p>
                <span className="text-2xs text-surface-400">CPU: ${cost.ratesUsed.cpuPerCoreHr}/core/hr</span>
                <span className="text-2xs text-surface-400">Memory: ${cost.ratesUsed.memPerGiBHr}/GiB/hr</span>
                <span className="text-2xs text-surface-400">Storage: ${cost.ratesUsed.storagePerGiBMo}/GiB/mo</span>
                <span className="text-2xs text-surface-400">Based on Oracle Cloud ap-mumbai-1 rates · 730 hrs/mo</span>
              </div>
            </>)}

            {/* ══ NODES (B1/M1) ════════════════════════════════════════════ */}
            {tab === 'Nodes' && (() => {
              const cpu$ = cost.ratesUsed.cpuPerCoreHr || 0.048
              const mem$ = cost.ratesUsed.memPerGiBHr  || 0.006
              const totalNodeCost = nodeWithCost.reduce((s, n) => s + n.costPerMo, 0)
              const totalIdleCost = nodeWithCost.reduce((s, n) => s + n.idleCostPerMo, 0)
              const avgCpuUse     = nodes.length > 0 ? Math.round(nodes.reduce((s, n) => s + n.cpuUsagePct, 0) / nodes.length) : 0
              const avgMemUse     = nodes.length > 0 ? Math.round(nodes.reduce((s, n) => s + n.memUsagePct, 0) / nodes.length) : 0
              const maxNodeCost   = nodeWithCost.reduce((m, n) => Math.max(m, n.costPerMo), 0.01)
              const filteredTotal = filteredNodes.reduce((s, n) => s + n.costPerMo, 0)
              const filteredIdle  = filteredNodes.reduce((s, n) => s + n.idleCostPerMo, 0)
              return (<>
                {/* KPI row — infra + cost */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { label: 'Total Nodes',       value: String(nodes.length),           sub: `${nodes.filter(n => n.status === 'ready').length} ready · ${nodes.filter(n => n.status !== 'ready').length} not ready`, icon: Server,       bg: 'bg-surface-800 border-surface-700',   clr: 'text-white' },
                    { label: 'Node Compute Cost',  value: fmt$(totalNodeCost) + '/mo',    sub: 'allocatable CPU + mem capacity',                                                                                          icon: DollarSign,   bg: 'bg-brand-500/10 border-brand-500/20', clr: 'text-white' },
                    { label: 'Idle Capacity Cost', value: fmt$(totalIdleCost) + '/mo',    sub: `${totalNodeCost > 0 ? Math.round(totalIdleCost / totalNodeCost * 100) : 0}% of node budget unused`,                      icon: TrendingDown,  bg: totalIdleCost > totalNodeCost * 0.4 ? 'bg-warning/5 border-warning/20' : 'bg-surface-800 border-surface-700', clr: totalIdleCost > totalNodeCost * 0.4 ? 'text-warning' : 'text-success' },
                    { label: 'Avg Utilisation',    value: `${Math.round((avgCpuUse + avgMemUse) / 2)}%`, sub: `CPU ${avgCpuUse}% · Mem ${avgMemUse}%`,                                                                   icon: Activity,     bg: 'bg-surface-800 border-surface-700',   clr: 'text-white' },
                  ].map(k => (
                    <div key={k.label} className={cn('rounded-2xl border p-4', k.bg)}>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-2xs text-surface-500 uppercase tracking-wider">{k.label}</p>
                        <k.icon className="w-3.5 h-3.5 text-surface-600" />
                      </div>
                      <p className={cn('text-2xl font-bold tabular-nums', k.clr)}>{k.value}</p>
                      <p className="text-2xs text-surface-600 mt-0.5">{k.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Cost by node stacked bar chart */}
                {nodeWithCost.length > 0 && (
                  <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-xs font-semibold text-white flex items-center gap-2">
                        <BarChart3 className="w-4 h-4 text-brand-400" /> Cost by Node
                      </p>
                      <span className="text-xs font-bold text-emerald-400">{fmt$(totalNodeCost)}/mo total</span>
                    </div>
                    <div className="space-y-2.5">
                      {[...nodeWithCost].sort((a, b) => b.costPerMo - a.costPerMo).map(n => {
                        const effPct = Math.round((n.cpuUsagePct + n.memUsagePct) / 2)
                        const isUnderutilized = n.cpuUsagePct < 30 && n.memUsagePct < 30
                        return (
                          <div key={n.name}>
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-xs text-surface-300 font-mono truncate max-w-[180px]" title={n.name}>{n.name}</span>
                                {n.instanceType && <span className="text-2xs text-surface-600 flex-shrink-0">{n.instanceType}</span>}
                                {isUnderutilized && <span className="text-2xs px-1.5 py-0.5 rounded bg-warning/10 border border-warning/20 text-warning font-semibold flex-shrink-0">underused</span>}
                              </div>
                              <div className="flex items-center gap-4 flex-shrink-0">
                                <span className={cn('text-2xs tabular-nums', effPct >= 60 ? 'text-success' : effPct >= 35 ? 'text-warning' : 'text-danger')}>
                                  {effPct}% util
                                </span>
                                <span className="text-2xs text-warning tabular-nums">{fmt$(n.idleCostPerMo)}/mo idle</span>
                                <span className="text-xs font-bold text-emerald-400 tabular-nums w-16 text-right">{fmt$(n.costPerMo)}/mo</span>
                              </div>
                            </div>
                            <div className="h-2 rounded-full bg-surface-800 overflow-hidden flex">
                              <div className="h-full bg-emerald-500/70 transition-all" style={{ width: `${(n.costPerMo - n.idleCostPerMo) / maxNodeCost * 100}%` }} />
                              <div className="h-full bg-warning/40 transition-all" style={{ width: `${n.idleCostPerMo / maxNodeCost * 100}%` }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div className="flex items-center gap-4 mt-3 text-2xs text-surface-600">
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/70 inline-block" /> Active (used)</span>
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-warning/40 inline-block" /> Idle capacity</span>
                      <span className="ml-auto">${cpu$.toFixed(4)}/core-hr · ${mem$.toFixed(4)}/GiB-hr · 730 hrs/mo</span>
                    </div>
                  </div>
                )}

                {/* Search + CSV */}
                <div className="flex items-center gap-3">
                  <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500 pointer-events-none" />
                    <input value={nodeSearch} onChange={e => setNodeSearch(e.target.value)} placeholder="Filter nodes…"
                      className="w-full pl-8 pr-3 py-1.5 bg-surface-800 border border-surface-700 rounded-xl text-xs text-white outline-none focus:border-brand-500" />
                  </div>
                  <button onClick={() => exportCsv('nodes.csv',
                    ['Name','Status','CPU Cores','CPU Usage%','Mem GiB','Mem Usage%','Pods','Pod Capacity','Instance Type','OS','Arch','Uptime (h)','Cost/mo','Idle Cost/mo'],
                    filteredNodes.map(n => [[n.name],[n.status],[n.cpuCores],[n.cpuUsagePct],[n.memGiB],[n.memUsagePct],[n.podCount],[n.podCapacity],[n.instanceType],[n.os],[n.arch],[n.uptimeHours],[n.costPerMo],[n.idleCostPerMo]]))}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-400 hover:text-white transition-all">
                    <Download className="w-3.5 h-3.5" /> CSV
                  </button>
                </div>

                {/* Node table */}
                <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-surface-950">
                        <tr>
                          <SortTh<NodeRowWithCost> label="Node" k="name" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} cls="pl-5 min-w-40" />
                          <th className="px-3 py-2 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">Status</th>
                          <SortTh<NodeRowWithCost> label="Instance" k="instanceType" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} />
                          <SortTh<NodeRowWithCost> label="CPU" k="cpuCores" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} />
                          <SortTh<NodeRowWithCost> label="CPU Use%" k="cpuUsagePct" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} />
                          <SortTh<NodeRowWithCost> label="Mem" k="memGiB" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} />
                          <SortTh<NodeRowWithCost> label="Mem Use%" k="memUsagePct" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} />
                          <SortTh<NodeRowWithCost> label="Pods" k="podCount" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} />
                          <SortTh<NodeRowWithCost> label="Uptime" k="uptimeHours" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} />
                          <SortTh<NodeRowWithCost> label="Cost/mo" k="costPerMo" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} />
                          <SortTh<NodeRowWithCost> label="Idle/mo" k="idleCostPerMo" current={nodeSort.key} dir={nodeSort.dir} onSort={nodeSort.toggle} />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-800">
                        {filteredNodes.map(n => {
                          const isHighCpu = n.cpuUsagePct >= 80
                          const isHighMem = n.memUsagePct >= 80
                          const isUnderutilized = n.cpuUsagePct < 30 && n.memUsagePct < 30
                          const podPct  = n.podCapacity > 0 ? Math.round(n.podCount / n.podCapacity * 100) : 0
                          const idlePct = n.costPerMo > 0 ? Math.round(n.idleCostPerMo / n.costPerMo * 100) : 0
                          return (
                            <tr key={n.name} className="hover:bg-surface-800/40 transition-colors">
                              <td className="pl-5 pr-3 py-3 font-mono text-white max-w-[200px] truncate" title={n.name}>{n.name}</td>
                              <td className="px-3 py-3">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className={cn('px-1.5 py-0.5 rounded text-2xs font-bold',
                                    n.status === 'ready' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')}>
                                    {n.status}
                                  </span>
                                  {isUnderutilized && <span className="px-1 py-0.5 rounded text-2xs bg-warning/10 text-warning border border-warning/20">underused</span>}
                                  {(isHighCpu || isHighMem) && <span className="px-1 py-0.5 rounded text-2xs bg-danger/10 text-danger border border-danger/20">{isHighCpu && isHighMem ? 'CPU+Mem' : isHighCpu ? 'CPU' : 'Mem'} pressure</span>}
                                </div>
                              </td>
                              <td className="px-3 py-3 text-surface-400 text-2xs">{n.instanceType}</td>
                              <td className="px-3 py-3 text-surface-300 tabular-nums">{n.cpuCores}c</td>
                              <td className="px-3 py-3 w-28">
                                <div className="flex items-center gap-1.5">
                                  <div className="flex-1 h-1.5 rounded-full bg-surface-800">
                                    <div className={cn('h-full rounded-full transition-all', n.cpuUsagePct >= 80 ? 'bg-danger' : n.cpuUsagePct >= 60 ? 'bg-warning' : 'bg-success')}
                                      style={{ width: `${n.cpuUsagePct}%` }} />
                                  </div>
                                  <span className={cn('text-2xs tabular-nums w-8 text-right', n.cpuUsagePct >= 80 ? 'text-danger' : n.cpuUsagePct >= 60 ? 'text-warning' : 'text-surface-400')}>
                                    {n.cpuUsagePct}%
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-3 text-surface-300 tabular-nums">{n.memGiB}Gi</td>
                              <td className="px-3 py-3 w-28">
                                <div className="flex items-center gap-1.5">
                                  <div className="flex-1 h-1.5 rounded-full bg-surface-800">
                                    <div className={cn('h-full rounded-full transition-all', n.memUsagePct >= 80 ? 'bg-danger' : n.memUsagePct >= 60 ? 'bg-warning' : 'bg-success')}
                                      style={{ width: `${n.memUsagePct}%` }} />
                                  </div>
                                  <span className={cn('text-2xs tabular-nums w-8 text-right', n.memUsagePct >= 80 ? 'text-danger' : n.memUsagePct >= 60 ? 'text-warning' : 'text-surface-400')}>
                                    {n.memUsagePct}%
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-3">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-surface-300 tabular-nums">{n.podCount}</span>
                                  <span className="text-surface-600">/ {n.podCapacity}</span>
                                  {podPct > 80 && <span className="text-2xs text-danger">({podPct}%)</span>}
                                </div>
                              </td>
                              <td className="px-3 py-3 text-surface-400 tabular-nums">{fmtUptime(n.uptimeHours)}</td>
                              <td className="px-3 py-3">
                                <div className="space-y-1">
                                  <p className="font-bold text-emerald-400 tabular-nums">{fmt$(n.costPerMo)}</p>
                                  <div className="w-20 h-1.5 rounded-full bg-surface-800 overflow-hidden flex">
                                    <div className="h-full bg-emerald-500/70 transition-all" style={{ width: `${(n.costPerMo - n.idleCostPerMo) / maxNodeCost * 100}%` }} />
                                    <div className="h-full bg-warning/40 transition-all" style={{ width: `${n.idleCostPerMo / maxNodeCost * 100}%` }} />
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-3">
                                <span className={cn('tabular-nums text-2xs', idlePct > 40 ? 'text-warning' : 'text-surface-500')}>
                                  {fmt$(n.idleCostPerMo)}
                                  {idlePct > 0 && <span className="ml-1 text-surface-600">({idlePct}%)</span>}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                        {filteredNodes.length === 0 && (
                          <tr><td colSpan={11} className="px-5 py-8 text-center text-surface-500 text-xs">
                            {nodes.length === 0 ? 'No node data available.' : 'No nodes match the filter.'}
                          </td></tr>
                        )}
                      </tbody>
                      {filteredNodes.length > 0 && (
                        <tfoot className="bg-surface-950 border-t border-surface-700">
                          <tr>
                            <td className="pl-5 pr-3 py-2.5 text-2xs font-bold text-surface-400 uppercase tracking-wider">Total</td>
                            <td colSpan={8} />
                            <td className="px-3 py-2.5 font-bold text-emerald-400 tabular-nums">{fmt$(filteredTotal)}/mo</td>
                            <td className="px-3 py-2.5 tabular-nums">
                              <span className={filteredIdle > filteredTotal * 0.3 ? 'text-warning font-bold' : 'text-surface-500'}>
                                {fmt$(filteredIdle)}/mo
                              </span>
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              </>)
            })()}

            {/* ══ NAMESPACES ════════════════════════════════════════════════ */}
            {tab === 'Namespaces' && (() => {
              const totalNsCost   = cost.byNamespace.reduce((s, n) => s + n.costPerMo, 0)
              const totalNsWaste  = cost.byNamespace.reduce((s, n) => s + n.wastedPerMo, 0)
              const avgCpuEff     = cost.byNamespace.filter(n => n.cpuEfficiency !== null).length > 0
                ? Math.round(cost.byNamespace.filter(n => n.cpuEfficiency !== null).reduce((s, n) => s + (n.cpuEfficiency ?? 0), 0) / cost.byNamespace.filter(n => n.cpuEfficiency !== null).length) : null
              const avgMemEff     = cost.byNamespace.filter(n => n.memEfficiency !== null).length > 0
                ? Math.round(cost.byNamespace.filter(n => n.memEfficiency !== null).reduce((s, n) => s + (n.memEfficiency ?? 0), 0) / cost.byNamespace.filter(n => n.memEfficiency !== null).length) : null
              const maxNsCostBar  = cost.byNamespace.reduce((m, n) => Math.max(m, n.costPerMo), 0.01)
              const wastedPct     = totalNsCost > 0 ? Math.round(totalNsWaste / totalNsCost * 100) : 0
              return (<>
              {/* KPI tiles */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: 'Total Cost',        value: fmt$(totalNsCost) + '/mo',   sub: `${cost.byNamespace.length} namespaces`,                                       icon: DollarSign,  bg: 'bg-brand-500/10 border-brand-500/20',  clr: 'text-white' },
                  { label: 'Wasted / Month',    value: fmt$(totalNsWaste) + '/mo',  sub: `${wastedPct}% of compute over-provisioned`,                                   icon: TrendingDown, bg: totalNsWaste > totalNsCost * 0.3 ? 'bg-warning/5 border-warning/20' : 'bg-surface-800 border-surface-700', clr: totalNsWaste > totalNsCost * 0.3 ? 'text-warning' : 'text-success' },
                  { label: 'Avg CPU Efficiency', value: avgCpuEff !== null ? `${avgCpuEff}%` : '—', sub: 'actual ÷ requested across namespaces',                        icon: Cpu,         bg: avgCpuEff !== null && avgCpuEff < 40 ? 'bg-warning/5 border-warning/20' : 'bg-surface-800 border-surface-700', clr: avgCpuEff !== null ? effColor(avgCpuEff) : 'text-surface-400' },
                  { label: 'Avg Mem Efficiency', value: avgMemEff !== null ? `${avgMemEff}%` : '—', sub: 'actual ÷ requested across namespaces',                        icon: MemoryStick, bg: avgMemEff !== null && avgMemEff < 40 ? 'bg-warning/5 border-warning/20' : 'bg-surface-800 border-surface-700', clr: avgMemEff !== null ? effColor(avgMemEff) : 'text-surface-400' },
                ].map(k => (
                  <div key={k.label} className={cn('rounded-2xl border p-4', k.bg)}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-2xs text-surface-500 uppercase tracking-wider">{k.label}</p>
                      <k.icon className="w-3.5 h-3.5 text-surface-600" />
                    </div>
                    <p className={cn('text-2xl font-bold tabular-nums', k.clr)}>{k.value}</p>
                    <p className="text-2xs text-surface-600 mt-0.5">{k.sub}</p>
                  </div>
                ))}
              </div>

              {/* Cost + waste bar chart — top 8 namespaces */}
              {cost.byNamespace.length > 0 && (
                <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-xs font-semibold text-white flex items-center gap-2">
                      <BarChart3 className="w-4 h-4 text-brand-400" /> Cost vs Waste by Namespace
                    </p>
                    <span className="text-xs font-bold text-white">{fmt$(totalNsCost)}/mo · <span className="text-warning">{fmt$(totalNsWaste)}/mo wasted</span></span>
                  </div>
                  <div className="space-y-2.5">
                    {[...cost.byNamespace].sort((a, b) => b.costPerMo - a.costPerMo).slice(0, 8).map(ns => (
                      <div key={ns.namespace}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs text-surface-300 font-mono truncate max-w-[180px]">{ns.namespace}</span>
                            {ns.overallEfficiency !== null && (
                              <span className={cn('text-2xs font-medium flex-shrink-0', effColor(ns.overallEfficiency))}>{ns.overallEfficiency}% eff</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0">
                            {ns.wastedPerMo > 0 && <span className="text-2xs text-warning tabular-nums">{fmt$(ns.wastedPerMo)} waste</span>}
                            <span className="text-xs font-bold text-white tabular-nums w-14 text-right">{fmt$(ns.costPerMo)}/mo</span>
                          </div>
                        </div>
                        <div className="h-2 rounded-full bg-surface-800 overflow-hidden flex">
                          <div className="h-full bg-brand-500/70 transition-all" style={{ width: `${(ns.costPerMo - ns.wastedPerMo) / maxNsCostBar * 100}%` }} />
                          <div className="h-full bg-warning/40 transition-all" style={{ width: `${ns.wastedPerMo / maxNsCostBar * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-4 mt-3 text-2xs text-surface-600">
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-brand-500/70 inline-block" /> Efficient spend</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-warning/40 inline-block" /> Wasted (over-provisioned)</span>
                  </div>
                </div>
              )}

              {/* Search + CSV (M2, M4) */}
              <div className="flex items-center gap-3">
                <div className="relative flex-1 max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500 pointer-events-none" />
                  <input value={nsSearch} onChange={e => setNsSearch(e.target.value)} placeholder="Filter namespaces…"
                    className="w-full pl-8 pr-3 py-1.5 bg-surface-800 border border-surface-700 rounded-xl text-xs text-white outline-none focus:border-brand-500" />
                </div>
                <button onClick={() => exportCsv('namespaces.csv',
                  ['Namespace','Workloads','Pods','CPU Eff%','Mem Eff%','CPU Req (c)','Mem Req (Gi)','Cost/mo','Waste/mo','Share%'],
                  filteredNs.map(n => [[n.namespace],[n.workloadCount],[n.podCount],[n.cpuEfficiency ?? ''],[n.memEfficiency ?? ''],[n.cpuRequestedCores],[n.memRequestedGiB],[n.costPerMo],[n.wastedPerMo],[n.costSharePct]]))}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-400 hover:text-white transition-all">
                  <Download className="w-3.5 h-3.5" /> CSV
                </button>
              </div>
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-5 py-3 border-b border-surface-800 flex items-center justify-between">
                  <p className="text-xs font-semibold text-white">Namespace Cost Allocation</p>
                  <p className="text-2xs text-surface-500">{filteredNs.length}/{cost.byNamespace.length} namespaces · {fmt$(cost.totalPerMo)}/mo total</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-950">
                      <tr>
                        <SortTh<NsCost> label="Namespace" k="namespace" current={nsSort.key} dir={nsSort.dir} onSort={nsSort.toggle} cls="pl-5 min-w-32" />
                        <SortTh<NsCost> label="Workloads" k="workloadCount" current={nsSort.key} dir={nsSort.dir} onSort={nsSort.toggle} />
                        <SortTh<NsCost> label="Pods" k="podCount" current={nsSort.key} dir={nsSort.dir} onSort={nsSort.toggle} />
                        <SortTh<NsCost> label="CPU Eff%" k="cpuEfficiency" current={nsSort.key} dir={nsSort.dir} onSort={nsSort.toggle} />
                        <SortTh<NsCost> label="Mem Eff%" k="memEfficiency" current={nsSort.key} dir={nsSort.dir} onSort={nsSort.toggle} />
                        <SortTh<NsCost> label="CPU Req" k="cpuRequestedCores" current={nsSort.key} dir={nsSort.dir} onSort={nsSort.toggle} />
                        <SortTh<NsCost> label="Mem Req" k="memRequestedGiB" current={nsSort.key} dir={nsSort.dir} onSort={nsSort.toggle} />
                        <SortTh<NsCost> label="Cost/mo" k="costPerMo" current={nsSort.key} dir={nsSort.dir} onSort={nsSort.toggle} />
                        <SortTh<NsCost> label="Waste/mo" k="wastedPerMo" current={nsSort.key} dir={nsSort.dir} onSort={nsSort.toggle} />
                        <th className="px-3 py-2 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">Share %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-800">
                      {filteredNs.map(ns => (
                        <tr key={ns.namespace} className="hover:bg-surface-800/40 transition-colors">
                          <td className="pl-5 pr-3 py-3 font-mono text-white">{ns.namespace}</td>
                          <td className="px-3 py-3 text-surface-300 tabular-nums">{ns.workloadCount}</td>
                          <td className="px-3 py-3 text-surface-300 tabular-nums">{ns.podCount}</td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-1.5">
                              <div className="w-12 h-1.5 rounded-full bg-surface-800">
                                <div className={cn('h-full rounded-full', effBg(ns.cpuEfficiency))}
                                  style={{ width: `${ns.cpuEfficiency ?? 0}%` }} />
                              </div>
                              <span className={effColor(ns.cpuEfficiency)}>
                                {ns.cpuEfficiency !== null ? `${ns.cpuEfficiency}%` : '—'}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-1.5">
                              <div className="w-12 h-1.5 rounded-full bg-surface-800">
                                <div className={cn('h-full rounded-full', effBg(ns.memEfficiency))}
                                  style={{ width: `${ns.memEfficiency ?? 0}%` }} />
                              </div>
                              <span className={effColor(ns.memEfficiency)}>
                                {ns.memEfficiency !== null ? `${ns.memEfficiency}%` : '—'}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-surface-300 tabular-nums">{ns.cpuRequestedCores}c</td>
                          <td className="px-3 py-3 text-surface-300 tabular-nums">{ns.memRequestedGiB}Gi</td>
                          <td className="px-3 py-3 font-bold text-white tabular-nums">{fmt$(ns.costPerMo)}</td>
                          <td className="px-3 py-3 tabular-nums">
                            <span className={ns.wastedPerMo > 1 ? 'text-warning' : 'text-surface-500'}>
                              {ns.wastedPerMo > 0 ? fmt$(ns.wastedPerMo) : '—'}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-1.5">
                              <div className="w-14 h-1.5 rounded-full bg-surface-800">
                                <div className="h-full rounded-full bg-brand-500"
                                  style={{ width: `${Math.min(100, ns.costSharePct)}%` }} />
                              </div>
                              <span className="text-surface-400">{ns.costSharePct}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredNs.length === 0 && (
                        <tr><td colSpan={10} className="px-5 py-8 text-center text-surface-500 text-xs">
                          {cost.byNamespace.length === 0 ? 'No namespace cost data. Pods may not have resource requests set.' : 'No namespaces match the filter.'}
                        </td></tr>
                      )}
                    </tbody>
                    {/* M5: totals row */}
                    {filteredNs.length > 0 && (
                      <tfoot className="bg-surface-950 border-t border-surface-700">
                        <tr>
                          <td className="pl-5 pr-3 py-2.5 text-2xs font-bold text-surface-400 uppercase tracking-wider">Total</td>
                          <td className="px-3 py-2.5 text-surface-300 font-bold tabular-nums">{nsTotal.wl}</td>
                          <td className="px-3 py-2.5 text-surface-300 font-bold tabular-nums">{nsTotal.pods}</td>
                          <td colSpan={5} />
                          <td className="px-3 py-2.5 font-bold text-white tabular-nums">{fmt$(nsTotal.cost)}</td>
                          <td className="px-3 py-2.5 font-bold tabular-nums">
                            <span className={nsTotal.waste > 1 ? 'text-warning' : 'text-surface-500'}>{fmt$(nsTotal.waste)}</span>
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
              </>)
            })()}

            {/* ══ WORKLOADS ═════════════════════════════════════════════════ */}
            {tab === 'Workloads' && (() => {
              const totalWlCost  = cost.byWorkload.reduce((s, w) => s + w.costPerMo, 0)
              const totalWlPods  = cost.byWorkload.reduce((s, w) => s + w.podCount, 0)
              const noReqCount   = cost.byWorkload.filter(w => w.costPerMo === 0 && w.podCount > 0).length
              const kindCounts   = cost.byWorkload.reduce((m, w) => { m[w.kind] = (m[w.kind] ?? 0) + 1; return m }, {} as Record<string,number>)
              const topKind      = Object.entries(kindCounts).sort((a,b) => b[1]-a[1])[0]?.[0] ?? '—'
              const maxWlBar     = cost.byWorkload.reduce((m, w) => Math.max(m, w.costPerMo), 0.01)
              return (<>
              {/* KPI tiles */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: 'Total Workloads',  value: String(cost.byWorkload.length),     sub: `${totalWlPods} pods · top kind: ${topKind}`,          icon: Boxes,      bg: 'bg-surface-800 border-surface-700',   clr: 'text-white' },
                  { label: 'Total Cost',       value: fmt$(totalWlCost) + '/mo',          sub: 'based on resource requests',                           icon: DollarSign, bg: 'bg-brand-500/10 border-brand-500/20', clr: 'text-white' },
                  { label: 'No Resource Req',  value: String(noReqCount),                 sub: 'workloads with no CPU/mem requests',                   icon: AlertTriangle, bg: noReqCount > 0 ? 'bg-warning/5 border-warning/20' : 'bg-surface-800 border-surface-700', clr: noReqCount > 0 ? 'text-warning' : 'text-surface-400' },
                  { label: 'Cost per Pod',     value: totalWlPods > 0 ? fmt$(totalWlCost / totalWlPods) + '/mo' : '—', sub: 'average across all pods', icon: Server,     bg: 'bg-surface-800 border-surface-700',   clr: 'text-white' },
                ].map(k => (
                  <div key={k.label} className={cn('rounded-2xl border p-4', k.bg)}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-2xs text-surface-500 uppercase tracking-wider">{k.label}</p>
                      <k.icon className="w-3.5 h-3.5 text-surface-600" />
                    </div>
                    <p className={cn('text-2xl font-bold tabular-nums', k.clr)}>{k.value}</p>
                    <p className="text-2xs text-surface-600 mt-0.5">{k.sub}</p>
                  </div>
                ))}
              </div>

              {/* Top workloads bar chart */}
              {cost.byWorkload.filter(w => w.costPerMo > 0).length > 0 && (
                <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-xs font-semibold text-white flex items-center gap-2">
                      <BarChart3 className="w-4 h-4 text-brand-400" /> Top Workloads by Cost
                    </p>
                    <span className="text-xs font-bold text-white">{fmt$(totalWlCost)}/mo total</span>
                  </div>
                  <div className="space-y-2.5">
                    {[...cost.byWorkload].filter(w => w.costPerMo > 0).slice(0, 10).map((w, i) => {
                      const sharePct = totalWlCost > 0 ? Math.round(w.costPerMo / totalWlCost * 100) : 0
                      return (
                        <div key={i}>
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={cn('px-1.5 py-0.5 rounded text-2xs font-medium flex-shrink-0',
                                w.kind === 'Deployment' ? 'bg-brand-500/10 text-brand-400' :
                                w.kind === 'StatefulSet' ? 'bg-purple-500/10 text-purple-400' :
                                w.kind === 'DaemonSet'  ? 'bg-warning/10 text-warning' :
                                'bg-surface-800 text-surface-400')}>{w.kind}</span>
                              <span className="text-xs text-surface-300 font-mono truncate max-w-[200px]">{w.name}</span>
                              <span className="text-2xs text-surface-600 flex-shrink-0">{w.namespace}</span>
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              <span className="text-2xs text-surface-500">{sharePct}%</span>
                              <span className="text-xs font-bold text-white tabular-nums w-14 text-right">{fmt$(w.costPerMo)}/mo</span>
                            </div>
                          </div>
                          <div className="h-2 rounded-full bg-surface-800 overflow-hidden">
                            <div className="h-full rounded-full bg-brand-500/70 transition-all" style={{ width: `${(w.costPerMo / maxWlBar) * 100}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Search + NS filter + CSV (M2, M3, M4) */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[160px] max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500 pointer-events-none" />
                  <input value={wlSearch} onChange={e => setWlSearch(e.target.value)} placeholder="Filter workloads…"
                    className="w-full pl-8 pr-3 py-1.5 bg-surface-800 border border-surface-700 rounded-xl text-xs text-white outline-none focus:border-brand-500" />
                </div>
                <select value={wlNsFilter} onChange={e => setWlNsFilter(e.target.value)}
                  className="px-3 py-1.5 bg-surface-800 border border-surface-700 rounded-xl text-xs text-white outline-none focus:border-brand-500">
                  {wlNamespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                </select>
                <button onClick={() => exportCsv('workloads.csv',
                  ['Name','Namespace','Kind','Pods','CPU Req (c)','Mem Req (Gi)','Cost/mo'],
                  filteredWl.map(w => [[w.name],[w.namespace],[w.kind],[w.podCount],[w.cpuCores],[w.memGiB],[w.costPerMo]]))}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-400 hover:text-white transition-all">
                  <Download className="w-3.5 h-3.5" /> CSV
                </button>
              </div>
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-5 py-3 border-b border-surface-800 flex items-center justify-between">
                  <p className="text-xs font-semibold text-white">Top Workloads by Cost</p>
                  <p className="text-2xs text-surface-500">{filteredWl.length}/{cost.byWorkload.length} workloads</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-950">
                      <tr>
                        <SortTh<WorkloadCost> label="Workload" k="name" current={wlSort.key} dir={wlSort.dir} onSort={wlSort.toggle} cls="pl-5 min-w-40" />
                        <SortTh<WorkloadCost> label="Namespace" k="namespace" current={wlSort.key} dir={wlSort.dir} onSort={wlSort.toggle} />
                        <SortTh<WorkloadCost> label="Kind" k="kind" current={wlSort.key} dir={wlSort.dir} onSort={wlSort.toggle} />
                        <SortTh<WorkloadCost> label="Pods" k="podCount" current={wlSort.key} dir={wlSort.dir} onSort={wlSort.toggle} />
                        <SortTh<WorkloadCost> label="CPU Req" k="cpuCores" current={wlSort.key} dir={wlSort.dir} onSort={wlSort.toggle} />
                        <SortTh<WorkloadCost> label="Mem Req" k="memGiB" current={wlSort.key} dir={wlSort.dir} onSort={wlSort.toggle} />
                        <SortTh<WorkloadCost> label="Cost/mo" k="costPerMo" current={wlSort.key} dir={wlSort.dir} onSort={wlSort.toggle} />
                        <th className="px-3 py-2 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider w-32">Cost bar</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-800">
                      {filteredWl.map((w, i) => (
                        <tr key={i} className="hover:bg-surface-800/40 transition-colors">
                          <td className="pl-5 pr-3 py-3 font-mono text-white max-w-48 truncate">{w.name}</td>
                          <td className="px-3 py-3 text-surface-400 font-mono text-2xs">{w.namespace}</td>
                          <td className="px-3 py-3">
                            <span className={cn('px-1.5 py-0.5 rounded text-2xs font-medium',
                              w.kind === 'Deployment' ? 'bg-brand-500/10 text-brand-400' :
                              w.kind === 'StatefulSet' ? 'bg-purple-500/10 text-purple-400' :
                              w.kind === 'DaemonSet'  ? 'bg-warning/10 text-warning' :
                              'bg-surface-800 text-surface-400')}>
                              {w.kind}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-surface-300 tabular-nums">{w.podCount}</td>
                          <td className="px-3 py-3 text-surface-300 tabular-nums">{w.cpuCores}c</td>
                          <td className="px-3 py-3 text-surface-300 tabular-nums">{w.memGiB}Gi</td>
                          <td className="px-3 py-3 font-bold text-white tabular-nums">{w.costPerMo > 0 ? fmt$(w.costPerMo) : <span className="text-surface-600">—</span>}</td>
                          <td className="px-3 py-3">
                            <div className="w-28 h-2 rounded-full bg-surface-800">
                              <div className="h-full rounded-full bg-brand-500 transition-all"
                                style={{ width: `${(w.costPerMo / maxWlCost) * 100}%` }} />
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredWl.length === 0 && (
                        <tr><td colSpan={8} className="px-5 py-8 text-center text-surface-500 text-xs">
                          {cost.byWorkload.length === 0 ? 'No workload data. Pods may not have resource requests.' : 'No workloads match the filter.'}
                        </td></tr>
                      )}
                    </tbody>
                    {/* M5: totals row */}
                    {filteredWl.length > 0 && (
                      <tfoot className="bg-surface-950 border-t border-surface-700">
                        <tr>
                          <td className="pl-5 pr-3 py-2.5 text-2xs font-bold text-surface-400 uppercase tracking-wider">Total</td>
                          <td colSpan={2} />
                          <td className="px-3 py-2.5 font-bold text-surface-300 tabular-nums">{wlTotal.pods}</td>
                          <td colSpan={2} />
                          <td className="px-3 py-2.5 font-bold text-white tabular-nums">{fmt$(wlTotal.cost)}</td>
                          <td />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
              </>)
            })()}

            {/* ══ STORAGE ═══════════════════════════════════════════════════ */}
            {tab === 'Storage' && (() => {
              const usedPct       = storage.totalCapacityGiB > 0 ? Math.round(storage.totalUsedGiB / storage.totalCapacityGiB * 100) : 0
              const freeCap       = storage.totalCapacityGiB - storage.totalUsedGiB
              const freeCost      = storage.totalCapacityGiB > 0 ? storage.costPerMo * (freeCap / storage.totalCapacityGiB) : 0
              const criticalPvcs  = storage.pvcs.filter(p => p.usagePct > 90).length
              const warningPvcs   = storage.pvcs.filter(p => p.usagePct > 70 && p.usagePct <= 90).length
              const maxPvcCost    = storage.pvcs.reduce((m, p) => Math.max(m, p.costPerMo), 0.01)
              return (<>
              {/* KPI tiles */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: 'Storage Cost',    value: fmt$(storage.costPerMo) + '/mo',                sub: `${storage.totalPVCs} PVCs · ${storage.totalCapacityGiB.toFixed(0)} GiB total`,         icon: DollarSign,   bg: 'bg-brand-500/10 border-brand-500/20',  clr: 'text-white' },
                  { label: 'Used Capacity',   value: `${storage.totalUsedGiB.toFixed(1)} GiB`,       sub: `${usedPct}% of ${storage.totalCapacityGiB.toFixed(0)} GiB · ${freeCap.toFixed(1)} GiB free`, icon: HardDrive, bg: usedPct > 80 ? 'bg-warning/5 border-warning/20' : 'bg-surface-800 border-surface-700', clr: usedPct > 80 ? 'text-warning' : 'text-white' },
                  { label: 'Idle Capacity Cost', value: fmt$(freeCost) + '/mo',                      sub: `${100 - usedPct}% capacity unused`,                                                       icon: TrendingDown,  bg: freeCost > storage.costPerMo * 0.4 ? 'bg-warning/5 border-warning/20' : 'bg-surface-800 border-surface-700', clr: freeCost > storage.costPerMo * 0.4 ? 'text-warning' : 'text-success' },
                  { label: 'Near-Full PVCs',  value: String(criticalPvcs + warningPvcs),             sub: `${criticalPvcs} critical (>90%) · ${warningPvcs} warning (>70%)`,                         icon: AlertTriangle, bg: criticalPvcs > 0 ? 'bg-danger/5 border-danger/20' : warningPvcs > 0 ? 'bg-warning/5 border-warning/20' : 'bg-surface-800 border-surface-700', clr: criticalPvcs > 0 ? 'text-danger' : warningPvcs > 0 ? 'text-warning' : 'text-surface-400' },
                ].map(k => (
                  <div key={k.label} className={cn('rounded-2xl border p-4', k.bg)}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-2xs text-surface-500 uppercase tracking-wider">{k.label}</p>
                      <k.icon className="w-3.5 h-3.5 text-surface-600" />
                    </div>
                    <p className={cn('text-2xl font-bold tabular-nums', k.clr)}>{k.value}</p>
                    <p className="text-2xs text-surface-600 mt-0.5">{k.sub}</p>
                  </div>
                ))}
              </div>

              {/* Capacity usage bar + PVC cost chart */}
              {storage.pvcs.length > 0 && (
                <div className="grid lg:grid-cols-2 gap-4">
                  {/* Overall capacity gauge */}
                  <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
                    <p className="text-xs font-semibold text-white mb-4 flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-brand-400" /> Overall Capacity Utilisation
                    </p>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-2xs mb-1">
                        <span className="text-surface-400">Used: {storage.totalUsedGiB.toFixed(1)} GiB</span>
                        <span className="text-surface-400">Free: {freeCap.toFixed(1)} GiB</span>
                      </div>
                      <div className="h-4 rounded-full bg-surface-800 overflow-hidden flex">
                        <div className={cn('h-full transition-all', usedPct > 90 ? 'bg-danger' : usedPct > 70 ? 'bg-warning' : 'bg-success')}
                          style={{ width: `${usedPct}%` }} />
                      </div>
                      <p className={cn('text-lg font-bold tabular-nums text-center', usedPct > 90 ? 'text-danger' : usedPct > 70 ? 'text-warning' : 'text-success')}>{usedPct}% used</p>
                      <div className="grid grid-cols-3 gap-2 pt-1">
                        {[
                          { label: 'Critical (>90%)', count: criticalPvcs, clr: 'text-danger', bg: 'bg-danger/10 border-danger/20' },
                          { label: 'Warning (>70%)',  count: warningPvcs,  clr: 'text-warning', bg: 'bg-warning/10 border-warning/20' },
                          { label: 'Healthy',          count: storage.pvcs.length - criticalPvcs - warningPvcs, clr: 'text-success', bg: 'bg-success/10 border-success/20' },
                        ].map(s => (
                          <div key={s.label} className={cn('rounded-xl border p-2 text-center', s.bg)}>
                            <p className={cn('text-lg font-bold tabular-nums', s.clr)}>{s.count}</p>
                            <p className="text-2xs text-surface-500 mt-0.5">{s.label}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* PVC cost bar chart */}
                  <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-xs font-semibold text-white flex items-center gap-2">
                        <BarChart3 className="w-4 h-4 text-brand-400" /> PVC Cost Breakdown
                      </p>
                      <span className="text-xs font-bold text-white">{fmt$(storage.costPerMo)}/mo</span>
                    </div>
                    <div className="space-y-2.5">
                      {[...storage.pvcs].sort((a, b) => b.costPerMo - a.costPerMo).slice(0, 8).map((pvc, i) => (
                        <div key={i}>
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-xs text-surface-300 font-mono truncate max-w-[150px]">{pvc.name}</span>
                              <span className="text-2xs text-surface-600 flex-shrink-0">{pvc.namespace}</span>
                              {pvc.usagePct > 90 && <span className="text-2xs px-1 py-0.5 rounded bg-danger/10 text-danger border border-danger/20 flex-shrink-0">full</span>}
                              {pvc.usagePct > 70 && pvc.usagePct <= 90 && <span className="text-2xs px-1 py-0.5 rounded bg-warning/10 text-warning border border-warning/20 flex-shrink-0">high</span>}
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              {pvc.usagePct > 0 && <span className={cn('text-2xs tabular-nums', pvc.usagePct > 90 ? 'text-danger' : pvc.usagePct > 70 ? 'text-warning' : 'text-surface-500')}>{pvc.usagePct}%</span>}
                              <span className="text-xs font-bold text-white tabular-nums w-14 text-right">{fmt$(pvc.costPerMo)}/mo</span>
                            </div>
                          </div>
                          <div className="h-2 rounded-full bg-surface-800 overflow-hidden">
                            <div className={cn('h-full rounded-full transition-all', pvc.usagePct > 90 ? 'bg-danger/70' : pvc.usagePct > 70 ? 'bg-warning/70' : 'bg-brand-500/60')}
                              style={{ width: `${(pvc.costPerMo / maxPvcCost) * 100}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* PVC search + CSV (M2, M4) */}
              <div className="flex items-center gap-3">
                <div className="relative flex-1 max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500 pointer-events-none" />
                  <input value={pvcSearch} onChange={e => setPvcSearch(e.target.value)} placeholder="Filter PVCs…"
                    className="w-full pl-8 pr-3 py-1.5 bg-surface-800 border border-surface-700 rounded-xl text-xs text-white outline-none focus:border-brand-500" />
                </div>
                <button onClick={() => exportCsv('pvcs.csv',
                  ['Name','Namespace','Storage Class','Status','Capacity (Gi)','Used (Gi)','Usage%','Cost/mo'],
                  filteredPvcs.map(p => [[p.name],[p.namespace],[p.storageClass],[p.status],[p.capacityGiB],[p.usedGiB],[p.usagePct],[p.costPerMo]]))}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-400 hover:text-white transition-all">
                  <Download className="w-3.5 h-3.5" /> CSV
                </button>
              </div>

              {/* PVC table */}
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-5 py-3 border-b border-surface-800 flex items-center justify-between">
                  <p className="text-xs font-semibold text-white">PersistentVolumeClaims</p>
                  <p className="text-2xs text-surface-500">{filteredPvcs.length}/{storage.pvcs.length} PVCs</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-950">
                      <tr>
                        <SortTh<PvcInfo> label="Name" k="name" current={pvcSort.key} dir={pvcSort.dir} onSort={pvcSort.toggle} cls="pl-5 min-w-40" />
                        <SortTh<PvcInfo> label="Namespace" k="namespace" current={pvcSort.key} dir={pvcSort.dir} onSort={pvcSort.toggle} />
                        <SortTh<PvcInfo> label="Class" k="storageClass" current={pvcSort.key} dir={pvcSort.dir} onSort={pvcSort.toggle} />
                        <th className="px-3 py-2 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">Status</th>
                        <SortTh<PvcInfo> label="Capacity" k="capacityGiB" current={pvcSort.key} dir={pvcSort.dir} onSort={pvcSort.toggle} />
                        <SortTh<PvcInfo> label="Used" k="usedGiB" current={pvcSort.key} dir={pvcSort.dir} onSort={pvcSort.toggle} />
                        <SortTh<PvcInfo> label="Usage%" k="usagePct" current={pvcSort.key} dir={pvcSort.dir} onSort={pvcSort.toggle} />
                        <SortTh<PvcInfo> label="Cost/mo" k="costPerMo" current={pvcSort.key} dir={pvcSort.dir} onSort={pvcSort.toggle} />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-800">
                      {filteredPvcs.map((pvc, i) => (
                        <tr key={i} className="hover:bg-surface-800/40 transition-colors">
                          <td className="pl-5 pr-3 py-3 font-mono text-white max-w-48 truncate">{pvc.name}</td>
                          <td className="px-3 py-3 text-surface-400 font-mono text-2xs">{pvc.namespace}</td>
                          <td className="px-3 py-3 text-surface-400 text-2xs">{pvc.storageClass}</td>
                          <td className="px-3 py-3">
                            <span className={cn('px-1.5 py-0.5 rounded text-2xs font-medium',
                              pvc.status === 'Bound' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning')}>
                              {pvc.status}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-surface-300 tabular-nums">{pvc.capacityGiB.toFixed(1)} Gi</td>
                          <td className="px-3 py-3 text-surface-300 tabular-nums">{pvc.usedGiB > 0 ? `${pvc.usedGiB.toFixed(2)} Gi` : '—'}</td>
                          <td className="px-3 py-3 w-36">
                            {pvc.usagePct > 0 ? (
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-2 rounded-full bg-surface-800">
                                  <div className={cn('h-full rounded-full transition-all',
                                    pvc.usagePct > 90 ? 'bg-danger' : pvc.usagePct > 70 ? 'bg-warning' : 'bg-success')}
                                    style={{ width: `${pvc.usagePct}%` }} />
                                </div>
                                <span className={cn('text-2xs tabular-nums flex-shrink-0',
                                  pvc.usagePct > 90 ? 'text-danger' : pvc.usagePct > 70 ? 'text-warning' : 'text-surface-400')}>
                                  {pvc.usagePct}%
                                </span>
                              </div>
                            ) : <span className="text-surface-600">—</span>}
                          </td>
                          <td className="px-3 py-3 font-bold text-white tabular-nums">{fmt$(pvc.costPerMo)}</td>
                        </tr>
                      ))}
                      {filteredPvcs.length === 0 && (
                        <tr><td colSpan={8} className="px-5 py-8 text-center text-surface-500 text-xs">
                          {storage.pvcs.length === 0 ? 'No PVCs found in user namespaces.' : 'No PVCs match the filter.'}
                        </td></tr>
                      )}
                    </tbody>
                    {/* M5: totals row */}
                    {filteredPvcs.length > 0 && (
                      <tfoot className="bg-surface-950 border-t border-surface-700">
                        <tr>
                          <td className="pl-5 pr-3 py-2.5 text-2xs font-bold text-surface-400 uppercase tracking-wider">Total</td>
                          <td colSpan={3} />
                          <td className="px-3 py-2.5 font-bold text-surface-300 tabular-nums">{pvcTotal.cap.toFixed(1)} Gi</td>
                          <td className="px-3 py-2.5 font-bold text-surface-300 tabular-nums">{pvcTotal.used.toFixed(2)} Gi</td>
                          <td />
                          <td className="px-3 py-2.5 font-bold text-white tabular-nums">{fmt$(pvcTotal.cost)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
              </>)
            })()}

            {/* ══ OPTIMIZATIONS ═════════════════════════════════════════════ */}
            {tab === 'Optimizations' && (<>
              {/* Summary */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {(['critical', 'warning', 'info'] as const).map(sev => {
                  const items = optimizations.filter(o => o.severity === sev)
                  const savings = items.reduce((s, o) => s + o.savingsPotential, 0)
                  const sty = SEV_STYLE[sev]
                  return (
                    <div key={sev} className={cn('rounded-2xl border p-4', sty.bar)}>
                      <div className="flex items-center gap-2 mb-2">
                        <sty.icon className={cn('w-4 h-4', sev === 'critical' ? 'text-danger' : sev === 'warning' ? 'text-warning' : 'text-brand-400')} />
                        <p className="text-xs font-semibold text-white capitalize">{sev}</p>
                        <span className={cn('ml-auto px-2 py-0.5 rounded-full text-2xs font-bold border', sty.badge)}>{items.length}</span>
                      </div>
                      <p className="text-xl font-bold text-white tabular-nums">{items.length}</p>
                      {savings > 0 && <p className="text-xs text-success mt-0.5">{fmt$(savings)}/mo savings</p>}
                    </div>
                  )
                })}
              </div>

              {/* Search (M2) */}
              <div className="flex items-center gap-3">
                <div className="relative flex-1 max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500 pointer-events-none" />
                  <input value={optSearch} onChange={e => setOptSearch(e.target.value)} placeholder="Filter by namespace, workload, type…"
                    className="w-full pl-8 pr-3 py-1.5 bg-surface-800 border border-surface-700 rounded-xl text-xs text-white outline-none focus:border-brand-500" />
                </div>
                {optSearch && (
                  <span className="text-2xs text-surface-500">{filteredOpts.length}/{optimizations.length} shown</span>
                )}
              </div>

              {/* Full list */}
              <div className="space-y-3">
                {filteredOpts.length === 0 && optimizations.length === 0 && (
                  <div className="rounded-2xl bg-surface-900 border border-surface-800 p-8 text-center">
                    <CheckCircle2 className="w-10 h-10 text-success mx-auto mb-3" />
                    <p className="text-sm font-medium text-white">No optimizations needed</p>
                    <p className="text-xs text-surface-500 mt-1">Your cluster is efficiently provisioned</p>
                  </div>
                )}
                {filteredOpts.length === 0 && optimizations.length > 0 && (
                  <p className="text-xs text-surface-500 text-center py-8">No optimizations match the filter.</p>
                )}
                {(['critical', 'warning', 'info'] as const).map(sev => {
                  const items = filteredOpts.filter(o => o.severity === sev)
                  if (!items.length) return null
                  const sty = SEV_STYLE[sev]
                  return (
                    <div key={sev} className="space-y-3">
                      <p className={cn('text-2xs font-bold uppercase tracking-widest flex items-center gap-1.5',
                        sev === 'critical' ? 'text-danger' : sev === 'warning' ? 'text-warning' : 'text-brand-400')}>
                        <sty.icon className="w-3 h-3" /> {sev} · {items.length} issue{items.length !== 1 ? 's' : ''}
                        {items.reduce((s, o) => s + o.savingsPotential, 0) > 0 && (
                          <span className="ml-auto text-success font-bold">
                            {fmt$(items.reduce((s, o) => s + o.savingsPotential, 0))}/mo
                          </span>
                        )}
                      </p>
                      {items.map((o, i) => (
                        <motion.div key={i}
                          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.04 }}
                          className={cn('rounded-xl border p-4 space-y-3', sty.bar)}>

                          {/* ── Header row ────────────────────────── */}
                          <div className="flex items-start gap-3">
                            <sty.icon className={cn('w-4 h-4 mt-0.5 flex-shrink-0',
                              sev === 'critical' ? 'text-danger' : sev === 'warning' ? 'text-warning' : 'text-brand-400')} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                                <span className={cn('text-2xs px-1.5 py-0.5 rounded font-bold border uppercase tracking-wide', sty.badge)}>
                                  {TYPE_LABEL[o.type] ?? o.type}
                                </span>
                                <span className="text-xs font-semibold text-white">{o.namespace}</span>
                                {o.workload !== '(all workloads)' && (
                                  <span className="text-2xs font-mono text-surface-400">{o.workload}</span>
                                )}
                                {o.podCount !== undefined && (
                                  <span className="text-2xs text-surface-500 flex items-center gap-0.5">
                                    <Boxes className="w-3 h-3" />{o.podCount}p
                                  </span>
                                )}
                                {o.workloadCount !== undefined && o.workloadCount > 1 && (
                                  <span className="text-2xs text-surface-500">{o.workloadCount} wl</span>
                                )}
                                {o.priorityScore !== undefined && (
                                  <span className={cn('ml-auto text-2xs font-bold px-1.5 py-0.5 rounded border',
                                    o.priorityScore >= 70 ? 'text-danger border-danger/30 bg-danger/5' :
                                    o.priorityScore >= 40 ? 'text-warning border-warning/30 bg-warning/5' :
                                    'text-surface-500 border-surface-700 bg-surface-800')}>
                                    Score {o.priorityScore}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-surface-300 leading-relaxed">{o.reason}</p>
                            </div>
                            {o.savingsPotential > 0 && (
                              <div className="flex-shrink-0 text-right">
                                <p className="text-sm font-bold text-success">{fmt$(o.savingsPotential)}</p>
                                <p className="text-2xs text-surface-500">/mo savings</p>
                                {o.currentCost > 0 && (
                                  <p className="text-2xs text-surface-600 mt-0.5">
                                    {Math.round(o.savingsPotential / o.currentCost * 100)}% of {fmt$(o.currentCost)}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>

                          {/* ── Resource bars ─────────────────────── */}
                          {(o.cpuRequested !== undefined || o.memRequestedGiB !== undefined) && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-surface-800/60">
                              {o.cpuRequested !== undefined && o.cpuActual !== undefined && (
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-1.5 text-2xs text-surface-500">
                                    <Cpu className="w-3 h-3" /><span className="font-medium">CPU</span>
                                    {o.cpuSavings !== undefined && o.cpuSavings > 0 && (
                                      <span className="ml-auto text-success">{fmt$(o.cpuSavings)}/mo</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1.5 text-2xs">
                                    <span className="text-surface-500 w-14 text-right">{o.cpuRequested}c req</span>
                                    <div className="flex-1 h-2 bg-surface-800 rounded-full overflow-hidden">
                                      {o.cpuEfficiency != null && (
                                        <div className={cn('h-full rounded-full',
                                          o.cpuEfficiency >= 70 ? 'bg-success' : o.cpuEfficiency >= 40 ? 'bg-warning' : 'bg-danger')}
                                          style={{ width: `${o.cpuEfficiency}%` }} />
                                      )}
                                    </div>
                                    <span className={cn('w-12 text-right font-mono',
                                      (o.cpuEfficiency ?? 0) >= 70 ? 'text-success' : (o.cpuEfficiency ?? 0) >= 40 ? 'text-warning' : 'text-danger')}>
                                      {o.cpuActual}c
                                    </span>
                                  </div>
                                  {o.recommendedCpuM !== undefined && (
                                    <p className="text-2xs text-success/80">→ target: {o.recommendedCpuM}m ({o.cpuEfficiency}% eff)</p>
                                  )}
                                </div>
                              )}
                              {o.memRequestedGiB !== undefined && o.memActualGiB !== undefined && (
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-1.5 text-2xs text-surface-500">
                                    <MemoryStick className="w-3 h-3" /><span className="font-medium">Memory</span>
                                    {o.memSavings !== undefined && o.memSavings > 0 && (
                                      <span className="ml-auto text-success">{fmt$(o.memSavings)}/mo</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1.5 text-2xs">
                                    <span className="text-surface-500 w-14 text-right">{o.memRequestedGiB}Gi req</span>
                                    <div className="flex-1 h-2 bg-surface-800 rounded-full overflow-hidden">
                                      {o.memEfficiency != null && (
                                        <div className={cn('h-full rounded-full',
                                          o.memEfficiency >= 70 ? 'bg-success' : o.memEfficiency >= 40 ? 'bg-warning' : 'bg-danger')}
                                          style={{ width: `${o.memEfficiency}%` }} />
                                      )}
                                    </div>
                                    <span className={cn('w-14 text-right font-mono',
                                      (o.memEfficiency ?? 0) >= 70 ? 'text-success' : (o.memEfficiency ?? 0) >= 40 ? 'text-warning' : 'text-danger')}>
                                      {o.memActualGiB}Gi
                                    </span>
                                  </div>
                                  {o.recommendedMemMiB !== undefined && (
                                    <p className="text-2xs text-success/80">→ target: {o.recommendedMemMiB}Mi ({o.memEfficiency}% eff)</p>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {/* ── Expected outcome ──────────────────── */}
                          {o.savingsPotential > 0 && (
                            <div className="pt-1 border-t border-surface-800/60 space-y-2">
                              <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Expected Outcome</p>
                              <div className="flex flex-wrap gap-2">
                                {o.currentCost > 0 && (
                                  <div className="flex items-center gap-1.5 bg-surface-800/70 rounded-lg px-2.5 py-1.5">
                                    <DollarSign className="w-3 h-3 text-surface-500" />
                                    <span className="text-2xs font-mono text-surface-400">{fmt$(o.currentCost)}</span>
                                    <span className="text-2xs text-surface-600">→</span>
                                    <span className="text-2xs font-mono text-success font-bold">{fmt$(Math.max(0, o.currentCost - o.savingsPotential))}</span>
                                    <span className="text-2xs text-surface-500">/mo</span>
                                  </div>
                                )}
                                {o.cpuEfficiency != null && o.recommendedCpuM !== undefined && (() => {
                                  // B4: compute actual target efficiency = actual / (recommended/1000) capped at 100
                                  const recCores = o.recommendedCpuM / 1000
                                  const targetEff = o.cpuActual !== undefined && recCores > 0
                                    ? Math.min(100, Math.round(o.cpuActual / recCores * 100)) : null
                                  return (
                                    <div className="flex items-center gap-1.5 bg-surface-800/70 rounded-lg px-2.5 py-1.5">
                                      <Cpu className="w-3 h-3 text-surface-500" />
                                      <span className="text-2xs font-mono text-danger">{o.cpuEfficiency}%</span>
                                      <span className="text-2xs text-surface-600">→</span>
                                      <span className="text-2xs font-mono text-success font-bold">~{targetEff ?? 45}%</span>
                                      <span className="text-2xs text-surface-500">CPU eff</span>
                                    </div>
                                  )
                                })()}
                                {o.memEfficiency != null && o.recommendedMemMiB !== undefined && (() => {
                                  const recGiB = o.recommendedMemMiB / 1024
                                  const targetEff = o.memActualGiB !== undefined && recGiB > 0
                                    ? Math.min(100, Math.round(o.memActualGiB / recGiB * 100)) : null
                                  return (
                                    <div className="flex items-center gap-1.5 bg-surface-800/70 rounded-lg px-2.5 py-1.5">
                                      <MemoryStick className="w-3 h-3 text-surface-500" />
                                      <span className="text-2xs font-mono text-danger">{o.memEfficiency}%</span>
                                      <span className="text-2xs text-surface-600">→</span>
                                      <span className="text-2xs font-mono text-success font-bold">~{targetEff ?? 45}%</span>
                                      <span className="text-2xs text-surface-500">Mem eff</span>
                                    </div>
                                  )
                                })()}
                              </div>
                              <p className="text-2xs text-surface-500 leading-relaxed">
                                {OUTCOME_NOTE[o.type] ?? 'Apply the fix command below then monitor for 30 minutes.'}
                              </p>
                            </div>
                          )}

                          {/* ── Risk ──────────────────────────────── */}
                          {(() => {
                            const risk = RISK_INFO[o.type]
                            if (!risk) return null
                            const RiskIcon = risk.level === 'low' ? ShieldCheck : risk.level === 'medium' ? ShieldAlert : ShieldX
                            const riskCls = risk.level === 'low'
                              ? 'text-success border-success/25 bg-success/5'
                              : risk.level === 'medium'
                              ? 'text-warning border-warning/25 bg-warning/5'
                              : 'text-danger border-danger/25 bg-danger/5'
                            return (
                              <div className="flex items-start gap-3 pt-1 border-t border-surface-800/60">
                                <div className={cn('flex items-center gap-1.5 px-2 py-1 rounded-lg border flex-shrink-0', riskCls)}>
                                  <RiskIcon className="w-3 h-3" />
                                  <span className="text-2xs font-bold uppercase tracking-wide">{risk.level} risk</span>
                                </div>
                                <p className="text-2xs text-surface-400 leading-relaxed pt-0.5">{risk.note}</p>
                              </div>
                            )
                          })()}

                          {/* ── Fix + Verify commands ─────────────── */}
                          {o.kubectl && (
                            <div className="pt-1 border-t border-surface-800/60 space-y-2">
                              <div>
                                <p className="text-2xs text-surface-600 font-semibold mb-1.5 flex items-center gap-1">
                                  <Terminal className="w-3 h-3" /> Fix
                                </p>
                                <div className="flex items-start gap-2">
                                  <code className="flex-1 text-2xs font-mono bg-surface-950 border border-surface-800 rounded-lg px-3 py-2 text-surface-300 break-all select-all leading-relaxed">
                                    {o.kubectl}
                                  </code>
                                  <CopyBtn text={o.kubectl} />
                                </div>
                              </div>
                              <div>
                                <p className="text-2xs text-surface-600 font-semibold mb-1.5 flex items-center gap-1">
                                  <CheckCircle2 className="w-3 h-3" /> Verify (run after)
                                </p>
                                <div className="flex items-start gap-2">
                                  <code className="flex-1 text-2xs font-mono bg-surface-950 border border-surface-800 rounded-lg px-3 py-2 text-surface-400 break-all select-all leading-relaxed">
                                    {getVerifyCmd(o.type, o.namespace, o.workload)}
                                  </code>
                                  <CopyBtn text={getVerifyCmd(o.type, o.namespace, o.workload)} />
                                </div>
                              </div>
                            </div>
                          )}
                        </motion.div>
                      ))}
                    </div>
                  )
                })}
              </div>
            </>)}

          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

export default function CloudPage() {
  return (
    <Suspense fallback={null}>
      <CloudInner />
    </Suspense>
  )
}
