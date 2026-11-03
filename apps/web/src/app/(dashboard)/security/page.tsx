'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Shield, AlertTriangle, CheckCircle2, XCircle, Users, Network,
  Package, Server, Eye, RefreshCw, Wifi, WifiOff, Lock, AlertOctagon,
  Activity, ChevronDown, ChevronRight, Bug, Zap, Globe, Key, Wrench, Loader2,
} from 'lucide-react'
import { useLiveData } from '@/hooks/useLiveData'
import { cn, timeAgo } from '@/lib/utils'
import { getClusterHeaders, useDashboardStore } from '@/store'
import { useSession } from 'next-auth/react'
import type { FixType } from '@/app/api/security/fix/shared'

// -- Types ------------------------------------------------------------------
interface CisCheck {
  id: string; category: string; name: string
  pass: boolean | null; severity: 'critical' | 'high' | 'medium' | 'low'
  detail: string; count: number
}
interface RbacBinding {
  name: string; roleRef: string; roleKind: string
  isClusterAdmin: boolean
  subjects: { kind: string; name: string; namespace: string | null }[]
  createdAt: string
}
interface WildcardRole {
  name: string
  rules: { verbs: string[]; resources: string[]; apiGroups: string[] }[]
  createdAt: string
}
interface WorkloadFinding {
  pod: string; ns: string; container: string; containerType?: 'containers' | 'initContainers'; image?: string
  missingCpuLimit?: boolean; missingMemoryLimit?: boolean
  fixable?: boolean
}
interface NsRow {
  name: string; hasPolicy: boolean; defaultDenyIngress: boolean; defaultDenyEgress: boolean
  psaLevel: string | null; workloadRisks: number
}
interface WarningEvent {
  id: string; reason: string; message: string; ns: string; kind: string
  objName: string; count: number; lastTime: string
  priority: 'critical' | 'high' | 'medium' | 'unclassified'
}
interface SecurityData {
  score: number | null; grade: string
  kpis: {
    criticalFindings: number; highFindings: number; privilegedContainers: number
    latestTagImages: number; noLimitsContainers: number; noCpuLimitContainers: number; noMemoryLimitContainers: number
    namespacesWithoutNetpol: number; namespacesWithoutPsa: number
    wildcardRoles: number; falcoRunning: boolean; falcoDetected: boolean
    falcoPods: number; falcoDesiredPods: number; totalUserNS: number
  }
  controls: { checks: CisCheck[]; passed: number; failed: number; unknown: number; assessed: number }
  rbac: {
    clusterAdminBindings: RbacBinding[]; wildcardRoles: WildcardRole[]
    clusterRoleBindings: RbacBinding[]; totalNonSystemCRBs: number
  }
  workloads: {
    privileged: WorkloadFinding[]; latestTags: WorkloadFinding[]
    noLimits: WorkloadFinding[]; noReadOnlyRootFs: WorkloadFinding[]
    allowPrivEsc: WorkloadFinding[]; hostNetwork: WorkloadFinding[]
    hostPath: WorkloadFinding[]
  }
  namespaces: NsRow[]
  warningEvents: WarningEvent[]
  source: string
}

const EMPTY: SecurityData = {
  score: null, grade: '-',
  kpis: {
    criticalFindings: 0, highFindings: 0, privilegedContainers: 0,
    latestTagImages: 0, noLimitsContainers: 0, noCpuLimitContainers: 0, noMemoryLimitContainers: 0,
    namespacesWithoutNetpol: 0, namespacesWithoutPsa: 0, wildcardRoles: 0, falcoRunning: false, falcoDetected: false,
    falcoPods: 0, falcoDesiredPods: 0, totalUserNS: 0,
  },
  controls: { checks: [], passed: 0, failed: 0, unknown: 0, assessed: 0 },
  rbac: { clusterAdminBindings: [], wildcardRoles: [], clusterRoleBindings: [], totalNonSystemCRBs: 0 },
  workloads: { privileged: [], latestTags: [], noLimits: [], noReadOnlyRootFs: [], allowPrivEsc: [], hostNetwork: [], hostPath: [] },
  namespaces: [], warningEvents: [], source: 'loading',
}

const TABS = ['Overview', 'Controls', 'RBAC', 'Workloads', 'Warning Events'] as const
type Tab = typeof TABS[number]

// ── Fix modal / button ────────────────────────────────────────────────────────
interface FixTarget {
  type:           FixType
  label:          string     // human description shown in modal
  namespace:      string
  podName?:       string
  containerName?: string
  containerType?: 'containers' | 'initContainers'
}

function FixModal({ target, onConfirm, onClose, loading, result }: {
  target:    FixTarget
  onConfirm: () => void
  onClose:   () => void
  loading:   boolean
  result:    { ok: boolean; message: string } | null
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-2xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-800 flex items-center gap-2">
          <Wrench className="w-4 h-4 text-brand-400 flex-shrink-0" />
          <h2 className="text-sm font-semibold text-white">Apply Security Fix</h2>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-surface-300">This will apply the following patch to your live cluster:</p>
          <div className="bg-surface-950 rounded-xl border border-surface-800 p-3 text-xs font-mono text-brand-300 space-y-1">
            <div><span className="text-surface-500">fix:</span> {target.type}</div>
            <div><span className="text-surface-500">namespace:</span> {target.namespace}</div>
            {target.podName && <div><span className="text-surface-500">pod → deployment:</span> {target.podName}</div>}
            {target.containerName && <div><span className="text-surface-500">container:</span> {target.containerName}</div>}
            <div className="pt-1 border-t border-surface-800 text-surface-300">{target.label}</div>
          </div>
          <p className="text-2xs text-surface-500">The deployment will roll out a new revision. You can roll back with <code className="text-surface-300">kubectl rollout undo</code> if needed.</p>

          {(target.type === 'remove_host_network' || target.type === 'add_resource_limits') && (
            <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>
                {target.type === 'remove_host_network'
                  ? 'Review before applying — some pods (CNI agents, node exporters) legitimately require hostNetwork. Patching those will break cluster networking.'
                  : 'Review before applying — generic limits (500m CPU / 256Mi memory) may not suit this workload. Memory-heavy services will OOMKill with low limits.'}
              </span>
            </div>
          )}

          {result && (
            <div className={cn('rounded-xl border p-3 text-xs flex items-center gap-2',
              result.ok ? 'bg-success/10 border-success/30 text-success' : 'bg-danger/10 border-danger/30 text-danger')}>
              {result.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <XCircle className="w-4 h-4 flex-shrink-0" />}
              {result.message}
            </div>
          )}
        </div>
        <div className="px-5 pb-5 flex items-center gap-2 justify-end">
          <button onClick={onClose}
            className="px-4 py-2 rounded-xl bg-surface-800 hover:bg-surface-700 text-surface-300 text-xs transition-colors">
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button onClick={onConfirm} disabled={loading}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium transition-colors disabled:opacity-50">
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Apply Fix
            </button>
          )}
        </div>
      </motion.div>
    </div>
  )
}

function FixButton({ target, onFixed, canFix }: {
  target:   FixTarget
  onFixed?: () => void
  canFix:   boolean
}) {
  const [open,    setOpen]    = useState(false)
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<{ ok: boolean; message: string } | null>(null)

  if (!canFix) return null

  async function apply() {
    setLoading(true)
    try {
      const r = await fetch('/api/security/fix', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getClusterHeaders() },
        body:    JSON.stringify({
          type:          target.type,
          namespace:     target.namespace,
          podName:       target.podName,
          containerName: target.containerName,
          containerType: target.containerType,
        }),
      })
      const d = await r.json()
      if (r.ok) {
        setResult({ ok: true, message: d.applied ?? 'Fix applied successfully' })
        onFixed?.()
      } else {
        setResult({ ok: false, message: d.error ?? 'Fix failed' })
      }
    } catch (e: any) {
      setResult({ ok: false, message: e.message ?? 'Network error' })
    } finally {
      setLoading(false)
    }
  }

  function close() { setOpen(false); setResult(null) }

  return (
    <>
      <button
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-lg bg-brand-500/15 hover:bg-brand-500/25 text-brand-400 text-2xs font-medium border border-brand-500/20 transition-colors"
        title={target.label}
      >
        <Zap className="w-2.5 h-2.5" /> Fix
      </button>
      {open && (
        <FixModal target={target} onConfirm={apply} onClose={close} loading={loading} result={result} />
      )}
    </>
  )
}

const SEV_CLR: Record<string, string> = {
  critical: 'text-danger border-danger/30 bg-danger/10',
  high:     'text-orange-400 border-orange-500/30 bg-orange-500/10',
  medium:   'text-warning border-warning/30 bg-warning/10',
  low:      'text-info border-info/30 bg-info/10',
}
const SEV_DOT: Record<string, string> = {
  critical: 'bg-danger', high: 'bg-orange-400', medium: 'bg-warning', low: 'bg-info',
}
const GRADE_CLR: Record<string, string> = {
  A: 'text-success', B: 'text-teal-400', C: 'text-warning',
  D: 'text-orange-400', F: 'text-danger',
}
const SCORE_RING: Record<string, string> = {
  A: 'stroke-success', B: 'stroke-teal-400', C: 'stroke-warning',
  D: 'stroke-orange-400', F: 'stroke-danger',
}

function ScoreGauge({ score, grade }: { score: number | null; grade: string }) {
  const r = 52; const circ = 2 * Math.PI * r
  const offset = score === null ? circ : circ - (score / 100) * circ
  return (
    <div className="relative w-36 h-36 flex-shrink-0">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="currentColor" strokeWidth="8" className="text-surface-800" />
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="8"
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round"
          className={cn('transition-all duration-700', SCORE_RING[grade] ?? 'stroke-surface-600')}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('text-3xl font-black tabular-nums', GRADE_CLR[grade] ?? 'text-surface-400')}>{score === null ? '—' : grade}</span>
        <span className="text-sm font-semibold text-white tabular-nums">{score === null ? 'Not scored' : `${score}%`}</span>
      </div>
    </div>
  )
}

function KpiCard({ label, value, sub, color = 'text-white', warn = false, onClick }: {
  label: string; value: string | number; sub?: string; color?: string; warn?: boolean; onClick?: () => void
}) {
  const content = <>
      <span className="text-2xs text-surface-500 uppercase tracking-wider font-medium">{label}</span>
      <span className={cn('text-2xl font-black tabular-nums', color)}>{value}</span>
      {sub && <span className="text-2xs text-surface-500">{sub}</span>}
  </>
  const className = cn('rounded-2xl bg-surface-900 border p-4 flex flex-col gap-1', warn ? 'border-danger/30' : 'border-surface-800', onClick && 'w-full text-left hover:border-brand-500/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 cursor-pointer')
  return onClick
    ? <button type="button" className={className} onClick={onClick} aria-label={`${label}: ${value}. Open related findings.`}>{content}</button>
    : <div className={className}>{content}</div>
}

function CisRow({ check }: { check: CisCheck }) {
  const [open, setOpen] = useState(false)
  const unknown = check.pass === null
  return (
    <div className={cn('rounded-xl border transition-all', check.pass === true ? 'border-surface-800 bg-surface-900/60' : unknown ? 'border-surface-700 bg-surface-900/40' : 'border-danger/20 bg-danger/5')}>
      <button className="w-full flex items-center gap-3 px-4 py-3 text-left" onClick={() => setOpen(o => !o)}>
        {check.pass === true
          ? <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
          : unknown ? <AlertTriangle className="w-4 h-4 text-surface-500 flex-shrink-0" />
          : <XCircle className="w-4 h-4 text-danger flex-shrink-0" />}
        <span className="text-2xs font-mono text-surface-500 w-14 flex-shrink-0">{check.id}</span>
        <span className="flex-1 text-sm text-white">{check.name}</span>
        <span className={cn('text-2xs px-1.5 py-0.5 rounded border font-medium capitalize flex-shrink-0', unknown ? 'text-surface-400 border-surface-700 bg-surface-800' : SEV_CLR[check.severity])}>{unknown ? 'Not assessed' : check.pass ? 'Pass' : check.severity}</span>
        <ChevronDown className={cn('w-3.5 h-3.5 text-surface-500 flex-shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
            <p className="px-4 pb-3 text-xs text-surface-400 border-t border-surface-800/50 pt-2">{check.detail}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function WorkloadSection({ label, Icon, color, items, note, fixType, onFixed, canFix, initiallyOpen }: {
  label: string; Icon: React.ElementType; color: string
  items: WorkloadFinding[]; note: string
  fixType?: FixType
  onFixed?: () => void
  canFix?: boolean
  initiallyOpen?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen ?? (items.length > 0 && items.length <= 5))
  return (
    <div className={cn('rounded-2xl border transition-all', items.length === 0 ? 'border-surface-800 bg-surface-900/50' : 'border-surface-700 bg-surface-900')}>
      <button className="w-full flex items-center gap-3 px-4 py-3.5 text-left" onClick={() => setOpen(o => !o)}>
        <div className={cn('w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0', items.length === 0 ? 'bg-success/10' : 'bg-surface-800')}>
          {items.length === 0
            ? <CheckCircle2 className="w-4 h-4 text-success" />
            : <Icon className={cn('w-4 h-4', color)} />}
        </div>
        <span className="flex-1 text-sm font-medium text-white">{label}</span>
        {fixType && items.some(item => item.fixable) && canFix && (
          <span className="text-2xs px-2 py-0.5 rounded-lg bg-brand-500/10 text-brand-400 border border-brand-500/20 flex items-center gap-1 mr-1">
            <Zap className="w-2.5 h-2.5" /> auto-fixable
          </span>
        )}
        <span className={cn('text-sm font-bold tabular-nums mr-2', items.length === 0 ? 'text-success' : color)}>{items.length}</span>
        {items.length > 0 && <ChevronDown className={cn('w-4 h-4 text-surface-500 transition-transform', open && 'rotate-180')} />}
      </button>
      <AnimatePresence initial={false}>
        {open && items.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
            <div className="border-t border-surface-800 px-4 pt-3 pb-4 space-y-2">
              <p className="text-2xs text-surface-500 italic mb-3">{note}</p>
              {items.slice(0, 20).map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-surface-800/50 last:border-0">
                  <span className="font-mono text-surface-300 flex-1 truncate">{item.ns}/{item.pod}</span>
                  <span className="font-mono text-surface-500 flex-shrink-0">{item.containerType === 'initContainers' ? 'init:' : ''}{item.container}</span>
                  {item.missingCpuLimit && <span className="text-2xs text-warning">CPU limit missing</span>}
                  {item.missingMemoryLimit && <span className="text-2xs text-warning">Memory limit missing</span>}
                  {item.image && <span className="font-mono text-brand-400/70 text-2xs truncate max-w-40">{item.image.split('/').pop()}</span>}
                  {fixType && item.fixable && (
                    <FixButton
                      canFix={!!canFix}
                      onFixed={onFixed}
                      target={{
                        type:          fixType,
                        label:         fixType === 'set_no_priv_esc'     ? 'Set allowPrivilegeEscalation: false'
                                     : fixType === 'remove_host_network'  ? 'Set hostNetwork: false'
                                     : fixType === 'add_resource_limits'  ? 'Add CPU + memory limits (500m / 256Mi)'
                                     : fixType === 'set_read_only_root_fs' ? 'Set readOnlyRootFilesystem: true'
                                     : 'Apply fix',
                        namespace:     item.ns,
                        podName:       item.pod,
                        containerName: item.container,
                        containerType: item.containerType,
                      }}
                    />
                  )}
                </div>
              ))}
              {items.length > 20 && <p className="text-2xs text-surface-500 text-center pt-1">+{items.length - 20} more</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function SecurityPage() {
  return (
    <Suspense fallback={null}>
      <SecurityInner />
    </Suspense>
  )
}

function SecurityInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { activeCluster } = useDashboardStore()
  const { data: session } = useSession()
  const role    = (session?.user as any)?.role ?? ''
  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get('tab')
    return (TABS as readonly string[]).includes(t ?? '') ? t as Tab : 'Overview'
  })
  const [controlsSeverity, setControlsSeverity] = useState<CisCheck['severity'] | null>(() => {
    const severity = searchParams.get('severity')
    return severity === 'critical' || severity === 'high' || severity === 'medium' || severity === 'low' ? severity : null
  })
  const [namespaceFinding, setNamespaceFinding] = useState<'network-policy' | 'psa-enforce' | null>(() => {
    const finding = searchParams.get('namespaceFinding')
    return finding === 'network-policy' || finding === 'psa-enforce' ? finding : null
  })
  const [workloadFinding, setWorkloadFinding] = useState<'latest-tags' | 'cpu-limits' | 'memory-limits' | null>(() => {
    const finding = searchParams.get('workloadFinding')
    return finding === 'latest-tags' || finding === 'cpu-limits' || finding === 'memory-limits' ? finding : null
  })
  const { data, isLive, refresh, loading, error } = useLiveData<SecurityData>(
    '/api/security', EMPTY, undefined, 60_000,
  )
  const canFix = isLive && (role === 'admin' || role === 'operator')
  const [lastScanned, setLastScanned] = useState<Date | null>(null)
  useEffect(() => { if (data !== EMPTY) setLastScanned(new Date()) }, [data])
  const hasScan = lastScanned !== null
  const displayCount = (value: number) => hasScan ? value : '—'
  const { kpis, controls, rbac, workloads, namespaces, warningEvents } = data

  const navigateToFinding = (targetTab: Tab, filter: Record<string, string>) => {
    setTab(targetTab)
    setControlsSeverity((filter.severity as CisCheck['severity'] | undefined) ?? null)
    setNamespaceFinding((filter.namespaceFinding as 'network-policy' | 'psa-enforce' | undefined) ?? null)
    setWorkloadFinding((filter.workloadFinding as 'latest-tags' | 'cpu-limits' | 'memory-limits' | undefined) ?? null)
    router.replace(`?${new URLSearchParams({ tab: targetTab, ...filter }).toString()}`, { scroll: false })
  }

  const clearFindingFilter = () => navigateToFinding(tab, {})

  useEffect(() => {
    if (tab !== 'Overview' || !namespaceFinding) return
    requestAnimationFrame(() => document.getElementById('namespace-risk-matrix')?.scrollIntoView({ block: 'start' }))
  }, [tab, namespaceFinding])

  const controlsByCategory: Record<string, CisCheck[]> = {}
  for (const c of controls.checks.filter(check => !controlsSeverity || check.severity === controlsSeverity)) {
    if (!controlsByCategory[c.category]) controlsByCategory[c.category] = []
    controlsByCategory[c.category].push(c)
  }
  const filteredNamespaces = namespaces.filter(ns =>
    !namespaceFinding || (namespaceFinding === 'network-policy' ? !ns.hasPolicy : !ns.psaLevel)
  )
  const focusedWorkload = workloadFinding === 'latest-tags'
    ? { label: ':latest Image Tags', Icon: Package, color: 'text-warning', items: workloads.latestTags, note: 'Use pinned version tags or digest references (image@sha256:...) to ensure reproducible, auditable deployments.' }
    : workloadFinding === 'cpu-limits'
      ? { label: 'Missing CPU Limit', Icon: Zap, color: 'text-warning', items: workloads.noLimits.filter(item => item.missingCpuLimit), note: 'These containers are missing CPU limits.' }
      : workloadFinding === 'memory-limits'
        ? { label: 'Missing Memory Limit', Icon: Zap, color: 'text-warning', items: workloads.noLimits.filter(item => item.missingMemoryLimit), note: 'These containers are missing memory limits.' }
        : null
  const catOrder = ['Network Policies', 'Pod Security Admission', 'RBAC', 'Pod Security', 'Image Security', 'Resource Management', 'Secrets Management']

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-brand-400" /> Security Posture
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">
            {activeCluster && <><span className="text-surface-300 font-medium">{activeCluster.name ?? activeCluster.displayName}</span>{' · '}</>}{hasScan ? `Selected security controls · ${controls.assessed}/${controls.checks.length} assessed` : 'Security scan unavailable'}
            {kpis.falcoDetected && <span className={cn('ml-2', kpis.falcoRunning ? 'text-success' : 'text-warning')}>· Falco DaemonSet {kpis.falcoRunning ? `${kpis.falcoPods}/${kpis.falcoDesiredPods} ready` : 'not ready'}</span>}
            {lastScanned && <span className="text-surface-600 ml-2" suppressHydrationWarning>· scanned {timeAgo(lastScanned.toISOString())}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {kpis.falcoDetected && (
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-success/10 border border-success/20 rounded-xl text-xs text-success">
              <Eye className="w-3 h-3" /> Falco DaemonSet
            </span>
          )}
          {isLive
            ? <span className="flex items-center gap-1.5 px-2.5 py-1 bg-success/10 border border-success/20 rounded-xl text-xs text-success"><Wifi className="w-3 h-3" /> Live</span>
            : <span className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-800 border border-surface-700 rounded-xl text-xs text-surface-400"><WifiOff className="w-3 h-3" /> Offline</span>
          }
          {error && (
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-warning/5 border border-warning/20 rounded-xl text-xs text-warning/80">
              <AlertTriangle className="w-3 h-3" /> {error}
            </span>
          )}
          {!isLive && hasScan && <span className="text-2xs text-warning">Showing last successful scan</span>}
          <button onClick={refresh} disabled={loading}
            className="w-8 h-8 flex items-center justify-center bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-surface-400 hover:text-white transition-all disabled:opacity-50">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
          {kpis.criticalFindings > 0 && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 bg-danger/10 border border-danger/20 rounded-xl text-xs font-medium text-danger">
              <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
              {kpis.criticalFindings} Critical
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 px-3 sm:px-6 pt-2 sm:pt-3 border-b border-surface-800 overflow-x-auto scrollbar-none flex-shrink-0">
        {TABS.map(t => (
          <button key={t} onClick={() => navigateToFinding(t, {})}
            className={cn('px-3 py-2 text-sm font-medium border-b-2 transition-all',
              tab === t ? 'border-brand-500 text-brand-400' : 'border-transparent text-surface-400 hover:text-surface-300')}>
            {t}
            {t === 'Warning Events' && warningEvents.length > 0 && <span className="ml-1.5 text-2xs px-1.5 py-0.5 bg-warning/20 text-warning rounded-full">{warningEvents.length}</span>}
            {t === 'Controls' && controls.failed > 0 && <span className="ml-1.5 text-2xs px-1.5 py-0.5 bg-danger/20 text-danger rounded-full">{controls.failed}</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-5">

        {tab === 'Overview' && (
          <>
            <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
              <div className="flex items-start gap-6">
                <ScoreGauge score={data.score} grade={data.grade} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-1">
                    <h2 className="text-base font-bold text-white">Selected Controls Score</h2>
                    <span className="text-2xs text-surface-500">Custom weighted score · {controls.assessed}/{controls.checks.length} assessed · {controls.unknown} unknown · {lastScanned ? <span suppressHydrationWarning>scanned {timeAgo(lastScanned.toISOString())}</span> : 'waiting for scan'}</span>
                  </div>
                  <p className="text-xs text-surface-400 mb-4">
                    {data.score === null ? 'No controls were available to score.' :
                     data.score >= 90 ? 'Strong results across assessed controls; this is not a full benchmark certification.' :
                     data.score >= 75 ? 'Good results across assessed controls; review remaining findings.' :
                     data.score >= 60 ? 'Mixed results across assessed controls; address high-severity findings.' :
                     data.score >= 45 ? 'Significant gaps remain in the assessed controls.' :
                     'Many assessed controls have findings; review them before making changes.'}
                  </p>
                  <div className="space-y-2">
                    {catOrder.filter(c => controlsByCategory[c]).map(cat => {
                      const checks = controlsByCategory[cat]
                      const assessed = checks.filter(c => c.pass !== null)
                      const pct = assessed.length ? Math.round((assessed.filter(c => c.pass).length / assessed.length) * 100) : 0
                      return (
                        <div key={cat} className="flex items-center gap-3">
                          <span className="text-2xs text-surface-400 w-44 flex-shrink-0">{cat}{checks.some(c => c.pass === null) ? ' *' : ''}</span>
                          <div className="flex-1 h-1.5 rounded-full bg-surface-800">
                            <div className={cn('h-full rounded-full', pct === 100 ? 'bg-success' : pct >= 50 ? 'bg-warning' : 'bg-danger')} style={{ width: `${pct}%` }} />
                          </div>
                          <span className={cn('text-2xs tabular-nums w-8 text-right', pct === 100 ? 'text-success' : pct >= 50 ? 'text-warning' : 'text-danger')}>{pct}%</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-7 gap-3">
              <KpiCard label="Critical Findings" value={displayCount(kpis.criticalFindings)} color={!hasScan ? 'text-surface-400' : kpis.criticalFindings > 0 ? 'text-danger' : 'text-success'} warn={hasScan && kpis.criticalFindings > 0} sub="assessed controls" onClick={hasScan && kpis.criticalFindings > 0 ? () => navigateToFinding('Controls', { severity: 'critical' }) : undefined} />
              <KpiCard label="High Findings" value={displayCount(kpis.highFindings)} color={!hasScan ? 'text-surface-400' : kpis.highFindings > 0 ? 'text-orange-400' : 'text-success'} sub="assessed controls" onClick={hasScan && kpis.highFindings > 0 ? () => navigateToFinding('Controls', { severity: 'high' }) : undefined} />
              <KpiCard label="No NetworkPolicy" value={hasScan && kpis.totalUserNS > 0 ? `${kpis.namespacesWithoutNetpol}/${kpis.totalUserNS}` : '—'} color={!hasScan || kpis.totalUserNS === 0 ? 'text-surface-400' : kpis.namespacesWithoutNetpol > 0 ? 'text-danger' : 'text-success'} sub="user namespaces" onClick={hasScan && kpis.namespacesWithoutNetpol > 0 ? () => navigateToFinding('Overview', { namespaceFinding: 'network-policy' }) : undefined} />
              <KpiCard label="Missing PSA Enforce" value={hasScan && kpis.totalUserNS > 0 ? `${kpis.namespacesWithoutPsa}/${kpis.totalUserNS}` : '—'} color={!hasScan || kpis.totalUserNS === 0 ? 'text-surface-400' : kpis.namespacesWithoutPsa > 0 ? 'text-danger' : 'text-success'} sub="user namespaces" onClick={hasScan && kpis.namespacesWithoutPsa > 0 ? () => navigateToFinding('Overview', { namespaceFinding: 'psa-enforce' }) : undefined} />
              <KpiCard label=":latest Images" value={displayCount(kpis.latestTagImages)} color={!hasScan ? 'text-surface-400' : kpis.latestTagImages > 0 ? 'text-warning' : 'text-success'} sub="mutable tags" onClick={hasScan && kpis.latestTagImages > 0 ? () => navigateToFinding('Workloads', { workloadFinding: 'latest-tags' }) : undefined} />
              <KpiCard label="Missing CPU Limit" value={displayCount(kpis.noCpuLimitContainers)} color={!hasScan ? 'text-surface-400' : kpis.noCpuLimitContainers > 0 ? 'text-warning' : 'text-success'} sub="containers" onClick={hasScan && kpis.noCpuLimitContainers > 0 ? () => navigateToFinding('Workloads', { workloadFinding: 'cpu-limits' }) : undefined} />
              <KpiCard label="Missing Memory Limit" value={displayCount(kpis.noMemoryLimitContainers)} color={!hasScan ? 'text-surface-400' : kpis.noMemoryLimitContainers > 0 ? 'text-warning' : 'text-success'} sub="containers" onClick={hasScan && kpis.noMemoryLimitContainers > 0 ? () => navigateToFinding('Workloads', { workloadFinding: 'memory-limits' }) : undefined} />
            </div>

            <div className={cn('rounded-2xl border p-4 flex items-center gap-4', kpis.falcoRunning ? 'bg-success/5 border-success/20' : 'bg-surface-900 border-surface-800')}>
              <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', kpis.falcoRunning ? 'bg-success/15' : 'bg-surface-800')}>
                <Eye className={cn('w-5 h-5', kpis.falcoRunning ? 'text-success' : 'text-surface-500')} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white mb-0.5">Falco Runtime Security · {!hasScan ? 'Status unavailable' : kpis.falcoRunning ? 'Ready' : kpis.falcoDetected ? 'Detected, not ready' : 'Not detected'}</div>
                <p className="text-xs text-surface-400">
                  {!hasScan ? 'A successful cluster scan is required to detect Falco.' : kpis.falcoDetected
                    ? `${kpis.falcoPods}/${kpis.falcoDesiredPods} Falco DaemonSet pods are ready. Readiness does not confirm event delivery or rule coverage.`
                    : 'No Falco DaemonSet detected by image or app label.'}
                </p>
              </div>
              {kpis.falcoDetected && <span className={cn('text-2xs px-2 py-1 rounded-xl font-medium flex-shrink-0', kpis.falcoRunning ? 'bg-success/20 text-success' : 'bg-warning/20 text-warning')}>{kpis.falcoRunning ? 'Pods Ready' : 'Not Ready'}</span>}
            </div>

            <div id="namespace-risk-matrix" className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden scroll-mt-4">
              <div className="px-4 py-3 border-b border-surface-800">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Globe className="w-4 h-4 text-brand-400" /> Namespace Risk Matrix
                  </h3>
                  {namespaceFinding && <button type="button" onClick={clearFindingFilter} className="text-2xs text-brand-400 hover:text-brand-300 hover:underline">Clear namespace filter</button>}
                </div>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-800">
                    {['Namespace', 'NetworkPolicy coverage', 'Pod Security Admission', 'Workload Findings', 'Risk Level'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredNamespaces.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-surface-500">{!hasScan ? 'Namespace scan unavailable' : namespaces.length === 0 ? 'No user namespaces found' : 'No namespaces match this finding'}</td></tr>
                  )}
                  {filteredNamespaces.map(ns => {
                    const hasDefaultDeny = ns.defaultDenyIngress && ns.defaultDenyEgress
                    const risk = !ns.hasPolicy && !ns.psaLevel ? 'critical' : !hasDefaultDeny || !ns.psaLevel ? 'high' : ns.workloadRisks > 5 ? 'medium' : 'low'
                    return (
                      <tr key={ns.name} className="border-b border-surface-800/50 hover:bg-surface-800/30">
                        <td className="px-4 py-2.5 font-mono text-xs text-white">{ns.name}</td>
                        <td className="px-4 py-2.5">
                          {!ns.hasPolicy
                            ? <span className="flex items-center gap-1 text-danger text-xs"><XCircle className="w-3 h-3" /> No policy</span>
                            : hasDefaultDeny
                              ? <span className="flex items-center gap-1 text-success text-xs"><CheckCircle2 className="w-3 h-3" /> Default deny both</span>
                              : <span className="text-warning text-xs">Policy present; no full default deny</span>}
                        </td>
                        <td className="px-4 py-2.5">
                          {ns.psaLevel
                            ? <span className="text-2xs px-2 py-0.5 bg-success/15 text-success rounded border border-success/20">{ns.psaLevel}</span>
                            : <span className="flex items-center gap-2">
                                <span className="text-2xs px-2 py-0.5 bg-danger/10 text-danger rounded border border-danger/20">None</span>
                                <FixButton
                                  canFix={canFix}
                                  onFixed={refresh}
                                  target={{
                                    type:      'add_psa_label',
                                    label:     'Add pod-security.kubernetes.io/enforce: baseline label',
                                    namespace: ns.name,
                                  }}
                                />
                              </span>
                          }
                        </td>
                        <td className="px-4 py-2.5 text-surface-400 text-xs tabular-nums">{ns.workloadRisks}</td>
                        <td className="px-4 py-2.5">
                          <span className={cn('text-2xs px-2 py-0.5 rounded border font-medium capitalize', SEV_CLR[risk])}>{risk}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>
          </>
        )}

        {tab === 'Controls' && (
          <>            <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">Selected Security Controls</h3>
                  <p className="text-2xs text-surface-500 mt-0.5">{hasScan ? `${controls.passed} passed · ${controls.failed} failed · ${controls.unknown} not assessed` : 'No successful scan; results unavailable'}</p>
                </div>
                <span className={cn('text-2xl font-black tabular-nums', GRADE_CLR[data.grade] ?? 'text-surface-400')}>{data.score === null ? '—' : `${data.score}%`}</span>
              </div>
              <div className="h-2 rounded-full bg-surface-800 overflow-hidden">
                <div className={cn('h-full rounded-full transition-all duration-700', (data.score ?? 0) >= 75 ? 'bg-success' : (data.score ?? 0) >= 50 ? 'bg-warning' : 'bg-danger')} style={{ width: `${data.score ?? 0}%` }} />
              </div>
            </div>
            {controlsSeverity && (
              <div className="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900 px-3 py-2 text-xs">
                <span className="text-surface-300">Showing {controlsSeverity} findings</span>
                <button type="button" onClick={clearFindingFilter} className="text-brand-400 hover:text-brand-300 hover:underline">Clear filter</button>
              </div>
            )}
            {catOrder.filter(cat => controlsByCategory[cat]).map(cat => (
              <div key={cat}>
                <h4 className="text-xs font-semibold text-surface-500 uppercase tracking-wider mb-2 px-1">{cat}</h4>
                <div className="space-y-1.5">
                  {controlsByCategory[cat].map(check => <CisRow key={check.id} check={check} />)}
                </div>
              </div>
            ))}
            {controlsSeverity && Object.keys(controlsByCategory).length === 0 && <p className="py-8 text-center text-sm text-surface-500">No {controlsSeverity} findings.</p>}
            <p className="text-2xs text-surface-600 text-center pt-2">
              This custom weighted score covers only the controls listed here; it is not a CIS benchmark certification.
            </p>
          </>
        )}

        {tab === 'RBAC' && (
          <>
            <section>
              <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                <AlertOctagon className="w-4 h-4 text-danger" /> Cluster-Admin Bindings ({rbac.clusterAdminBindings.length})
              </h3>
              {rbac.clusterAdminBindings.length === 0
                ? <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4 text-xs text-success flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> No non-system cluster-admin bindings detected</div>
                : <div className="space-y-2">
                    {rbac.clusterAdminBindings.map(rb => (
                      <div key={rb.name} className="rounded-2xl bg-danger/5 border border-danger/20 p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-sm font-mono text-white">{rb.name}</span>
                          <span className="text-2xs px-1.5 py-0.5 bg-danger/20 text-danger rounded border border-danger/30">cluster-admin</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {rb.subjects.map((s, i) => (
                            <span key={i} className="text-2xs px-2 py-1 bg-surface-800 rounded text-surface-300 font-mono">{s.kind}: {s.name}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
              }
            </section>

            <section>
              <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                <Key className="w-4 h-4 text-orange-400" /> Wildcard ClusterRoles ({rbac.wildcardRoles.length})
              </h3>
              {rbac.wildcardRoles.length === 0
                ? <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4 text-xs text-success flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> No wildcard ClusterRoles detected</div>
                : <div className="space-y-2">
                    {rbac.wildcardRoles.map(role => (
                      <div key={role.name} className="rounded-2xl bg-surface-900 border border-orange-500/20 p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-sm font-mono text-white">{role.name}</span>
                          <span className="text-2xs px-1.5 py-0.5 bg-orange-500/15 text-orange-400 rounded border border-orange-500/30">wildcard</span>
                        </div>
                        <div className="space-y-1">
                          {role.rules.map((rule, i) => (
                            <div key={i} className="flex items-center gap-2 text-2xs text-surface-400 font-mono">
                              <span className="text-orange-400">verbs=[{rule.verbs.join(',')}]</span>
                              <span>resources=[{rule.resources.join(',')}]</span>
                              {rule.apiGroups.length > 0 && <span>apiGroups=[{rule.apiGroups.join(',')}]</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
              }
            </section>

            <section>
              <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                <Users className="w-4 h-4 text-brand-400" /> All Non-System ClusterRoleBindings ({rbac.totalNonSystemCRBs})
              </h3>
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-800">
                      {['Binding Name', 'Role', 'Subjects'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rbac.clusterRoleBindings.map(rb => (
                      <tr key={rb.name} className={cn('border-b border-surface-800/50 hover:bg-surface-800/30', rb.isClusterAdmin && 'bg-danger/5')}>
                        <td className="px-4 py-2.5 font-mono text-xs text-white">{rb.name}</td>
                        <td className="px-4 py-2.5">
                          <span className={cn('text-2xs px-1.5 py-0.5 rounded border font-mono',
                            rb.isClusterAdmin ? 'text-danger border-danger/30 bg-danger/10' : 'text-brand-400 border-brand-500/20 bg-brand-500/10'
                          )}>{rb.roleRef}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {rb.subjects.map((s, i) => (
                              <span key={i} className="text-2xs px-1.5 py-0.5 bg-surface-800 rounded text-surface-300 font-mono">{s.kind[0]}: {s.name}</span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            </section>
          </>
        )}

        {tab === 'Workloads' && (
          <>
            {workloadFinding && (
              <div className="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900 px-3 py-2 text-xs">
                <span className="text-surface-300">Focused on {focusedWorkload?.label}</span>
                <button type="button" onClick={clearFindingFilter} className="text-brand-400 hover:text-brand-300 hover:underline">Show all workload findings</button>
              </div>
            )}
            {focusedWorkload ? (
              <WorkloadSection label={focusedWorkload.label} Icon={focusedWorkload.Icon} color={focusedWorkload.color}
                items={focusedWorkload.items} note={focusedWorkload.note} initiallyOpen />
            ) : (
              <>
                <WorkloadSection label="Privileged Containers" Icon={AlertOctagon} color="text-danger"
                  items={workloads.privileged} note="Falco pods run privileged by design for kernel-level syscall monitoring. Non-Falco privileged containers should be remediated." />
                <WorkloadSection label=":latest Image Tags" Icon={Package} color="text-warning"
                  items={workloads.latestTags} note="Use pinned version tags or digest references (image@sha256:...) to ensure reproducible, auditable deployments." />
                <WorkloadSection label="No Resource Limits" Icon={Zap} color="text-warning"
                  items={workloads.noLimits} note="Containers without CPU/memory limits can starve co-located workloads. Add resources.limits to all container specs."
                  fixType="add_resource_limits" canFix={canFix} onFixed={refresh} />
                <WorkloadSection label="Host Path Volumes" Icon={Server} color="text-orange-400"
                  items={workloads.hostPath} note="Pods mounting host filesystem paths can read/write sensitive host data. Replace with PersistentVolumes where possible." />
                <WorkloadSection label="Host Network Pods" Icon={Network} color="text-orange-400"
                  items={workloads.hostNetwork} note="Pods sharing the host network namespace bypass pod network isolation. Only monitoring/CNI agents should require this."
                  fixType="remove_host_network" canFix={canFix} onFixed={refresh} />
                <WorkloadSection label="Allow Privilege Escalation" Icon={AlertTriangle} color="text-surface-400"
                  items={workloads.allowPrivEsc} note="Set securityContext.allowPrivilegeEscalation: false on all containers. Enforce via PSA restricted policy."
                  fixType="set_no_priv_esc" canFix={canFix} onFixed={refresh} />
                <WorkloadSection label="Writable Root Filesystem" Icon={Lock} color="text-warning"
                  items={workloads.noReadOnlyRootFs} note="Set securityContext.readOnlyRootFilesystem: true on all containers. Write mutable data to emptyDir or PVCs instead."
                  fixType="set_read_only_root_fs" canFix={canFix} onFixed={refresh} />
              </>
            )}
          </>
        )}

        {tab === 'Warning Events' && (
          <>
            <div className={cn('rounded-2xl border p-4 flex items-center gap-4', kpis.falcoRunning ? 'bg-success/5 border-success/20' : 'bg-surface-900 border-surface-800')}>
              <Eye className={cn('w-5 h-5 flex-shrink-0', kpis.falcoRunning ? 'text-success' : 'text-surface-500')} />
              <div>
                <span className="text-sm font-semibold text-white">
                  {!hasScan ? 'Falco DaemonSet status unavailable' : kpis.falcoDetected ? `Falco DaemonSet · ${kpis.falcoPods}/${kpis.falcoDesiredPods} ready` : 'Falco DaemonSet not detected'}
                </span>
                <p className="text-xs text-surface-400 mt-0.5">
                  {!hasScan ? 'A successful cluster scan is required to determine Falco status.' : kpis.falcoRunning ? 'Pod readiness is reported; event delivery and rule coverage are not verified here.' : 'Runtime event coverage is unavailable from this scan.'}
                </p>
              </div>
            </div>
            {!hasScan
              ? <div className="flex flex-col items-center justify-center py-12 text-surface-500">
                  <WifiOff className="w-10 h-10 mb-3 text-surface-500 opacity-80" />
                  <p className="text-sm font-medium text-white">Warning-event scan unavailable</p>
                  <p className="text-xs mt-1">Refresh after restoring Kubernetes API connectivity.</p>
                </div>
              : warningEvents.length === 0
              ? <div className="flex flex-col items-center justify-center py-12 text-surface-500">
                  <Activity className="w-10 h-10 mb-3 text-surface-500 opacity-80" />
                  <p className="text-sm font-medium text-white">No Kubernetes Warning events returned</p>
                  <p className="text-xs mt-1">This does not establish that the cluster has no security threats.</p>
                </div>
              : warningEvents.map((t, i) => (
                  <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
                    className="rounded-2xl bg-surface-900 border border-surface-800 hover:border-surface-700 p-4 transition-all">
                    <div className="flex items-start gap-3">
                      <span className={cn('mt-1 w-2 h-2 rounded-full flex-shrink-0', SEV_DOT[t.priority] ?? 'bg-surface-500')} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-white">{t.reason}</span>
                          <span className={cn('text-2xs px-1.5 py-0.5 rounded border font-medium capitalize', t.priority === 'unclassified' ? 'text-surface-400 border-surface-700 bg-surface-800' : SEV_CLR[t.priority])}>{t.priority}</span>
                          {t.count > 1 && <span className="text-2xs text-surface-500">x{t.count}</span>}
                        </div>
                        <p className="text-xs text-surface-400 mt-1 line-clamp-2">{t.message}</p>
                        <div className="flex items-center gap-3 mt-2 text-2xs text-surface-500">
                          <span>{t.kind}/{t.objName}</span>
                          {t.ns && <span>ns: {t.ns}</span>}
                          <span suppressHydrationWarning>{t.lastTime ? timeAgo(t.lastTime) : ''}</span>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))
            }
          </>
        )}

      </div>
    </div>
  )
}
