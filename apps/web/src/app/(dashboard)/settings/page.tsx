'use client'

import { useState, useEffect, useCallback, createContext, useContext, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Settings, User, Bell, Key, Server, GitBranch, Database, Info,
  CheckCircle2, XCircle, RefreshCw, Save, Loader2, Copy, Eye,
  EyeOff, AlertTriangle, Activity, Shield,
  ChevronRight, Package, ExternalLink, Zap, Send, Radio,
  Clock, History, ListFilter, BookOpen, RotateCcw, Layers, Trash2, Plus, Pencil, X,
  Users, Lock, UserPlus, Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDashboardStore, getClusterHeaders } from '@/store'
import type { K8sCluster } from '@/types'

// -- Types -----------------------------------------------------------------
interface ProbeNode { name: string; ready: boolean; version: string; os: string; arch: string; cpu: string; memory: string }
interface ProbeData {
  k8s: { ok: boolean; latencyMs: number; error: string | null; version: string | null; major: string | null; minor: string | null; platform: string | null; nodeCount: number; namespaceCount: number; userNsCount: number; nodes: ProbeNode[] }
  prometheus: { ok: boolean; latencyMs: number; error: string | null; version: string | null; goVersion: string | null; buildDate: string | null; startTime: string | null; lastConfig: string | null; reloadOk: boolean | null; totalTargets: number; upTargets: number; downTargets: number }
  checkedAt: string
}

const SECTIONS = [
  { id: 'clusters',      label: 'Clusters',       icon: Layers },
  { id: 'connections',   label: 'Connections',   icon: Server },
  { id: 'datasources',   label: 'Data Sources',  icon: Database },
  { id: 'integrations',  label: 'Integrations',  icon: GitBranch },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'ai-provider',   label: 'AI Provider',   icon: Zap },
  { id: 'users',         label: 'Users',          icon: Users },
  { id: 'oncall',        label: 'On-Call',        icon: Clock },
  { id: 'access',        label: 'Access & Keys', icon: Key },
  { id: 'audit-log',     label: 'Audit Log',     icon: BookOpen },
  { id: 'profile',       label: 'Profile',       icon: User },
  { id: 'about',         label: 'About',         icon: Info },
] as const
type SectionId = typeof SECTIONS[number]['id']

// -- Cross-tab dirty tracker ------------------------------------------------
let _dirtySection: string | null = null
function useDirtyGuard(sectionId: string, dirty: boolean) {
  useEffect(() => {
    if (dirty) _dirtySection = sectionId
    else if (_dirtySection === sectionId) _dirtySection = null
    const handler = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', handler)
    return () => { window.removeEventListener('beforeunload', handler); if (_dirtySection === sectionId) _dirtySection = null }
  }, [sectionId, dirty])
}

// -- Role context ---------------------------------------------------------
type Role = 'admin' | 'operator' | 'viewer'
const RoleCtx = createContext<Role>('viewer')
function useRole(): Role { return useContext(RoleCtx) }

// -- Preference helpers ----------------------------------------------------
function getStoredTz(): string {
  try { return (typeof window !== 'undefined' && localStorage.getItem('pref_tz')) || 'UTC' } catch { return 'UTC' }
}

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000)        return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000)     return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000)    return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function fmtAbsDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: getStoredTz(),
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).format(new Date(iso))
  } catch { return new Date(iso).toLocaleString() }
}

// -- Helpers ---------------------------------------------------------------
function StatusDot({ ok, checking }: { ok: boolean; checking?: boolean }) {
  if (checking) return <span className="w-2 h-2 rounded-full bg-surface-500 animate-pulse flex-shrink-0" />
  return <span className={cn('w-2 h-2 rounded-full flex-shrink-0', ok ? 'bg-success' : 'bg-danger')} />
}

function latencyColor(ms: number) {
  if (ms < 100)  return 'text-success'
  if (ms < 500)  return 'text-warning'
  return 'text-danger'
}

function fmtUptime(iso: string | null) {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  const d = Math.floor(ms / 86400000)
  const h = Math.floor((ms % 86400000) / 3600000)
  return d > 0 ? `${d}d ${h}h` : `${h}h`
}

function memGiB(mem: string | undefined) {
  if (!mem) return '-'
  const ki = parseInt(mem)
  return `${(ki / 1048576).toFixed(1)} GiB`
}

// -- Connections tab -------------------------------------------------------
function ConnectionsTab() {
  const [data, setData] = useState<ProbeData | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastChecked, setLastChecked] = useState<string | null>(null)
  const activeCluster = useDashboardStore(s => s.activeCluster)

  const probe = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/settings/probe', { cache: 'no-store', headers: getClusterHeaders() })
      const j = await r.json()
      setData(j)
      setLastChecked(new Date().toLocaleTimeString())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [activeCluster])

  useEffect(() => { probe() }, [probe])

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Backend Connections</h2>
          <p className="text-xs text-surface-500 mt-0.5">Live health probe � K8s API + Prometheus</p>
        </div>
        <button onClick={probe} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-300 hover:text-white disabled:opacity-50 transition-all">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Re-test
        </button>
      </div>

      {/* K8s card */}
      <div className={cn('rounded-2xl border p-5',
        !data        ? 'bg-surface-900 border-surface-800' :
        data.k8s?.ok ? 'bg-success/5 border-success/20'   : 'bg-danger/5 border-danger/20')}>
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center">
              <Server className="w-4 h-4 text-brand-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Kubernetes API</p>
              <p className="text-2xs text-surface-500 font-mono">K8S_API_URL</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-surface-500" />}
            {data?.k8s && (
              <>
                <span className={cn('font-mono', latencyColor(data.k8s.latencyMs))}>{data.k8s.latencyMs}ms</span>
                {data.k8s.ok
                  ? <span className="flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" />Connected</span>
                  : <span className="flex items-center gap-1 text-danger"><XCircle className="w-3.5 h-3.5" />Unreachable</span>
                }
              </>
            )}
          </div>
        </div>
        {data?.k8s?.ok && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              {[
                { label: 'K8s Version', value: data.k8s.version ?? '�' },
                { label: 'Nodes',       value: String(data.k8s.nodeCount) },
                { label: 'Namespaces',  value: String(data.k8s.namespaceCount) },
                { label: 'Platform',    value: data.k8s.platform ?? '�' },
              ].map(f => (
                <div key={f.label} className="rounded-xl bg-surface-900/60 border border-surface-800 px-3 py-2">
                  <p className="text-2xs text-surface-500">{f.label}</p>
                  <p className="text-xs font-mono font-bold text-white mt-0.5">{f.value}</p>
                </div>
              ))}
            </div>
            <div className="overflow-x-auto rounded-xl border border-surface-800">
              <table className="w-full text-xs">
                <thead className="bg-surface-800">
                  <tr>
                    {['Node', 'Status', 'Version', 'Arch', 'CPU', 'Memory'].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-800">
                  {(data.k8s.nodes ?? []).map(n => (
                    <tr key={n.name} className="hover:bg-surface-800/30">
                      <td className="px-3 py-2 font-mono text-white">{n.name}</td>
                      <td className="px-3 py-2">
                        <span className={cn('flex items-center gap-1.5 w-fit text-2xs font-medium',
                          n.ready ? 'text-success' : 'text-danger')}>
                          <StatusDot ok={n.ready} />
                          {n.ready ? 'Ready' : 'NotReady'}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-surface-400">{n.version}</td>
                      <td className="px-3 py-2 text-surface-400">{n.arch}</td>
                      <td className="px-3 py-2 text-surface-400">{n.cpu}</td>
                      <td className="px-3 py-2 text-surface-400">{memGiB(n.memory)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {data?.k8s && !data.k8s.ok && (
          <div className="mt-3 flex items-start gap-2 p-3 rounded-xl bg-danger/5 border border-danger/20">
            <XCircle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
            <div>
              {data.k8s.error === 'Not configured'
                ? <p className="text-xs font-semibold text-surface-400">Kubernetes API URL not configured for this cluster</p>
                : <>
                    <p className="text-xs font-semibold text-danger">Could not reach Kubernetes API</p>
                    {data.k8s.error && <p className="text-2xs font-mono text-surface-400 mt-1">{data.k8s.error}</p>}
                    <p className="text-2xs text-surface-500 mt-1">
                      Ensure <code className="text-brand-300">K8S_API_URL</code> is set in <code className="text-brand-300">.env.local</code> and <code className="text-brand-300">kubectl proxy</code> is running on the cluster node.
                    </p>
                  </>
              }
            </div>
          </div>
        )}
      </div>

      {/* Prometheus card */}
      <div className={cn('rounded-2xl border p-5',
        !data              ? 'bg-surface-900 border-surface-800' :
        data.prometheus?.ok ? 'bg-success/5 border-success/20'  : 'bg-danger/5 border-danger/20')}>
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-warning/10 border border-warning/20 flex items-center justify-center">
              <Activity className="w-4 h-4 text-warning" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Prometheus</p>
              <p className="text-2xs text-surface-500 font-mono">PROMETHEUS_URL</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-surface-500" />}
            {data?.prometheus && (
              <>
                <span className={cn('font-mono', latencyColor(data.prometheus.latencyMs))}>{data.prometheus.latencyMs}ms</span>
                {data.prometheus.ok
                  ? <span className="flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" />Connected</span>
                  : <span className="flex items-center gap-1 text-danger"><XCircle className="w-3.5 h-3.5" />Unreachable</span>
                }
              </>
            )}
          </div>
        </div>
        {data?.prometheus?.ok && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Version',      value: data.prometheus.version ?? '�' },
              { label: 'Uptime',       value: fmtUptime(data.prometheus.startTime) },
              { label: 'Targets Up',   value: `${data.prometheus.upTargets} / ${data.prometheus.totalTargets}` },
              { label: 'Config OK',    value: data.prometheus.reloadOk === false ? 'Failed' : data.prometheus.reloadOk ? 'OK' : '�' },
            ].map(f => (
              <div key={f.label} className="rounded-xl bg-surface-900/60 border border-surface-800 px-3 py-2">
                <p className="text-2xs text-surface-500">{f.label}</p>
                <p className={cn('text-xs font-mono font-bold mt-0.5',
                  f.label === 'Targets Up' && data.prometheus.downTargets > 0 ? 'text-warning' :
                  f.label === 'Config OK' && f.value === 'Failed' ? 'text-danger' : 'text-white')}>
                  {f.value}
                </p>
              </div>
            ))}
          </div>
        )}
        {data?.prometheus && !data.prometheus.ok && (
          <div className="mt-3 flex items-start gap-2 p-3 rounded-xl bg-danger/5 border border-danger/20">
            <XCircle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
            <div>
              {data.prometheus.error === 'Not configured'
                ? <p className="text-xs font-semibold text-surface-400">Prometheus URL not configured for this cluster</p>
                : <>
                    <p className="text-xs font-semibold text-danger">Could not reach Prometheus</p>
                    {data.prometheus.error && <p className="text-2xs font-mono text-surface-400 mt-1">{data.prometheus.error}</p>}
                    <p className="text-2xs text-surface-500 mt-1">
                      Ensure <code className="text-brand-300">PROMETHEUS_URL</code> is set in <code className="text-brand-300">.env.local</code> and Prometheus is reachable from the server.
                    </p>
                  </>
              }
            </div>
          </div>
        )}
        {data?.prometheus?.ok && data.prometheus.downTargets > 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs text-warning bg-warning/5 border border-warning/20 rounded-xl px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {data.prometheus.downTargets} scrape target{data.prometheus.downTargets !== 1 ? 's' : ''} down � check Prometheus targets
          </div>
        )}
      </div>

      {lastChecked && (
        <p className="text-2xs text-surface-600">Last probed at {lastChecked}</p>
      )}
    </div>
  )
}

// -- Data Sources tab ------------------------------------------------------
interface DataSource {
  id: string; label: string; category: string
  url: string; displayUrl?: string; envVar: string
  ok: boolean; latencyMs: number; detail: string | null
}

const CATEGORY_ORDER = ['Orchestration', 'Metrics', 'Tracing', 'Visualisation', 'Logs']

function DataSourcesTab() {
  const [sources,   setSources]   = useState<DataSource[]>([])
  const [loading,   setLoading]   = useState(false)
  const [lastAt,    setLastAt]    = useState<string | null>(null)

  const activeCluster = useDashboardStore(s => s.activeCluster)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/settings/datasources', { cache: 'no-store', headers: getClusterHeaders() })
      const d = await r.json()
      setSources(d.sources ?? [])
      setLastAt(new Date().toLocaleTimeString())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [activeCluster])

  useEffect(() => { load() }, [load])

  const byCategory = CATEGORY_ORDER.reduce<Record<string, DataSource[]>>((acc, cat) => {
    const items = sources.filter(s => s.category === cat)
    if (items.length) acc[cat] = items
    return acc
  }, {})

  const configured = sources.filter(s => s.url)
  const up         = configured.filter(s => s.ok)

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Header strip */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Data Sources</h2>
          <p className="text-xs text-surface-500 mt-0.5">
            Live connectivity probe � values from <code className="text-brand-300 font-mono">.env.local</code>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {configured.length > 0 && (
            <span className="text-xs text-surface-400">
              <span className={up.length === configured.length ? 'text-success font-semibold' : 'text-warning font-semibold'}>
                {up.length}/{configured.length}
              </span> reachable
            </span>
          )}
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-300 hover:text-white disabled:opacity-50 transition-all">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Re-probe all
          </button>
        </div>
      </div>

      {/* Info banner */}
      <div className="rounded-xl bg-brand-500/5 border border-brand-500/20 px-4 py-3 text-xs text-surface-400 leading-relaxed">
        URLs are read from server-side environment variables and probed in real-time.
        To add or change a source, update <code className="text-brand-300 font-mono px-1 bg-brand-500/10 rounded">.env.local</code> and restart the server.
      </div>

      {loading && sources.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-surface-500 py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Probing data sources�
        </div>
      )}

      {/* Sources by category */}
      {Object.entries(byCategory).map(([cat, items]) => (
        <div key={cat}>
          <p className="text-2xs font-bold text-surface-500 uppercase tracking-widest mb-2">{cat}</p>
          <div className="space-y-2">
            {items.map(src => (
              <div key={src.id} className={cn(
                'rounded-2xl border p-4 transition-all',
                !src.url       ? 'bg-surface-900/40 border-surface-800 opacity-50' :
                src.ok         ? 'bg-success/5 border-success/20' :
                                 'bg-danger/5 border-danger/20',
              )}>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  {/* Left */}
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusDot ok={src.ok} checking={loading && src.url !== ''} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-white">{src.label}</p>
                        <code className="text-2xs font-mono text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded flex-shrink-0">{src.envVar}</code>
                      </div>
                      {src.url
                        ? <p className="text-2xs font-mono text-surface-500 truncate mt-0.5">{src.displayUrl ?? src.url}</p>
                        : <p className="text-2xs text-surface-600 italic mt-0.5">Not configured � set {src.envVar} in .env.local</p>
                      }
                    </div>
                  </div>
                  {/* Right */}
                  <div className="flex-shrink-0 sm:text-right pl-6 sm:pl-0">
                    {!src.url ? (
                      <span className="text-2xs text-surface-600 italic">�</span>
                    ) : src.ok ? (
                      <div className="flex items-center gap-2">
                        <span className={cn('text-xs font-mono', latencyColor(src.latencyMs))}>{src.latencyMs}ms</span>
                        <span className="flex items-center gap-1 text-xs text-success">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Connected
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="flex items-center gap-1 text-xs text-danger">
                          <XCircle className="w-3.5 h-3.5" /> Unreachable
                        </span>
                        {src.detail && (
                          <span className="text-2xs text-surface-500 font-mono break-all">{src.detail}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {lastAt && (
        <p className="text-2xs text-surface-600">Last probed at {lastAt}</p>
      )}
    </div>
  )
}

// -- Integrations tab ------------------------------------------------------
const INTEGRATIONS = [
  { id: 'falco',  name: 'Falco',    desc: 'Runtime security detection', category: 'Security', probeRoute: '/api/k8s/security', docs: 'https://falco.org', status: 'available' },
  { id: 'argocd', name: 'Argo CD',  desc: 'GitOps deployment tracking', category: 'CI/CD',    probeRoute: null,                 docs: 'https://argoproj.github.io', status: 'coming-soon' },
  { id: 'github', name: 'GitHub',   desc: 'Source and deployment tracking', category: 'CI/CD', probeRoute: null,                 docs: 'https://github.com', status: 'coming-soon' },
  { id: 'datadog', name: 'Datadog', desc: 'Metrics forwarding',           category: 'Monitoring', probeRoute: null,              docs: 'https://docs.datadoghq.com', status: 'coming-soon' },
]

function IntegrationsTab() {
  const [statuses,  setStatuses]  = useState<Record<string, 'idle' | 'checking' | 'ok' | 'error'>>({})
  const [enabled,   setEnabled]   = useState<Record<string, boolean>>({})
  const [loading,   setLoading]   = useState(true)
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [dirty,     setDirty]     = useState(false)
  const role = useRole()
  useDirtyGuard('integrations', dirty)

  useEffect(() => {
    fetch('/api/settings/config').then(r => r.json()).then(d => {
      setEnabled(d.config?.integrations_enabled ?? {})
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const toggle = (id: string) => {
    setEnabled(prev => ({ ...prev, [id]: !prev[id] }))
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      await fetch('/api/settings/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ integrations_enabled: enabled }) })
      setSaved(true); setDirty(false); setTimeout(() => setSaved(false), 3000)
    } finally { setSaving(false) }
  }

  const testConn = async (id: string, route: string | null) => {
    if (!route) return
    setStatuses(s => ({ ...s, [id]: 'checking' }))
    try {
      const r = await fetch(route, { headers: getClusterHeaders() })
      setStatuses(s => ({ ...s, [id]: r.ok ? 'ok' : 'error' }))
    } catch {
      setStatuses(s => ({ ...s, [id]: 'error' }))
    }
  }

  const byCategory = INTEGRATIONS.reduce<Record<string, typeof INTEGRATIONS>>((acc, i) => {
    ;(acc[i.category] ??= []).push(i)
    return acc
  }, {})

  if (loading) return <div className="flex items-center gap-2 text-xs text-surface-500 py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading�</div>

  return (
    <div className="space-y-6 max-w-2xl">
      {dirty && (
        <div className="rounded-xl bg-warning/10 border border-warning/30 px-4 py-2.5 flex items-center gap-2 text-xs text-warning">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          Unsaved changes � save before leaving this tab
        </div>
      )}
      {Object.entries(byCategory).map(([cat, items]) => (
        <div key={cat}>
          <p className="text-2xs font-bold text-surface-500 uppercase tracking-widest mb-2">{cat}</p>
          <div className="space-y-2">
            {items.map(int => {
              const st = statuses[int.id]
              const on = enabled[int.id] ?? false
              const comingSoon = int.status === 'coming-soon'
              return (
                <div key={int.id} className={cn('flex items-center gap-3 p-4 rounded-2xl border transition-all',
                  comingSoon ? 'bg-surface-900/40 border-surface-800' : on ? 'bg-surface-900 border-surface-700' : 'bg-surface-900/50 border-surface-800 opacity-60')}>
                  <div className="w-9 h-9 rounded-xl bg-surface-800 border border-surface-700 flex items-center justify-center flex-shrink-0">
                    <Package className="w-4 h-4 text-surface-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-white">{int.name}</p>
                      <span className="text-2xs text-surface-600">{int.category}</span>
                      <span className={cn('text-2xs px-1.5 py-0.5 rounded border font-medium',
                        comingSoon ? 'text-surface-500 border-surface-700 bg-surface-800' : on ? 'text-success border-success/20 bg-success/10' : 'text-surface-500 border-surface-700 bg-surface-800')}>
                        {comingSoon ? 'Coming soon' : on ? 'Configured' : 'Not configured'}
                      </span>
                    </div>
                    <p className="text-xs text-surface-400">{int.desc}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {int.probeRoute && on && !comingSoon && (
                      <button onClick={() => testConn(int.id, int.probeRoute)}
                        disabled={st === 'checking'}
                        className="text-2xs px-2 py-1 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-lg text-surface-400 hover:text-white transition-all flex items-center gap-1">
                        {st === 'checking' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
                        Test
                      </button>
                    )}
                    {st === 'ok'    && <CheckCircle2 className="w-4 h-4 text-success" />}
                    {st === 'error' && <XCircle      className="w-4 h-4 text-danger" />}
                    <button onClick={() => !comingSoon && toggle(int.id)} disabled={comingSoon}
                      className={cn('relative w-10 h-5 rounded-full border transition-all flex-shrink-0',
                        comingSoon ? 'bg-surface-800 border-surface-700 opacity-50 cursor-not-allowed' : on ? 'bg-brand-500 border-brand-400' : 'bg-surface-700 border-surface-600')}>
                      <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                        on ? 'translate-x-5' : 'translate-x-0')} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving || !dirty || role !== 'admin'}
          className="flex items-center gap-1.5 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-xl text-sm font-medium text-white transition-all">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save
        </button>
        {saved && <span className="flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="w-3.5 h-3.5" />Saved</span>}
      </div>
    </div>
  )
}

// -- Notifications tab -----------------------------------------------------
const SENTINEL = '__UNCHANGED__'

const NOTIF_CHANNELS = [
  { id: 'slack_webhook_url',     label: 'Slack Webhook URL',       placeholder: 'https://hooks.slack.com/services/...', env: 'SLACK_WEBHOOK_URL',     testAction: 'slack',        masked: false },
  { id: 'teams_webhook_url',     label: 'Microsoft Teams Webhook URL', placeholder: 'https://your-org.webhook.office.com/...', env: 'TEAMS_WEBHOOK_URL', testAction: 'teams', masked: false },
  { id: 'alert_email',           label: 'Alert Email (SMTP To)',   placeholder: 'oncall@your-org.com',                  env: 'ALERT_EMAIL',           testAction: 'email',        masked: false },
  { id: 'alert_webhook_url',     label: 'Generic Webhook URL',     placeholder: 'https://your-endpoint/alert',          env: 'ALERT_WEBHOOK_URL',     testAction: 'webhook',      masked: false },
]

const NOTIF_EVENTS: { key: string; label: string }[] = [
  { key: 'critical_incidents',  label: 'Critical Incidents'  },
  { key: 'sla_breaches',        label: 'SLA Breaches'        },
  { key: 'deployment_failures', label: 'Deployment Failures' },
  { key: 'node_not_ready',      label: 'Node Not Ready'      },
  { key: 'high_restart_rate',   label: 'High Restart Rate'   },
  { key: 'storage_full',        label: 'Storage Full'        },
]

const SMTP_FIELDS = [
  { id: 'smtp_host', label: 'SMTP Host',     placeholder: 'smtp.gmail.com',           env: 'SMTP_HOST', masked: false },
  { id: 'smtp_port', label: 'SMTP Port',     placeholder: '587',                      env: 'SMTP_PORT', masked: false },
  { id: 'smtp_user', label: 'SMTP Username', placeholder: 'you@gmail.com',             env: 'SMTP_USER', masked: false },
  { id: 'smtp_pass', label: 'SMTP Password', placeholder: 'app-password',              env: 'SMTP_PASS', masked: true  },
  { id: 'smtp_from', label: 'From Address',  placeholder: 'VynOps <you@example.com>', env: 'SMTP_FROM', masked: false },
]

const COOLDOWN_OPTIONS = [
  { value: 15,   label: '15 min' },
  { value: 30,   label: '30 min' },
  { value: 60,   label: '1 hour' },
  { value: 240,  label: '4 hours' },
  { value: 1440, label: '24 hours' },
]

const CHANNELS_LIST = ['slack', 'teams', 'email', 'webhook']
const SEVERITY_LEVELS = ['critical', 'warning', 'info'] as const

function NotificationsTab() {
  const [values,    setValues]    = useState<Record<string, string>>({})
  const [source,    setSource]    = useState<Record<string, string>>({})
  const [hidden,    setHidden]    = useState<Record<string, boolean>>({})
  const [events,    setEvents]    = useState<Record<string, boolean>>({})
  const [routing,   setRouting]   = useState<Record<string, string[]>>({ critical: ['slack'], warning: ['slack'], info: ['slack'] })
  const [cooldown,  setCooldown]  = useState(30)
  const [lastTested,setLastTested]= useState<Record<string, { ts: string; ok: boolean; msg: string }>>({})
  const [notifLog,  setNotifLog]  = useState<any[]>([])
  const [logOpen,   setLogOpen]   = useState(false)
  const [loading,   setLoading]   = useState(true)
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [dirty,     setDirty]     = useState(false)
  const [testing,   setTesting]   = useState<Record<string, boolean>>({})
  const [testRes,   setTestRes]   = useState<Record<string, { ok: boolean; msg: string }>>({})
  const [error,     setError]     = useState<string | null>(null)
  const role = useRole()
  useDirtyGuard('notifications', dirty)

  useEffect(() => {
    fetch('/api/settings/config').then(r => r.json()).then(d => {
      const cfg = d.config ?? {}
      setValues({
        slack_webhook_url:     cfg.slack_webhook_url     ?? '',
        teams_webhook_url:     cfg.teams_webhook_url     ?? '',
        alertmanager_url:      cfg.alertmanager_url      ?? '',
        pagerduty_routing_key: cfg.pagerduty_routing_key ?? '',
        alert_email:           cfg.alert_email           ?? '',
        alert_webhook_url:     cfg.alert_webhook_url     ?? '',
        smtp_host:             cfg.smtp_host             ?? '',
        smtp_port:             String(cfg.smtp_port      ?? ''),
        smtp_user:             cfg.smtp_user             ?? '',
        smtp_pass:             cfg.smtp_pass             ?? '',
        smtp_from:             cfg.smtp_from             ?? '',
      })
      setEvents(cfg.notify_on             ?? {})
      setRouting(cfg.alert_routing        ?? { critical: ['slack'], warning: ['slack'], info: ['slack'] })
      setCooldown(cfg.notify_cooldown_minutes ?? 30)
      setLastTested(cfg.last_tested       ?? {})
      setSource(d.source ?? {})
      setLoading(false)
    }).catch(() => { setError('Failed to load config'); setLoading(false) })
  }, [])

  const loadLog = async () => {
    try {
      const r = await fetch('/api/settings/notify-log')
      const d = await r.json()
      setNotifLog(d.entries ?? [])
    } catch { /* non-critical */ }
    setLogOpen(true)
  }

  const save = async () => {
    setSaving(true); setError(null)
    const payload: Record<string, any> = { notify_on: events, alert_routing: routing, notify_cooldown_minutes: cooldown }
    for (const ch of NOTIF_CHANNELS) {
      const v = values[ch.id] ?? ''
      payload[ch.id] = ch.masked && v.startsWith('****') ? SENTINEL : v
    }
    for (const f of SMTP_FIELDS) {
      if (f.id === 'smtp_port') {
        const v = values['smtp_port'] ?? ''
        if (v) payload.smtp_port = parseInt(v, 10)
      } else {
        const v = values[f.id] ?? ''
        payload[f.id] = f.masked && v.startsWith('****') ? SENTINEL : v
      }
    }
    try {
      const r = await fetch('/api/settings/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!r.ok) { const d = await r.json(); setError(d.error ?? 'Save failed'); return }
      setSaved(true); setDirty(false); setTimeout(() => setSaved(false), 3000)
    } catch { setError('Network error') }
    finally { setSaving(false) }
  }

  const test = async (ch: typeof NOTIF_CHANNELS[number]) => {
    if (!ch.testAction) return
    const url = values[ch.id] ?? ''
    if (!url) { setTestRes(r => ({ ...r, [ch.id]: { ok: false, msg: 'Enter a value first' } })); return }
    setTesting(t => ({ ...t, [ch.id]: true }))
    try {
      const r = await fetch('/api/settings/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          ch.testAction === 'pagerduty' ? { action: 'pagerduty', routingKey: url }
          : ch.testAction === 'email'  ? {
              action: 'email', email: url,
              // Pass SMTP config from current form so test works before saving
              smtpHost: values['smtp_host'] ?? '',
              smtpPort: parseInt(values['smtp_port'] ?? '587', 10) || 587,
              smtpUser: values['smtp_user'] ?? '',
              smtpPass: values['smtp_pass'] ?? '',
            }
          : { action: ch.testAction, url }
        ),
      })
      const d = await r.json()
      const msg = d.ok ? `? ${d.message ?? d.version ?? 'Connected'} � ${d.latencyMs}ms` : `? ${d.error}`
      setTestRes(prev => ({ ...prev, [ch.id]: { ok: d.ok, msg } }))
      if (d.ok) {
        // Reload last_tested from config after successful test
        fetch('/api/settings/config').then(r => r.json()).then(d => setLastTested(d.config?.last_tested ?? {}))
      }
    } catch (e: any) {
      setTestRes(prev => ({ ...prev, [ch.id]: { ok: false, msg: `? ${e.message}` } }))
    } finally { setTesting(t => ({ ...t, [ch.id]: false })) }
  }

  const toggleRouting = (severity: string, channel: string) => {
    setRouting(prev => {
      const cur = prev[severity] ?? []
      const next = cur.includes(channel) ? cur.filter(c => c !== channel) : [...cur, channel]
      return { ...prev, [severity]: next }
    })
    setDirty(true)
  }

  if (loading) return <div className="flex items-center gap-2 text-xs text-surface-500 py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading configuration�</div>

  return (
    <div className="space-y-6 max-w-2xl">
      {dirty && (
        <div className="rounded-xl bg-warning/10 border border-warning/30 px-4 py-2.5 flex items-center gap-2 text-xs text-warning">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          Unsaved changes � save before leaving this tab
        </div>
      )}

      {/* -- Alert Channels -- */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-white">Alert Channels</h2>
          <p className="text-xs text-surface-500">Persisted to <code className="font-mono text-brand-300">config.runtime.json</code></p>
        </div>
        <p className="text-xs text-surface-500 mb-4">Values override <code className="font-mono text-brand-300">.env.local</code> at runtime.</p>
        <div className="space-y-4">
          {NOTIF_CHANNELS.map(ch => {
            const src = source[ch.id]
            const tr  = testRes[ch.id]
            const lt  = lastTested[ch.testAction ?? '']
            return (
              <div key={ch.id}>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-2xs font-semibold text-surface-400 uppercase tracking-wider">{ch.label}</label>
                  <div className="flex items-center gap-2">
                    {lt && (
                      <span className={cn('text-2xs font-mono flex items-center gap-1', lt.ok ? 'text-success' : 'text-danger')}>
                        <Clock className="w-3 h-3" />
                        {fmtAgo(lt.ts)}
                      </span>
                    )}
                    {src === 'env'     && <span className="text-2xs text-warning bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded font-mono">from .env</span>}
                    {src === 'runtime' && <span className="text-2xs text-success bg-success/10 border border-success/20 px-1.5 py-0.5 rounded font-mono">saved</span>}
                    <code className="text-2xs font-mono text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded">{ch.env}</code>
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={hidden[ch.id] ? 'password' : 'text'}
                      value={values[ch.id] ?? ''}
                      onChange={e => { setValues(v => ({ ...v, [ch.id]: e.target.value })); setDirty(true) }}
                      placeholder={ch.placeholder}
                      className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white font-mono outline-none transition-all pr-9"
                    />
                    <button onClick={() => setHidden(h => ({ ...h, [ch.id]: !h[ch.id] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300">
                      {hidden[ch.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  {ch.testAction && (
                    <button onClick={() => test(ch)} disabled={testing[ch.id]}
                      className="flex items-center gap-1.5 px-3 py-2 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-300 hover:text-white disabled:opacity-50 transition-all flex-shrink-0">
                      {testing[ch.id] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Test
                    </button>
                  )}
                </div>
                {tr && <p className={cn('text-2xs mt-1.5 font-mono', tr.ok ? 'text-success' : 'text-danger')}>{tr.msg}</p>}
              </div>
            )
          })}
        </div>
      </div>

      {/* -- Alert Routing -- */}
      <div>
        <h3 className="text-xs font-semibold text-white mb-1">Alert Routing</h3>
        <p className="text-xs text-surface-500 mb-3">Which channels fire per severity. Unchecked = suppressed for that level.</p>
        <div className="rounded-xl border border-surface-800 overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-surface-800">
              <tr>
                <th className="px-4 py-2 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">Severity</th>
                {CHANNELS_LIST.map(ch => <th key={ch} className="px-4 py-2 text-center text-2xs font-semibold text-surface-500 uppercase tracking-wider capitalize">{ch}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-800 bg-surface-900">
              {SEVERITY_LEVELS.map(sev => (
                <tr key={sev}>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs font-semibold px-2 py-0.5 rounded-full',
                      sev === 'critical' ? 'bg-danger/10 text-danger' :
                      sev === 'warning'  ? 'bg-warning/10 text-warning' : 'bg-brand-500/10 text-brand-400')}>{sev}</span>
                  </td>
                  {CHANNELS_LIST.map(ch => (
                    <td key={ch} className="px-4 py-3 text-center">
                      <button onClick={() => toggleRouting(sev, ch)}
                        className={cn('w-5 h-5 rounded border flex items-center justify-center mx-auto transition-all',
                          (routing[sev] ?? []).includes(ch)
                            ? 'bg-brand-500 border-brand-500'
                            : 'bg-surface-800 border-surface-700 hover:border-surface-600')}>
                        {(routing[sev] ?? []).includes(ch) && <CheckCircle2 className="w-3 h-3 text-white" />}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      {/* -- Cooldown -- */}
      <div className="flex items-center justify-between p-4 rounded-xl bg-surface-900 border border-surface-800">
        <div>
          <p className="text-xs font-semibold text-white">Re-notify Cooldown</p>
          <p className="text-2xs text-surface-500 mt-0.5">Minimum time between repeat notifications for the same event type</p>
        </div>
        <select value={cooldown}
          onChange={e => { setCooldown(Number(e.target.value)); setDirty(true) }}
          className="bg-surface-800 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-1.5 text-sm text-white outline-none transition-all">
          {COOLDOWN_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* -- Trigger on Events -- */}
      <div>
        <h3 className="text-xs font-semibold text-white mb-3">Trigger on Events</h3>
        <div className="grid grid-cols-2 gap-2">
          {NOTIF_EVENTS.map(ev => (
            <label key={ev.key} className="flex items-center gap-3 p-3 rounded-xl bg-surface-900 border border-surface-800 cursor-pointer hover:border-surface-700 transition-all">
              <div className={cn('w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-all',
                events[ev.key] ? 'bg-brand-500 border-brand-500' : 'bg-surface-800 border-surface-700')}>
                {events[ev.key] && <CheckCircle2 className="w-3 h-3 text-white" />}
              </div>
              <input type="checkbox" className="sr-only" checked={!!events[ev.key]}
                onChange={e => { setEvents(v => ({ ...v, [ev.key]: e.target.checked })); setDirty(true) }} />
              <span className="text-xs text-surface-300">{ev.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* -- Delivery Log -- */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-white flex items-center gap-1.5"><History className="w-3.5 h-3.5" /> Delivery History</h3>
          <button onClick={loadLog} className="flex items-center gap-1.5 text-2xs text-brand-400 hover:text-brand-300 transition-colors">
            <RotateCcw className="w-3 h-3" /> {logOpen ? 'Refresh' : 'Load'}
          </button>
        </div>
        {logOpen && (
          notifLog.length === 0
            ? <p className="text-xs text-surface-500 italic">No notifications sent yet.</p>
            : <div className="space-y-1 max-h-64 overflow-y-auto">
                {notifLog.map((e, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-surface-900 border border-surface-800 text-2xs font-mono">
                    <span className={e.ok ? 'text-success' : 'text-danger'}>{e.ok ? '?' : '?'}</span>
                    <span className="text-surface-400 flex-shrink-0">{fmtAgo(e.ts)}</span>
                    <span className="text-white">{e.event}</span>
                    <span className="text-surface-500 ml-auto">{(e.channels ?? []).join(', ')}</span>
                  </div>
                ))}
              </div>
        )}
      </div>

      {/* -- SMTP Configuration -- */}
      <div>
        <h3 className="text-xs font-semibold text-white mb-3 flex items-center gap-1.5"><Send className="w-3.5 h-3.5" /> SMTP Configuration</h3>
        <p className="text-xs text-surface-500 mb-4">Configure outbound email for alert notifications.</p>
        <div className="space-y-3">
          {SMTP_FIELDS.map(f => {
            const src = source[f.id]
            return (
              <div key={f.id}>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-2xs font-semibold text-surface-400 uppercase tracking-wider">{f.label}</label>
                  <div className="flex items-center gap-2">
                    {src === 'env'     && <span className="text-2xs text-warning bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded font-mono">from .env</span>}
                    {src === 'runtime' && <span className="text-2xs text-success bg-success/10 border border-success/20 px-1.5 py-0.5 rounded font-mono">saved</span>}
                    <code className="text-2xs font-mono text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded">{f.env}</code>
                  </div>
                </div>
                <div className="relative">
                  <input
                    type={f.masked && (hidden[f.id] ?? true) ? 'password' : 'text'}
                    value={values[f.id] ?? ''}
                    onChange={e => { setValues(v => ({ ...v, [f.id]: e.target.value })); setDirty(true) }}
                    placeholder={f.placeholder}
                    autoComplete={f.masked ? 'new-password' : 'off'}
                    className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white font-mono outline-none transition-all pr-9"
                  />
                  {f.masked && (
                    <button onClick={() => setHidden(h => ({ ...h, [f.id]: !(h[f.id] ?? true) }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300">
                      {(hidden[f.id] ?? true) ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          <div className="pt-1 flex items-center gap-3">
            <button
              onClick={async () => {
                const destEmail = values['alert_email'] || values['smtp_user'] || ''
                if (!destEmail) {
                  setTestRes(prev => ({ ...prev, smtp_test: { ok: false, msg: '✗ Set Alert Email or SMTP Username first' } }))
                  return
                }
                setTesting(t => ({ ...t, smtp_test: true }))
                try {
                  const r = await fetch('/api/settings/test', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      action: 'email',
                      email: destEmail,
                      smtpHost: values['smtp_host'] ?? '',
                      smtpPort: parseInt(values['smtp_port'] ?? '587', 10) || 587,
                      smtpUser: values['smtp_user'] ?? '',
                      smtpPass: values['smtp_pass'] ?? '',
                    }),
                  })
                  const d = await r.json()
                  setTestRes(prev => ({ ...prev, smtp_test: { ok: d.ok, msg: d.ok ? `? Test email sent � ${d.latencyMs}ms` : `? ${d.error ?? d.message}` } }))
                } catch (e: any) {
                  setTestRes(prev => ({ ...prev, smtp_test: { ok: false, msg: `? ${e.message}` } }))
                } finally {
                  setTesting(t => ({ ...t, smtp_test: false }))
                }
              }}
              disabled={testing['smtp_test'] || role !== 'admin'}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 disabled:opacity-50 border border-surface-700 rounded-xl text-xs text-white transition-all">
              {testing['smtp_test'] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Send test email
            </button>
            {testRes['smtp_test'] && (
              <span className={cn('text-xs font-mono', testRes['smtp_test'].ok ? 'text-success' : 'text-danger')}>{testRes['smtp_test'].msg}</span>
            )}
          </div>
        </div>
      </div>

      {error && <p className="text-xs text-danger bg-danger/5 border border-danger/20 rounded-xl px-3 py-2">{error}</p>}

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving || role !== 'admin'}
          className="flex items-center gap-1.5 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 rounded-xl text-sm font-medium text-white transition-all">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save Configuration
        </button>
        {saved && <span className="flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="w-3.5 h-3.5" />Saved to runtime config</span>}
      </div>
    </div>
  )
}

// -- AI Provider tab -------------------------------------------------------
const AI_PROVIDERS = [
  { id: 'groq',      label: 'Groq',      defaultModel: 'openai/gpt-oss-120b',                    keyLabel: 'Groq API Key', keyPlaceholder: 'gsk_...' },
  { id: 'openai',    label: 'OpenAI',    defaultModel: 'gpt-4o-mini',                          keyLabel: 'OpenAI API Key', keyPlaceholder: 'sk-...' },
  { id: 'google',    label: 'Google',    defaultModel: 'gemini-2.0-flash',                    keyLabel: 'Google AI API Key', keyPlaceholder: 'AIza...' },
  { id: 'anthropic', label: 'Claude',    defaultModel: 'claude-3-5-sonnet-latest',            keyLabel: 'Anthropic API Key', keyPlaceholder: 'sk-ant-...' },
  { id: 'custom',    label: 'Custom',    defaultModel: '',                                    keyLabel: 'API Key', keyPlaceholder: 'API key (optional)' },
] as const

function AIProviderTab() {
  const [provider, setProvider] = useState('groq')
  const [apiKey,   setApiKey]   = useState('')
  const [model,    setModel]    = useState('openai/gpt-oss-120b')
  const [baseUrl,  setBaseUrl]  = useState('')
  const [keyHidden,setKeyHidden]= useState(true)
  const [source,   setSource]   = useState<Record<string, string>>({})
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [dirty,    setDirty]    = useState(false)
  const [testing,  setTesting]  = useState(false)
  const [testRes,  setTestRes]  = useState<{ ok: boolean; msg: string } | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const role = useRole()
  useDirtyGuard('ai-provider', dirty)

  // FinOps rate settings
  const [finopsCpu,        setFinopsCpu]        = useState(0.048)
  const [finopsMem,        setFinopsMem]        = useState(0.006)
  const [finopsStorage,    setFinopsStorage]    = useState(0.05)

  useEffect(() => {
    fetch('/api/settings/config').then(r => r.json()).then(d => {
      const cfg = d.config ?? {}
      const selectedProvider = cfg.ai_provider ?? 'groq'
      const providerConfig = AI_PROVIDERS.find(p => p.id === selectedProvider) ?? AI_PROVIDERS[0]
      setProvider(selectedProvider)
      setApiKey(cfg.ai_api_key ?? cfg.groq_api_key ?? '')
      setModel(cfg.ai_model ?? cfg.groq_model ?? providerConfig.defaultModel)
      setBaseUrl(cfg.ai_base_url ?? '')
      setSource(d.source ?? {})
      setFinopsCpu(cfg.finops_cpu_per_core_hr      ?? 0.048)
      setFinopsMem(cfg.finops_mem_per_gib_hr       ?? 0.006)
      setFinopsStorage(cfg.finops_storage_per_gib_mo ?? 0.05)
      setLoading(false)
    }).catch(() => { setError('Failed to load config'); setLoading(false) })
  }, [])

  const save = async () => {
    setSaving(true); setError(null)
    const payload: Record<string, any> = {
      ai_provider: provider,
      ai_model: model,
      ai_base_url: baseUrl,
      finops_cpu_per_core_hr:          finopsCpu,
      finops_mem_per_gib_hr:           finopsMem,
      finops_storage_per_gib_mo:       finopsStorage,
    }
    // Only send key if user typed a new one (not the masked value)
    if (apiKey && apiKey !== '***configured***') payload.ai_api_key = apiKey
    else payload.ai_api_key = SENTINEL
    try {
      const r = await fetch('/api/settings/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!r.ok) { const d = await r.json(); setError(d.error ?? 'Save failed'); return }
      setSaved(true); setDirty(false); setTimeout(() => setSaved(false), 3000)
    } catch { setError('Network error') }
    finally { setSaving(false) }
  }

  const testConnection = async () => {
    setTesting(true); setTestRes(null)
    // The server resolves the masked sentinel to the stored secret.
    const keyToTest = apiKey
    try {
      const r = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ai', provider, apiKey: keyToTest, model, baseUrl }),
      })
      const d = await r.json()
      setTestRes({ ok: d.ok, msg: d.ok ? `Connected · ${d.message} · ${d.latencyMs}ms` : d.error })
    } catch (e: any) {
      setTestRes({ ok: false, msg: `? ${e.message}` })
    } finally { setTesting(false) }
  }

  if (loading) return <div className="flex items-center gap-2 text-xs text-surface-500 py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading configuration�</div>

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-sm font-semibold text-white">AI Provider</h2>
        <p className="text-xs text-surface-500 mt-0.5">API key and model selection for the AI Copilot. Changes take effect immediately.</p>
      </div>

      {/* Provider */}
      <div>
        <label className="text-2xs font-semibold text-surface-400 uppercase tracking-wider block mb-1.5">Provider</label>
        <select value={provider} onChange={e => {
          const next = AI_PROVIDERS.find(p => p.id === e.target.value) ?? AI_PROVIDERS[0]
          setProvider(next.id); setModel(next.defaultModel); setApiKey(''); setTestRes(null); setDirty(true)
        }} className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white outline-none transition-all">
          {AI_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      {/* API Key */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-2xs font-semibold text-surface-400 uppercase tracking-wider">{AI_PROVIDERS.find(p => p.id === provider)?.keyLabel} </label>
          <div className="flex items-center gap-2">
            {source.ai_api_key === 'env'     && <span className="text-2xs text-warning bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded font-mono">from .env</span>}
            {source.ai_api_key === 'runtime' && <span className="text-2xs text-success bg-success/10 border border-success/20 px-1.5 py-0.5 rounded font-mono">saved</span>}
            <code className="text-2xs font-mono text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded">AI_API_KEY</code>
          </div>
        </div>
        <div className="relative">
          <input
            type={keyHidden ? 'password' : 'text'}
            value={apiKey}
            onChange={e => { setApiKey(e.target.value); setDirty(true) }}
            placeholder={AI_PROVIDERS.find(p => p.id === provider)?.keyPlaceholder}
            className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white font-mono outline-none transition-all pr-9"
          />
          <button onClick={() => setKeyHidden(hidden => !hidden)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300">
            {keyHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
        </div>
        <p className="text-2xs text-surface-600 mt-1">Keys are stored in the server runtime configuration and masked in this form.</p>
      </div>

      {/* Model */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-2xs font-semibold text-surface-400 uppercase tracking-wider">Active Model</label>
          <div className="flex items-center gap-2">
            {source.ai_model === 'env'     && <span className="text-2xs text-warning bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded font-mono">from .env</span>}
            {source.ai_model === 'runtime' && <span className="text-2xs text-success bg-success/10 border border-success/20 px-1.5 py-0.5 rounded font-mono">saved</span>}
            <code className="text-2xs font-mono text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded">AI_MODEL</code>
          </div>
        </div>
        <p className="text-2xs text-surface-500 mb-1.5">
          Enter the exact model ID from the selected provider. Example: <code className="text-brand-400">{AI_PROVIDERS.find(p => p.id === provider)?.defaultModel || 'your-model-id'}</code>
        </p>
        <input value={model} onChange={e => { setModel(e.target.value); setDirty(true) }} placeholder={AI_PROVIDERS.find(p => p.id === provider)?.defaultModel || 'provider-model-id'} aria-label="Active model ID" className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white font-mono outline-none transition-all" />
        {provider === 'custom' && <>
          <label className="text-2xs font-semibold text-surface-400 uppercase tracking-wider block mt-4 mb-1.5">OpenAI-compatible Base URL</label>
          <input value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setDirty(true) }} placeholder="https://api.example.com/v1" className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white font-mono outline-none transition-all" />
        </>}
        {provider === 'groq' && <p className="text-2xs text-surface-500 mt-1">Use a model ID available in your Groq account.</p>}
        {provider === 'google' && <p className="text-2xs text-surface-500 mt-1">Example: gemini-2.0-flash or gemini-1.5-pro.</p>}
        {provider === 'anthropic' && <p className="text-2xs text-surface-500 mt-1">Example: claude-3-5-sonnet-latest.</p>}
        {provider === 'openai' && <p className="text-2xs text-surface-500 mt-1">Example: gpt-4o-mini or gpt-4o.</p>}
        {provider === 'custom' && <p className="text-2xs text-surface-500 mt-1">The endpoint must expose an OpenAI-compatible API.</p>}
      </div>

      {/* Test connection */}
      <div className="rounded-xl bg-surface-900 border border-surface-800 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-white">Test Connection</p>
            <p className="text-2xs text-surface-500 mt-0.5">Verify the API key is valid and the selected model is available</p>
          </div>
          <button onClick={testConnection} disabled={testing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-300 hover:text-white disabled:opacity-50 transition-all">
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}
            Test
          </button>
        </div>
        {testRes && (
          <p className={cn('text-xs mt-3 font-mono', testRes.ok ? 'text-success' : 'text-danger')}>{testRes.msg}</p>
        )}
      </div>

      {/* FinOps rates */}
      <div className="border-t border-surface-800 pt-6 space-y-4">
        <div>
          <h3 className="text-xs font-semibold text-white mb-0.5">FinOps Cost Rates</h3>
          <p className="text-2xs text-surface-500">Used to calculate estimated cloud spend in the FinOps dashboard.</p>
        </div>
        {[
          { label: 'CPU ($/core/hr)',     value: finopsCpu,     set: setFinopsCpu,     step: '0.001' },
          { label: 'Memory ($/GiB/hr)',   value: finopsMem,     set: setFinopsMem,     step: '0.001' },
          { label: 'Storage ($/GiB/mo)',  value: finopsStorage, set: setFinopsStorage, step: '0.001' },
        ].map(f => (
          <div key={f.label}>
            <label className="text-2xs font-semibold text-surface-400 uppercase tracking-wider block mb-1.5">{f.label}</label>
            <input type="number" min={0} step={f.step} value={f.value}
              onChange={e => { f.set(Number(e.target.value)); setDirty(true) }}
              className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white font-mono outline-none transition-all" />
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-danger bg-danger/5 border border-danger/20 rounded-xl px-3 py-2">{error}</p>}

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving || role !== 'admin'}
          className="flex items-center gap-1.5 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 rounded-xl text-sm font-medium text-white transition-all">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save
        </button>
        {saved && <span className="flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="w-3.5 h-3.5" />Saved</span>}
      </div>
    </div>
  )
}

// -- Access & Keys tab -----------------------------------------------------
// -- Users tab -----------------------------------------------------------
type StoredUser = { id: string; name: string; email: string; role: 'admin' | 'operator' | 'viewer'; team: string; avatar: string; createdAt: string }
const ROLE_BADGE: Record<string, string> = {
  admin:    'bg-brand-500/10 text-brand-400 border-brand-500/30',
  operator: 'bg-warning/10 text-warning border-warning/30',
  viewer:   'bg-surface-700 text-surface-400 border-surface-600',
}
const BLANK_FORM = { name: '', email: '', role: 'viewer' as StoredUser['role'], team: '', password: '' }

function UsersTab() {
  const role = useRole()
  const isAdmin = role === 'admin'
  const { data: session } = useSession()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selfId = (session?.user as any)?.id as string | undefined

  const [users,    setUsers]    = useState<StoredUser[]>([])
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [tabError, setTabError] = useState<string | null>(null)
  const [tabOk,    setTabOk]    = useState<string | null>(null)
  const [adding,   setAdding]   = useState(false)
  const [addForm,  setAddForm]  = useState(BLANK_FORM)
  const [editTarget, setEditTarget] = useState<StoredUser | null>(null)
  const [editForm,   setEditForm]   = useState<Omit<typeof BLANK_FORM, 'password'> | null>(null)
  const [pwTarget,   setPwTarget]   = useState<string | null>(null)
  const [newPw,      setNewPw]      = useState('')
  const [showPw,     setShowPw]     = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/settings/users')
      if (r.ok) setUsers(await r.json())
      else { const b = await r.json().catch(() => ({})); setTabError(b.error ?? `Failed to load users (${r.status}).`) }
    } catch { setTabError('Failed to load users.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  function flash(ok: string) { setTabOk(ok); setTimeout(() => setTabOk(null), 3500) }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!addForm.name.trim() || !addForm.email.trim() || !addForm.password.trim()) {
      setTabError('Name, email and password are required.'); return
    }
    setSaving(true); setTabError(null)
    try {
      const r = await fetch('/api/settings/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addForm),
      })
      const body = await r.json()
      if (!r.ok) { setTabError(body.error ?? `HTTP ${r.status}`); return }
      setUsers(u => [...u, body])
      setAdding(false); setAddForm(BLANK_FORM)
      flash(`User "${body.name}" created.`)
    } catch (err) { setTabError(String(err)) }
    finally { setSaving(false) }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editTarget || !editForm) return
    setSaving(true); setTabError(null)
    try {
      const r = await fetch('/api/settings/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editTarget.id, ...editForm }),
      })
      const body = await r.json()
      if (!r.ok) { setTabError(body.error ?? `HTTP ${r.status}`); return }
      setUsers(u => u.map(x => x.id === body.id ? body : x))
      setEditTarget(null); setEditForm(null)
      flash(`User "${body.name}" updated.`)
    } catch (err) { setTabError(String(err)) }
    finally { setSaving(false) }
  }

  async function handleChangePw(e: React.FormEvent) {
    e.preventDefault()
    if (!pwTarget || !newPw.trim()) { setTabError('Password cannot be empty.'); return }
    setSaving(true); setTabError(null)
    try {
      const r = await fetch('/api/settings/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pwTarget, password: newPw }),
      })
      if (!r.ok) { const b = await r.json(); setTabError(b.error ?? `HTTP ${r.status}`); return }
      setPwTarget(null); setNewPw('')
      flash('Password updated.')
    } catch (err) { setTabError(String(err)) }
    finally { setSaving(false) }
  }

  async function handleDelete(u: StoredUser) {
    if (!confirm(`Remove user "${u.name}"? They will no longer be able to log in.`)) return
    setDeleting(u.id); setTabError(null)
    try {
      const r = await fetch('/api/settings/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: u.id }),
      })
      if (!r.ok) { const b = await r.json(); setTabError(b.error ?? `HTTP ${r.status}`); return }
      setUsers(us => us.filter(x => x.id !== u.id))
      flash(`User "${u.name}" removed.`)
    } catch (err) { setTabError(String(err)) }
    finally { setDeleting(null) }
  }

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Users</h2>
          <p className="text-xs text-surface-500 mt-0.5">Stored in <code className="text-brand-400">data/users.json</code> � persists across upgrades</p>
        </div>
        {isAdmin && (
          <button onClick={() => { setAdding(a => !a); setTabError(null) }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-xs font-medium transition-colors">
            <UserPlus className="w-3.5 h-3.5" /> Add User
          </button>
        )}
      </div>

      {tabError && (
        <div className="flex items-center gap-2 px-3 py-2 bg-danger/10 border border-danger/30 rounded-xl text-xs text-danger">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {tabError}
          <button onClick={() => setTabError(null)} className="ml-auto"><X className="w-3 h-3" /></button>
        </div>
      )}
      {tabOk && (
        <div className="flex items-center gap-2 px-3 py-2 bg-success/10 border border-success/30 rounded-xl text-xs text-success">
          <CheckCircle2 className="w-3.5 h-3.5" /> {tabOk}
        </div>
      )}

      {/* Add user form */}
      <AnimatePresence>
        {adding && (
          <motion.form key="add" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }} onSubmit={handleAdd} className="overflow-hidden">
            <div className="bg-surface-800 border border-brand-500/30 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-white flex items-center gap-2"><UserPlus className="w-3.5 h-3.5 text-brand-400" /> New User</p>
              <div className="grid grid-cols-2 gap-3">
                {([
                  ['name',     'Full Name',  'Alex Karev',           false],
                  ['email',    'Email',      'user@example.com',     false],
                  ['team',     'Team',       'Platform Engineering', false],
                  ['password', 'Password',   '��������',             true ],
                ] as [keyof typeof addForm, string, string, boolean][]).map(([k, lbl, ph, isPw]) => (
                  <div key={k}>
                    <label className="block text-2xs text-surface-400 mb-1">{lbl} {k !== 'team' && <span className="text-red-400">*</span>}</label>
                    <input type={isPw ? 'password' : 'text'} value={addForm[k]}
                      onChange={e => setAddForm(f => ({ ...f, [k]: e.target.value }))}
                      placeholder={ph} required={k !== 'team'}
                      className="w-full px-3 py-1.5 bg-surface-900 border border-surface-700 rounded-lg text-xs text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors" />
                  </div>
                ))}
                <div>
                  <label className="block text-2xs text-surface-400 mb-1">Role <span className="text-red-400">*</span></label>
                  <select value={addForm.role} onChange={e => setAddForm(f => ({ ...f, role: e.target.value as StoredUser['role'] }))}
                    className="w-full px-3 py-1.5 bg-surface-900 border border-surface-700 rounded-lg text-xs text-white focus:outline-none focus:border-brand-500 transition-colors">
                    <option value="admin">admin</option>
                    <option value="operator">operator</option>
                    <option value="viewer">viewer</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Create
                </button>
                <button type="button" onClick={() => { setAdding(false); setAddForm(BLANK_FORM); setTabError(null) }}
                  className="px-3 py-1.5 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded-lg text-xs transition-colors">Cancel</button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* User list */}
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-surface-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading users�
        </div>
      ) : (
        <div className="space-y-2">
          {users.map(u => (
            <div key={u.id} className="bg-surface-900 border border-surface-800 rounded-xl p-3">
              {/* Main row */}
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-brand-500/20 border border-brand-500/30 flex items-center justify-center text-xs font-bold text-brand-400 flex-shrink-0">
                  {u.avatar}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-white">{u.name}</span>
                    {u.id === selfId && <span className="text-2xs px-1.5 py-0.5 rounded border text-brand-400 bg-brand-500/10 border-brand-500/30">you</span>}
                    <span className={cn('text-2xs px-1.5 py-0.5 rounded border', ROLE_BADGE[u.role] ?? ROLE_BADGE.viewer)}>{u.role}</span>
                  </div>
                  <div className="text-xs text-surface-500 truncate">{u.email}{u.team ? ` � ${u.team}` : ''}</div>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button title="Change password" onClick={() => { setPwTarget(pwTarget === u.id ? null : u.id); setNewPw(''); setTabError(null) }}
                      className={cn('p-1.5 rounded-lg transition-colors', pwTarget === u.id ? 'text-brand-400 bg-brand-500/10' : 'text-surface-500 hover:text-brand-400 hover:bg-brand-500/10')}>
                      <Lock className="w-3.5 h-3.5" />
                    </button>
                    <button title="Edit user" onClick={() => {
                      if (editTarget?.id === u.id) { setEditTarget(null); setEditForm(null) }
                      else { setEditTarget(u); setEditForm({ name: u.name, email: u.email, role: u.role, team: u.team }) }
                      setTabError(null)
                    }}
                      className={cn('p-1.5 rounded-lg transition-colors', editTarget?.id === u.id ? 'text-brand-400 bg-brand-500/10' : 'text-surface-500 hover:text-brand-400 hover:bg-brand-500/10')}>
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    {u.id !== selfId && (
                      <button title="Delete user" onClick={() => handleDelete(u)} disabled={deleting === u.id}
                        className="p-1.5 rounded-lg text-surface-500 hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-40">
                        {deleting === u.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Change password inline */}
              <AnimatePresence>
                {pwTarget === u.id && (
                  <motion.form key="pw" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }} onSubmit={handleChangePw} className="overflow-hidden">
                    <div className="mt-3 pt-3 border-t border-surface-800 flex items-center gap-2">
                      <div className="relative flex-1">
                        <input type={showPw ? 'text' : 'password'} value={newPw} onChange={e => setNewPw(e.target.value)}
                          placeholder="New password" required
                          className="w-full px-3 py-1.5 bg-surface-800 border border-surface-700 rounded-lg text-xs text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors pr-8" />
                        <button type="button" onClick={() => setShowPw(s => !s)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300">
                          {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      <button type="submit" disabled={saving}
                        className="flex items-center gap-1 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors">
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Set
                      </button>
                      <button type="button" onClick={() => { setPwTarget(null); setNewPw('') }}
                        className="px-2 py-1.5 text-surface-400 hover:text-white rounded-lg text-xs transition-colors">Cancel</button>
                    </div>
                  </motion.form>
                )}
              </AnimatePresence>

              {/* Edit profile inline */}
              <AnimatePresence>
                {editTarget?.id === u.id && editForm && (
                  <motion.form key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }} onSubmit={handleEdit} className="overflow-hidden">
                    <div className="mt-3 pt-3 border-t border-surface-800 grid grid-cols-2 gap-3">
                      {([
                        ['name',  'Full Name', 'Alex Karev'],
                        ['email', 'Email',     'user@example.com'],
                        ['team',  'Team',      'Platform Engineering'],
                      ] as [keyof typeof editForm, string, string][]).map(([k, lbl, ph]) => (
                        <div key={k}>
                          <label className="block text-2xs text-surface-400 mb-1">{lbl}</label>
                          <input value={editForm[k]} onChange={e => setEditForm(f => f ? { ...f, [k]: e.target.value } : f)}
                            placeholder={ph}
                            className="w-full px-3 py-1.5 bg-surface-800 border border-surface-700 rounded-lg text-xs text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors" />
                        </div>
                      ))}
                      <div>
                        <label className="block text-2xs text-surface-400 mb-1">Role</label>
                        <select value={editForm.role} onChange={e => setEditForm(f => f ? { ...f, role: e.target.value as StoredUser['role'] } : f)}
                          className="w-full px-3 py-1.5 bg-surface-800 border border-surface-700 rounded-lg text-xs text-white focus:outline-none focus:border-brand-500 transition-colors">
                          <option value="admin">admin</option>
                          <option value="operator">operator</option>
                          <option value="viewer">viewer</option>
                        </select>
                      </div>
                      <div className="col-span-2 flex gap-2">
                        <button type="submit" disabled={saving}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors">
                          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
                        </button>
                        <button type="button" onClick={() => { setEditTarget(null); setEditForm(null) }}
                          className="px-3 py-1.5 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded-lg text-xs transition-colors">Cancel</button>
                      </div>
                    </div>
                  </motion.form>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      )}

      {!isAdmin && (
        <p className="text-xs text-surface-600 italic">Only admins can add, edit, or remove users.</p>
      )}
    </div>
  )
}

function OnCallTab() {
  type Member = { id: string; name: string; email: string; slack?: string }
  type EscLevel = { level: number; delayMins: number; description: string; memberId?: string }
  type Schedule = {
    id: string; name: string; rotationDays: number; rotationStart: string
    members: Member[]; escalationLevels: EscLevel[]; currentOnCall?: Member
    overrideMember?: Member; overrideUntil?: string
  }
  const [schedules,  setSchedules]  = useState<Schedule[]>([])
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  // new member form
  const [newName,    setNewName]    = useState('')
  const [newEmail,   setNewEmail]   = useState('')
  const [newSlack,   setNewSlack]   = useState('')
  // override form
  const [overrideName,  setOverrideName]  = useState('')
  const [overrideHours, setOverrideHours] = useState('4')
  // inline edit
  const [editingId,  setEditingId]  = useState<string | null>(null)
  const [editName,   setEditName]   = useState('')
  const [editEmail,  setEditEmail]  = useState('')
  const [editSlack,  setEditSlack]  = useState('')
  // SLA windows + auto-escalation config
  const [autoEscEnabled, setAutoEscEnabled] = useState(false)
  const [slaCritical,    setSlaCritical]    = useState(30)
  const [slaHigh,        setSlaHigh]        = useState(120)
  const [slaMedium,      setSlaMedium]      = useState(480)
  const [slaLow,         setSlaLow]         = useState(2880)
  const [slaSaved,       setSlaSaved]       = useState(false)
  const role = useRole()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/settings/oncall')
      const j = await r.json()
      setSchedules(j.schedules ?? [])
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/settings/config').then(r => r.json()).then(d => {
      const cfg = d.config ?? {}
      setAutoEscEnabled(cfg.auto_escalate_enabled ?? false)
      setSlaCritical(cfg.sla_minutes_critical  ?? 30)
      setSlaHigh(cfg.sla_minutes_high          ?? 120)
      setSlaMedium(cfg.sla_minutes_medium      ?? 480)
      setSlaLow(cfg.sla_minutes_low            ?? 2880)
    }).catch(() => {})
  }, [])

  const primary = schedules[0]

  const addMember = async () => {
    if (!newName.trim() || !newEmail.trim() || !primary) return
    setSaving(true)
    const updated: Schedule = {
      ...primary,
      members: [
        ...primary.members,
        { id: `m-${Date.now()}`, name: newName.trim(), email: newEmail.trim(), slack: newSlack.trim() || undefined },
      ],
    }
    try {
      const r = await fetch('/api/settings/oncall', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedules: schedules.map(s => s.id === primary.id ? updated : s) }),
      })
      if (r.ok) { await load(); setNewName(''); setNewEmail(''); setNewSlack('') }
    } finally { setSaving(false) }
  }

  const removeMember = async (memberId: string) => {
    if (!primary) return
    setSaving(true)
    const updated: Schedule = { ...primary, members: primary.members.filter(m => m.id !== memberId) }
    try {
      const r = await fetch('/api/settings/oncall', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedules: schedules.map(s => s.id === primary.id ? updated : s) }),
      })
      if (r.ok) await load()
    } finally { setSaving(false) }
  }

  const startEdit = (m: Member) => {
    setEditingId(m.id); setEditName(m.name); setEditEmail(m.email); setEditSlack(m.slack ?? '')
  }

  const saveEdit = async () => {
    if (!primary || !editingId || !editName.trim() || !editEmail.trim()) return
    setSaving(true)
    const updated: Schedule = {
      ...primary,
      members: primary.members.map(m => m.id === editingId
        ? { ...m, name: editName.trim(), email: editEmail.trim(), slack: editSlack.trim() || undefined }
        : m
      ),
    }
    try {
      const r = await fetch('/api/settings/oncall', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedules: schedules.map(s => s.id === primary.id ? updated : s) }),
      })
      if (r.ok) { await load(); setEditingId(null) }
    } finally { setSaving(false) }
  }

  const setOverride = async () => {
    if (!overrideName.trim()) return
    setSaving(true)
    try {
      const r = await fetch('/api/settings/oncall', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduleId: primary?.id ?? 'primary', memberId: overrideName.trim(), hours: Number(overrideHours) }),
      })
      if (r.ok) { await load(); setOverrideName('') }
    } finally { setSaving(false) }
  }

  const saveSlaConfig = async () => {
    setSaving(true)
    try {
      await fetch('/api/settings/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auto_escalate_enabled: autoEscEnabled,
          sla_minutes_critical:  slaCritical,
          sla_minutes_high:      slaHigh,
          sla_minutes_medium:    slaMedium,
          sla_minutes_low:       slaLow,
        }),
      })
      setSlaSaved(true)
      setTimeout(() => setSlaSaved(false), 3000)
    } finally { setSaving(false) }
  }

  if (loading) return <div className="flex items-center gap-2 text-xs text-surface-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading on-call data�</div>
  if (error)   return <p className="text-xs text-danger">{error}</p>
  if (!primary) return <p className="text-xs text-surface-500">No schedules found.</p>

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-sm font-semibold text-white">On-Call Schedule</h2>
        <p className="text-xs text-surface-500 mt-0.5">Manage rotation members. The current on-call person will appear as an assign suggestion in incident pages.</p>
      </div>

      {/* Current on-call status */}
      <div className="rounded-xl bg-surface-800 border border-surface-700 p-4 flex items-center gap-4">
        <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0',
          primary.currentOnCall ? 'bg-success/20 text-success' : 'bg-surface-700 text-surface-400')}>
          {primary.currentOnCall ? primary.currentOnCall.name.slice(0, 1).toUpperCase() : '?'}
        </div>
        <div className="flex-1">
          <p className="text-xs text-surface-500">Currently on-call</p>
          <p className="text-sm font-semibold text-white">{primary.currentOnCall?.name ?? 'Nobody'}</p>
          {primary.currentOnCall?.email && <p className="text-2xs text-surface-500">{primary.currentOnCall.email}</p>}
          {primary.overrideMember && <p className="text-2xs text-warning mt-1">Override active until {new Date(primary.overrideUntil!).toLocaleString()}</p>}
        </div>
        <div className="text-right text-2xs text-surface-500">
          <p>{primary.name}</p>
          <p>{primary.rotationDays}-day rotation</p>
        </div>
      </div>

      {/* Rotation members */}
      <div className="rounded-xl bg-surface-900 border border-surface-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-800 flex items-center justify-between">
          <span className="text-xs font-semibold text-white">Rotation Members</span>
          <span className="text-2xs text-surface-500">{primary.members.length} members � {primary.rotationDays}-day shifts</span>
        </div>
        <div className="divide-y divide-surface-800">
          {primary.members.map((m, i) => (
            <div key={m.id} className="border-b border-surface-800 last:border-0">
              {/* Normal row */}
              <div className="flex items-center gap-3 px-4 py-3">
                <span className={cn('w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0',
                  m.id === primary.currentOnCall?.id ? 'bg-success/20 text-success' : 'bg-surface-700 text-surface-400')}>
                  {m.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white flex items-center gap-2">
                    {m.name}
                    {m.id === primary.currentOnCall?.id && <span className="text-2xs text-success font-semibold">{'\u25CF'} On-call now</span>}
                  </p>
                  <p className="text-2xs text-surface-500">{m.email}{m.slack && <span className="ml-2 text-surface-600">Slack: {m.slack}</span>}</p>
                </div>
                <span className="text-2xs text-surface-600">Shift {i + 1}</span>
                {role === 'admin' && (
                  <>
                    <button onClick={() => editingId === m.id ? setEditingId(null) : startEdit(m)}
                      className={cn('p-1.5 rounded-lg transition-colors', editingId === m.id ? 'bg-brand-500/20 text-brand-400' : 'hover:bg-surface-700 text-surface-600 hover:text-white')} title="Edit">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => removeMember(m.id)} disabled={saving || primary.members.length <= 1}
                      className="p-1.5 rounded-lg hover:bg-danger/10 text-surface-600 hover:text-danger transition-colors disabled:opacity-30" title="Remove">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
              {/* Inline edit form */}
              {editingId === m.id && (
                <div className="px-4 pb-3 flex gap-2 flex-wrap bg-surface-950/40">
                  <input value={editName} onChange={e => setEditName(e.target.value)} placeholder="Full name"
                    className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 w-36" />
                  <input value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="email@company.com"
                    className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 flex-1 min-w-[180px]" />
                  <button onClick={saveEdit} disabled={!editName.trim() || !editEmail.trim() || saving}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-xl text-xs font-medium text-white transition-all">
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
                  </button>
                  <button onClick={() => setEditingId(null)}
                    className="px-3 py-1.5 bg-surface-800 border border-surface-700 rounded-xl text-xs text-surface-400 hover:text-white transition-all">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        {role === 'admin' && (
          <div className="px-4 py-3 border-t border-surface-800 bg-surface-950/50">
            <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2">Add Member</p>
            <div className="flex gap-2 flex-wrap">
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Full name"
                className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 w-36" />
              <input value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="email@company.com"
                className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 flex-1 min-w-[180px]" />
              <button onClick={addMember} disabled={!newName.trim() || !newEmail.trim() || saving}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-xl text-xs font-medium text-white transition-all">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Manual override */}
      {role === 'admin' && (
        <div className="rounded-xl bg-surface-900 border border-surface-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-800 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-white">Escalation Levels</span>
              <p className="text-2xs text-surface-500 mt-0.5">
                Each level maps to a rotation member in shift order. L1 = Shift 1, L2 = Shift 2, etc.
              </p>
            </div>
          </div>
          <div className="divide-y divide-surface-800">
            {(primary.escalationLevels ?? []).map((lvl, idx) => {
              const contact = primary.members[idx]
              return (
                <div key={lvl.level} className="flex items-center gap-3 px-4 py-3 flex-wrap">
                  <span className={cn(
                    'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0',
                    idx === 0 ? 'bg-danger/20 text-danger' : idx === 1 ? 'bg-warning/20 text-warning' : 'bg-surface-700 text-surface-400',
                  )}>L{lvl.level}</span>
                  <div className="flex-1 min-w-[140px]">
                    <input
                      defaultValue={lvl.description}
                      onBlur={async e => {
                        const val = e.target.value.trim()
                        if (!val || val === lvl.description) return
                        const updated = {
                          ...primary,
                          escalationLevels: primary.escalationLevels.map((l, i) =>
                            i === idx ? { ...l, description: val } : l
                          ),
                        }
                        try {
                          await fetch('/api/settings/oncall', {
                            method: 'PUT', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ schedules: schedules.map(s => s.id === primary.id ? updated : s) }),
                          })
                          await load()
                        } catch { /* ignore */ }
                      }}
                      className="w-full bg-surface-800 border border-surface-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-brand-500"
                      placeholder="Level description"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number" min={0} max={1440}
                      defaultValue={lvl.delayMins}
                      onBlur={async e => {
                        const val = Number(e.target.value)
                        if (isNaN(val) || val === lvl.delayMins) return
                        const updated = {
                          ...primary,
                          escalationLevels: primary.escalationLevels.map((l, i) =>
                            i === idx ? { ...l, delayMins: val } : l
                          ),
                        }
                        try {
                          await fetch('/api/settings/oncall', {
                            method: 'PUT', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ schedules: schedules.map(s => s.id === primary.id ? updated : s) }),
                          })
                          await load()
                        } catch { /* ignore */ }
                      }}
                      className="w-16 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1 text-xs text-white text-center outline-none focus:border-brand-500"
                    />
                    <span className="text-2xs text-surface-500">min delay</span>
                  </div>
                  {/* Member picker for this level */}
                  <select
                    value={lvl.memberId ?? primary.members[idx]?.id ?? ''}
                    onChange={async e => {
                      const updated = {
                        ...primary,
                        escalationLevels: primary.escalationLevels.map((l, i) =>
                          i === idx ? { ...l, memberId: e.target.value || undefined } : l
                        ),
                      }
                      try {
                        await fetch('/api/settings/oncall', {
                          method: 'PUT', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ schedules: schedules.map(s => s.id === primary.id ? updated : s) }),
                        })
                        await load()
                      } catch { /* ignore */ }
                    }}
                    className="bg-surface-800 border border-surface-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-brand-500 flex-shrink-0">
                    {primary.members.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name}{m.id === primary.currentOnCall?.id ? ' ? on-call' : ''}
                      </option>
                    ))}
                  </select>
                  {primary.escalationLevels.length > 1 && (
                    <button
                      onClick={async () => {
                        const updated = {
                          ...primary,
                          escalationLevels: primary.escalationLevels
                            .filter((_, i) => i !== idx)
                            .map((l, i) => ({ ...l, level: i + 1 })),
                        }
                        await fetch('/api/settings/oncall', {
                          method: 'PUT', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ schedules: schedules.map(s => s.id === primary.id ? updated : s) }),
                        })
                        await load()
                      }}
                      className="p-1.5 rounded-lg hover:bg-danger/10 text-surface-600 hover:text-danger transition-colors flex-shrink-0" title="Remove level">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="px-4 py-3 border-t border-surface-800 bg-surface-950/50">
            <button
              onClick={async () => {
                const next = (primary.escalationLevels?.length ?? 0) + 1
                const updated = {
                  ...primary,
                  escalationLevels: [
                    ...(primary.escalationLevels ?? []),
                    { level: next, delayMins: next === 1 ? 0 : (next - 1) * 15, description: `Level ${next} escalation` },
                  ],
                }
                await fetch('/api/settings/oncall', {
                  method: 'PUT', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ schedules: schedules.map(s => s.id === primary.id ? updated : s) }),
                })
                await load()
              }}
              className="flex items-center gap-1.5 text-2xs text-brand-400 hover:text-brand-300 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add escalation level
            </button>
          </div>
        </div>
      )}

      {/* Manual override */}
      {role === 'admin' && (
        <div className="rounded-xl bg-surface-900 border border-surface-800 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-white">Manual Override</p>
            <p className="text-2xs text-surface-500 mt-0.5">Temporarily set a specific person as on-call (e.g. during sick leave swap).</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <select value={overrideName} onChange={e => setOverrideName(e.target.value)}
              className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white outline-none focus:border-brand-500 flex-1">
              <option value="">Select member�</option>
              {primary.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <select value={overrideHours} onChange={e => setOverrideHours(e.target.value)}
              className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white outline-none focus:border-brand-500">
              {[['1','1 hour'],['4','4 hours'],['8','8 hours'],['24','24 hours'],['48','48 hours']].map(([v,l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <button onClick={setOverride} disabled={!overrideName || saving}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-warning/20 hover:bg-warning/30 border border-warning/30 disabled:opacity-40 rounded-xl text-xs font-medium text-warning transition-all">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />} Set Override
            </button>
          </div>
        </div>
      )}

      {/* SLA Windows & Auto-Escalation */}
      <div className="rounded-xl bg-surface-900 border border-surface-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-800 flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-white">SLA Windows &amp; Auto-Escalation</span>
            <p className="text-2xs text-surface-500 mt-0.5">Response time targets per severity � auto-escalation fires on the autonomous loop (every 5 min).</p>
          </div>
          {slaSaved && <span className="text-2xs text-success flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Saved</span>}
        </div>

        {/* Auto-escalate toggle */}
        <div className="px-4 py-3 border-b border-surface-800 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-white">Auto-escalate on SLA breach</p>
            <p className="text-2xs text-surface-500 mt-0.5">Automatically notify contacts when incidents approach their SLA deadline � no button press required.</p>
          </div>
          <button
            onClick={() => role === 'admin' && setAutoEscEnabled(v => !v)}
            disabled={role !== 'admin'}
            className={cn('relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors disabled:opacity-50',
              autoEscEnabled ? 'bg-brand-500 cursor-pointer' : 'bg-surface-700 cursor-pointer')}>
            <span className={cn('pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
              autoEscEnabled ? 'translate-x-4' : 'translate-x-0')} />
          </button>
        </div>

        {/* SLA inputs */}
        <div className="p-4 grid grid-cols-2 gap-3">
          {([
            { label: 'Critical SLA', value: slaCritical, set: setSlaCritical, color: 'text-danger' },
            { label: 'High SLA',     value: slaHigh,     set: setSlaHigh,     color: 'text-warning' },
            { label: 'Medium SLA',   value: slaMedium,   set: setSlaMedium,   color: 'text-blue-400' },
            { label: 'Low SLA',      value: slaLow,      set: setSlaLow,      color: 'text-surface-400' },
          ] as { label: string; value: number; set: (v: number) => void; color: string }[]).map(({ label, value, set, color }) => (
            <div key={label} className="space-y-1">
              <label className={cn('text-2xs font-semibold', color)}>{label}</label>
              <div className="flex items-center gap-1.5">
                <input type="number" min={5} max={10080} value={value}
                  onChange={e => set(Number(e.target.value))}
                  disabled={role !== 'admin'}
                  className="w-20 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-brand-500 disabled:opacity-50" />
                <span className="text-2xs text-surface-500">min</span>
                <span className="text-2xs text-surface-600">({value < 60 ? `${value}m` : `${Math.round(value / 60)}h`})</span>
              </div>
            </div>
          ))}
        </div>

        {role === 'admin' && (
          <div className="px-4 py-3 border-t border-surface-800 bg-surface-950/50">
            <button onClick={saveSlaConfig} disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-xl text-xs font-medium text-white transition-all">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save SLA settings
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function AccessTab() {
  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h2 className="text-sm font-semibold text-white">API Keys</h2>
        <p className="text-xs text-surface-500 mt-0.5">Manage service account tokens for external integrations</p>
      </div>

      <div className="rounded-2xl bg-surface-900/50 border border-surface-800 p-8 flex flex-col items-center text-center gap-3">
        <div className="w-12 h-12 rounded-2xl bg-surface-800 border border-surface-700 flex items-center justify-center">
          <Key className="w-5 h-5 text-surface-500" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">API Key Management</p>
          <p className="text-xs text-surface-500 mt-1 max-w-xs">Scoped service tokens with audit logging � arriving in v0.2</p>
        </div>
        <div className="flex flex-wrap gap-2 justify-center mt-1">
          {['read:metrics', 'read:pods', 'write:incidents', 'read:alerts'].map(s => (
            <span key={s} className="text-2xs font-mono bg-brand-500/10 text-brand-400 border border-brand-500/20 px-2 py-0.5 rounded">{s}</span>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-surface-900/50 border border-surface-800 px-4 py-3 flex items-start gap-2">
        <Shield className="w-3.5 h-3.5 text-surface-500 flex-shrink-0 mt-0.5" />
        <p className="text-2xs text-surface-500 leading-relaxed">
          API keys will grant scoped access to the VynOps REST API. Keys will be hashed at rest and shown only once at creation. Never commit keys to source control.
        </p>
      </div>
    </div>
  )
}

// -- Audit Log tab -------------------------------------------------------
function AuditLogTab() {
  const [entries,      setEntries]      = useState<any[]>([])
  const [total,        setTotal]        = useState(0)
  const [loading,      setLoading]      = useState(true)
  const [page,         setPage]         = useState(0)
  const [userFilter,   setUserFilter]   = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const PAGE_SIZE = 20

  const load = useCallback(async (p = 0, u = '', a = '') => {
    setLoading(true)
    try {
      const r = await fetch(`/api/settings/audit?page=${p}&pageSize=${PAGE_SIZE}&user=${encodeURIComponent(u)}&action=${encodeURIComponent(a)}`)
      const d = await r.json()
      setEntries(d.entries ?? [])
      setTotal(d.total ?? 0)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load(0, userFilter, actionFilter) }, [load])

  const applyFilter = () => { setPage(0); load(0, userFilter, actionFilter) }

  const exportLog = async () => {
    try {
      const r = await fetch('/api/settings/audit?export=1')
      const d = await r.json()
      const blob = new Blob([JSON.stringify(d.entries, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 100)
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Audit Log</h2>
          <p className="text-xs text-surface-500 mt-0.5">All settings changes � who, what, when. Append-only, stored in <code className="font-mono text-brand-300">audit.log.jsonl</code></p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportLog}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-300 hover:text-white transition-all">
            <Download className="w-3.5 h-3.5" /> Export
          </button>
          <button onClick={() => load(page, userFilter, actionFilter)} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-300 hover:text-white disabled:opacity-50 transition-all">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <input
          type="text" placeholder="Filter by user�" value={userFilter}
          onChange={e => setUserFilter(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applyFilter()}
          className="flex-1 bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-1.5 text-xs text-white outline-none transition-all"
        />
        <input
          type="text" placeholder="Filter by action�" value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applyFilter()}
          className="flex-1 bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-1.5 text-xs text-white outline-none transition-all"
        />
        <button onClick={applyFilter}
          className="flex items-center gap-1 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-300 hover:text-white transition-all">
          <ListFilter className="w-3.5 h-3.5" /> Filter
        </button>
      </div>

      {loading && entries.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-surface-500 py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading audit log�
        </div>
      )}

      {!loading && entries.length === 0 && (
        <div className="rounded-xl bg-surface-900/50 border border-surface-800 p-8 text-center">
          <BookOpen className="w-8 h-8 text-surface-600 mx-auto mb-2" />
          <p className="text-sm text-surface-500">No audit entries yet</p>
          <p className="text-xs text-surface-600 mt-1">Changes made via Settings will appear here</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="rounded-xl border border-surface-800 overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-surface-800">
              <tr>
                {['When', 'User', 'Action', 'Fields'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-800 bg-surface-900">
              {entries.map((e, i) => (
                <tr key={i} className="hover:bg-surface-800/30 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-surface-400 whitespace-nowrap" title={fmtAbsDate(e.ts)}>{fmtAgo(e.ts)}</td>
                  <td className="px-4 py-2.5 text-surface-300">{e.user}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-2xs font-mono bg-brand-500/10 text-brand-400 px-1.5 py-0.5 rounded">{e.action}</span>
                  </td>
                  <td className="px-4 py-2.5 text-surface-500 font-mono text-2xs">
                    {(e.fields ?? []).join(', ') || e.detail || '�'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-surface-500">
          <span>{total} total entries � page {page + 1} of {Math.ceil(total / PAGE_SIZE)}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => { const p = page - 1; setPage(p); load(p, userFilter) }} disabled={page === 0}
              className="px-2.5 py-1 rounded-lg bg-surface-800 border border-surface-700 hover:bg-surface-700 disabled:opacity-40 transition-all text-xs text-surface-300">
              ? Prev
            </button>
            <button onClick={() => { const p = page + 1; setPage(p); load(p, userFilter) }} disabled={(page + 1) * PAGE_SIZE >= total}
              className="px-2.5 py-1 rounded-lg bg-surface-800 border border-surface-700 hover:bg-surface-700 disabled:opacity-40 transition-all text-xs text-surface-300">
              Next ?
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// -- About tab -------------------------------------------------------------
function AboutTab() {
  const [probe, setProbe] = useState<ProbeData | null>(null)
  const activeCluster = useDashboardStore(s => s.activeCluster)

  useEffect(() => {
    fetch('/api/settings/probe', { cache: 'no-store', headers: getClusterHeaders() }).then(r => r.json()).then(setProbe).catch(() => {})
  }, [activeCluster])

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Export button */}
      <div className="flex items-center justify-end">
        <button onClick={async () => {
          const r = await fetch('/api/settings/config')
          const d = await r.json()
          const blob = new Blob([JSON.stringify({ config: d.config, source: d.source, exported_at: new Date().toISOString() }, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = `vynops-config-${new Date().toISOString().slice(0, 10)}.json`
          document.body.appendChild(a); a.click(); document.body.removeChild(a)
          setTimeout(() => URL.revokeObjectURL(url), 100)
        }} className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-surface-300 hover:text-white transition-all">
          <ExternalLink className="w-3.5 h-3.5" /> Export Config
        </button>
      </div>
      {/* VynOps version */}
      <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-brand-500 flex items-center justify-center flex-shrink-0">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-white">VynOps</p>
            <p className="text-xs text-surface-400">AI-Native Kubernetes Operations Platform</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Version',     value: '1.8.26' },
            { label: 'Framework',   value: 'Next.js 15 App Router' },
            { label: 'Runtime',     value: 'Node.js 20' },
            { label: 'License',     value: 'Private' },
          ].map(f => (
            <div key={f.label} className="rounded-xl bg-surface-800 border border-surface-700 px-3 py-2">
              <p className="text-2xs text-surface-500">{f.label}</p>
              <p className="text-xs font-mono text-white mt-0.5">{f.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Cluster info */}
      <div className="rounded-2xl bg-surface-900 border border-surface-800 p-5">
        <p className="text-xs font-semibold text-white mb-3 flex items-center gap-2">
          <Server className="w-4 h-4 text-brand-400" /> Connected Cluster
        </p>
        {probe ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[
              { label: 'Cluster',        value: activeCluster?.name ?? '�' },
              { label: 'K8s Version',    value: probe.k8s.version ?? '�' },
              { label: 'Platform',       value: probe.k8s.platform ?? '�' },
              { label: 'Nodes',          value: String(probe.k8s.nodeCount) },
              { label: 'Namespaces',     value: String(probe.k8s.namespaceCount) },
              { label: 'Provider',       value: activeCluster?.provider ?? '�' },
              { label: 'Region',         value: activeCluster?.region ?? '�' },
              { label: 'Prometheus',     value: probe.prometheus.version ?? '�' },
              { label: 'Prom Uptime',    value: fmtUptime(probe.prometheus.startTime) },
            ].map(f => (
              <div key={f.label} className="rounded-xl bg-surface-800 border border-surface-700 px-3 py-2">
                <p className="text-2xs text-surface-500">{f.label}</p>
                <p className="text-xs font-mono text-white mt-0.5">{f.value}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-surface-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Probing cluster�
          </div>
        )}
      </div>

      {/* External links */}
      <div>
        <p className="text-2xs font-bold text-surface-500 uppercase tracking-widest mb-2">Resources</p>
        <div className="space-y-2">
          {[
            { label: 'Kubernetes Documentation',   href: 'https://kubernetes.io/docs' },
            { label: 'Prometheus Documentation',   href: 'https://prometheus.io/docs' },
            { label: 'Alertmanager Documentation', href: 'https://prometheus.io/docs/alerting/latest/alertmanager' },
            { label: 'Grafana Documentation',      href: 'https://grafana.com/docs/grafana/latest' },
            { label: 'Loki Documentation',         href: 'https://grafana.com/docs/loki/latest' },
            { label: 'Jaeger Documentation',       href: 'https://www.jaegertracing.io/docs' },
            { label: 'Groq API Reference',         href: 'https://console.groq.com/docs/openai' },
            { label: 'Next.js Documentation',      href: 'https://nextjs.org/docs' },
            { label: 'Tailwind CSS Documentation', href: 'https://tailwindcss.com/docs' },
          ].map(link => (
            <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-surface-900 border border-surface-800 hover:border-surface-700 text-sm text-surface-300 hover:text-white transition-all">
              {link.label}
              <ExternalLink className="w-3 h-3 ml-auto text-surface-600" />
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

// -- Profile tab -----------------------------------------------------------
function ProfileTab() {
  const { data: session } = useSession()
  const role = useRole()
  const sessionUser = session?.user as any

  const [form, setForm] = useState({
    name: '', email: '', team: 'Platform Engineering',
    role: 'viewer', timezone: 'Asia/Kolkata',
    platform_name: 'VynOps', platform_tagline: 'AI Platform',
  })
  const [saved, setSaved] = useState(false)
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [pwSaving, setPwSaving] = useState(false)
  const [pwError, setPwError]  = useState<string | null>(null)
  const [pwOk, setPwOk]        = useState(false)

  // Seed from session + localStorage once session loads
  useEffect(() => {
    if (!sessionUser?.name) return
    try {
      const stored = JSON.parse(localStorage.getItem('user_profile') ?? '{}')
      // Only use stored name/email if they belong to the current logged-in user
      // (prevents stale data from a previous user's session bleeding in)
      const sameUser = !stored.email || stored.email === sessionUser.email

      // Auto-heal stale old admin name persisted in localStorage.
      const migratedName = (stored.name === 'Alex Kumar' && sessionUser.name === 'Alex Karev')
        ? 'Alex Karev'
        : stored.name
      if (sameUser && migratedName !== stored.name) {
        localStorage.setItem('user_profile', JSON.stringify({ ...stored, name: migratedName }))
      }

      setForm(f => ({
        ...f,
        name:  sameUser ? (migratedName  ?? sessionUser.name  ?? '') : (sessionUser.name  ?? ''),
        email: sameUser ? (stored.email ?? sessionUser.email ?? '') : (sessionUser.email ?? ''),
        team:     stored.team     ?? f.team,
        role:     sessionUser.role ?? 'viewer',   // always from session, not editable
        platform_name:    stored.platform_name    ?? f.platform_name,
        platform_tagline: stored.platform_tagline ?? f.platform_tagline,
      }))
    } catch {}
  }, [sessionUser?.name, sessionUser?.email, sessionUser?.role])

  const save = async () => {
    localStorage.setItem('user_profile', JSON.stringify(form))
    localStorage.setItem('pref_tz', form.timezone)
    window.dispatchEvent(new Event('storage'))
    if (sessionUser?.id) {
      try {
        await fetch('/api/settings/users', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionUser.id, name: form.name, email: form.email, team: form.team }),
        })
      } catch { /* non-critical � local save succeeded */ }
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div className="space-y-5 max-w-lg">
      {/* Avatar card */}
      <div className="flex items-center gap-4 p-4 rounded-2xl bg-surface-900 border border-surface-800">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center text-white font-bold text-xl flex-shrink-0">
          {form.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <p className="text-sm font-bold text-white">{form.name}</p>
          <p className="text-xs text-surface-400">{form.email}</p>
          <span className="text-2xs px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-400 border border-brand-500/20 mt-1 inline-block capitalize">{form.role}</span>
        </div>
      </div>

      {[
        { label: 'Full Name',  key: 'name',  type: 'text' },
        { label: 'Email',      key: 'email', type: 'email' },
        { label: 'Team',       key: 'team',  type: 'text' },
      ].map(f => (
        <div key={f.key}>
          <label className="text-2xs font-medium text-surface-500 uppercase tracking-wider block mb-1.5">{f.label}</label>
          <input type={f.type} value={form[f.key as keyof typeof form]}
            onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
            className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white outline-none transition-all" />
        </div>
      ))}

      <div>
        <label className="text-2xs font-medium text-surface-500 uppercase tracking-wider block mb-1.5">Timezone</label>
        <input type="text" value={form.timezone} placeholder="UTC"
          onChange={e => setForm(p => ({ ...p, timezone: e.target.value }))}
          className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white outline-none transition-all" />
        <p className="text-2xs text-surface-500 mt-1">E.g. UTC, America/New_York, Asia/Kolkata</p>
      </div>

      {/* Platform branding � admin only */}
      <div className="pt-3 border-t border-surface-800 space-y-4">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-surface-400 uppercase tracking-wider">Platform Branding</p>
          {role !== 'admin' && <span className="text-2xs text-warning bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded">Admin only</span>}
        </div>
        <p className="text-2xs text-surface-500 -mt-2">Shown in the sidebar logo area.</p>
        {[
          { label: 'Platform Name',    key: 'platform_name',    placeholder: 'VynOps' },
          { label: 'Platform Tagline', key: 'platform_tagline', placeholder: 'AI Platform' },
        ].map(f => (
          <div key={f.key}>
            <label className="text-2xs font-medium text-surface-500 uppercase tracking-wider block mb-1.5">{f.label}</label>
            <input type="text" value={form[f.key as keyof typeof form]} placeholder={f.placeholder}
              readOnly
              onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
              className="w-full bg-surface-900 border border-surface-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none transition-all opacity-60 cursor-not-allowed" />
          </div>
        ))}
        <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-950 border border-surface-800">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center flex-shrink-0">
            <span className="text-white font-bold text-sm">{(form.platform_name || 'M').charAt(0).toUpperCase()}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-white font-bold text-sm leading-tight">{form.platform_name || 'VynOps'}</span>
            <span className="text-brand-500 text-2xs font-medium tracking-widest uppercase">{form.platform_tagline || 'AI Platform'}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} className="flex items-center gap-1.5 px-4 py-2 bg-brand-500 hover:bg-brand-600 rounded-xl text-sm font-medium text-white transition-all">
          <Save className="w-3.5 h-3.5" /> Save Changes
        </button>
        {saved && <span className="flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="w-3.5 h-3.5" />Saved</span>}
      </div>

      {/* -- Change Password -------------------------------- */}
      <div className="pt-3 border-t border-surface-800 space-y-4">
        <p className="text-xs font-semibold text-surface-400 uppercase tracking-wider">Change Password</p>
        {[
          { label: 'Current Password', key: 'current' },
          { label: 'New Password',     key: 'next'    },
          { label: 'Confirm New',      key: 'confirm' },
        ].map(f => (
          <div key={f.key}>
            <label className="text-2xs font-medium text-surface-500 uppercase tracking-wider block mb-1.5">{f.label}</label>
            <input type="password" value={pw[f.key as keyof typeof pw]}
              onChange={e => { setPwError(null); setPwOk(false); setPw(p => ({ ...p, [f.key]: e.target.value })) }}
              className="w-full bg-surface-900 border border-surface-700 focus:border-brand-500 rounded-xl px-3 py-2.5 text-sm text-white outline-none transition-all" />
          </div>
        ))}
        {pwError && <p className="text-xs text-danger">{pwError}</p>}
        {pwOk    && <p className="flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="w-3.5 h-3.5" />Password updated</p>}
        <button
          disabled={pwSaving || !pw.current || !pw.next || !pw.confirm}
          onClick={async () => {
            if (pw.next !== pw.confirm) { setPwError('Passwords do not match'); return }
            if (pw.next.length < 8)    { setPwError('Minimum 8 characters');    return }
            setPwSaving(true); setPwError(null)
            try {
              const res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: pw.current, newPassword: pw.next }),
              })
              const data = await res.json()
              if (!res.ok) { setPwError(data.error ?? 'Failed'); return }
              setPwOk(true)
              setPw({ current: '', next: '', confirm: '' })
              setTimeout(() => setPwOk(false), 3000)
            } catch { setPwError('Network error') }
            finally { setPwSaving(false) }
          }}
          className="flex items-center gap-1.5 px-4 py-2 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed">
          <Save className="w-3.5 h-3.5" /> {pwSaving ? 'Updating�' : 'Update Password'}
        </button>
      </div>
    </div>
  )
}

// -- Main page -------------------------------------------------------------
// -- Clusters tab --------------------------------------------------------
const PROVIDERS = ['on-prem', 'aws', 'gcp', 'azure', 'oracle', 'digitalocean', 'other'] as const

type EditForm = {
  name: string; provider: string; region: string; environment: string; description: string
  k8sUrl: string; promUrl: string; alertmanagerUrl: string
  lokiUrl: string; jaegerUrl: string; grafanaUrl: string
}

function EditClusterModal({ cluster, onClose, onSaved }: {
  cluster: K8sCluster
  onClose: () => void
  onSaved: (updated: K8sCluster) => void
}) {
  const [form, setForm] = useState<EditForm>({
    name:            cluster.name,
    provider:        cluster.provider,
    region:          cluster.region,
    environment:     cluster.environment ?? 'production',
    description:     cluster.description ?? '',
    k8sUrl:          cluster.k8sUrl          ?? '',
    promUrl:         cluster.promUrl         ?? '',
    alertmanagerUrl: cluster.alertmanagerUrl ?? '',
    lokiUrl:         cluster.lokiUrl         ?? '',
    jaegerUrl:       cluster.jaegerUrl       ?? '',
    grafanaUrl:      cluster.grafanaUrl      ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  const field = (key: keyof EditForm, label: string, placeholder = '', type = 'text') => (
    <div className="space-y-1">
      <label className="text-2xs text-surface-400 uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        placeholder={placeholder}
        className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-xs text-white placeholder:text-surface-600 focus:outline-none focus:border-brand-500"
      />
    </div>
  )

  async function handleSave() {
    if (!form.name.trim() || !form.k8sUrl.trim()) {
      setError('Name and K8s API URL are required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/clusters', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cluster.id, ...form }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      onSaved(data as K8sCluster)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-lg bg-surface-950 border border-surface-800 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Pencil className="w-4 h-4 text-brand-400" /> Edit Cluster
          </h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-400">
              <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
            </div>
          )}

          {field('name', 'Cluster Name', 'e.g. production-k8s')}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-2xs text-surface-400 uppercase tracking-wider">Provider</label>
              <select
                value={form.provider}
                onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
                className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand-500"
              >
                {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            {field('region', 'Region', 'e.g. us-east-1')}
            <div className="space-y-1">
              <label className="text-2xs text-surface-400 uppercase tracking-wider">Environment</label>
              <select
                value={form.environment}
                onChange={e => setForm(f => ({ ...f, environment: e.target.value }))}
                className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand-500"
              >
                {(['production', 'staging', 'development', 'lab'] as const).map(e => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </div>
            {field('description', 'Description', 'Optional � e.g. Primary production cluster')}
          </div>

          <div className="pt-1 pb-0.5">
            <p className="text-2xs text-surface-500 uppercase tracking-wider font-medium">Service URLs</p>
          </div>
          {field('k8sUrl',          'K8s API URL *',     'http://10.0.0.1:8001')}
          {field('promUrl',         'Prometheus URL',     'http://prometheus:9090')}
          {field('alertmanagerUrl', 'Alertmanager URL',   'http://alertmanager:9093')}
          {field('lokiUrl',         'Loki URL',           'http://loki:3100')}
          {field('jaegerUrl',       'Jaeger URL',         'http://jaeger:16686')}
          {field('grafanaUrl',      'Grafana URL',        'http://grafana:3000')}

          <p className="text-2xs text-surface-600">
            Changing the K8s API URL will re-probe the cluster to update version and node count.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-surface-800">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-surface-400 hover:text-white rounded-xl hover:bg-surface-800 transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-xl text-xs font-medium transition-colors"
          >
            {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving�</> : <><Save className="w-3.5 h-3.5" /> Save Changes</>}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

function ClustersTab() {
  const { clusters, setClusters, activeCluster, setActiveCluster } = useDashboardStore()
  const [loading,  setLoading]  = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [tabError, setTabError] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<K8sCluster | null>(null)

  const STATUS_DOT: Record<string, string> = {
    healthy: 'bg-green-500', degraded: 'bg-yellow-500',
    critical: 'bg-red-500',  unknown:  'bg-surface-500',
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/settings/clusters')
      const data: K8sCluster[] = await res.json()
      setClusters(data)
    } catch { setTabError('Failed to load clusters.') }
    finally   { setLoading(false) }
  }, [setClusters])

  useEffect(() => { load() }, [load])

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Remove cluster "${name}"?`)) return
    setDeleting(id)
    try {
      await fetch('/api/settings/clusters', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const updated = clusters.filter(c => c.id !== id)
      setClusters(updated)
      if (activeCluster?.id === id) setActiveCluster(updated[0] ?? null)
    } catch { setTabError('Failed to remove cluster.') }
    finally { setDeleting(null) }
  }

  function handleSaved(updated: K8sCluster) {
    const next = clusters.map(c => c.id === updated.id ? updated : c)
    setClusters(next)
    if (activeCluster?.id === updated.id) setActiveCluster(updated)
    setEditTarget(null)
  }

  const [probing, setProbing] = useState<string | null>(null)
  async function handleProbe(id: string) {
    setProbing(id)
    try {
      const res = await fetch('/api/settings/clusters', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const updated: K8sCluster = await res.json()
      const next = clusters.map(c => c.id === updated.id ? updated : c)
      setClusters(next)
      if (activeCluster?.id === updated.id) setActiveCluster(updated)
    } catch { setTabError('Failed to probe cluster.') }
    finally { setProbing(null) }
  }

  return (
    <>
    {editTarget && (
      <AnimatePresence>
        <EditClusterModal cluster={editTarget} onClose={() => setEditTarget(null)} onSaved={handleSaved} />
      </AnimatePresence>
    )}
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Kubernetes Clusters</h2>
          <p className="text-xs text-surface-500 mt-0.5">Registered clusters � switch active, remove, or add new</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-white transition-colors" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <a href="/dashboard/settings/clusters?manage=1"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-xs font-medium transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add Cluster
          </a>
        </div>
      </div>

      {tabError && (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-400">
          <XCircle className="w-3.5 h-3.5" /> {tabError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-surface-500 py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading clusters�
        </div>
      ) : clusters.length === 0 ? (
        <div className="rounded-2xl bg-surface-900 border border-surface-800 p-8 text-center">
          <Layers className="w-8 h-8 text-surface-600 mx-auto mb-2" />
          <p className="text-sm text-surface-400">No clusters registered yet.</p>
          <a href="/dashboard/settings/clusters?manage=1"
            className="inline-flex items-center gap-1.5 mt-3 text-xs text-brand-400 hover:underline">
            <Plus className="w-3 h-3" /> Add your first cluster
          </a>
        </div>
      ) : (
        <div className="space-y-2">
          {clusters.map(c => (
            <div key={c.id}
              className={cn(
                'flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 rounded-2xl border transition-all',
                activeCluster?.id === c.id
                  ? 'bg-brand-500/5 border-brand-500/30'
                  : 'bg-surface-900 border-surface-800 hover:border-surface-700',
              )}>
              <div className="flex items-center gap-3 flex-1 min-w-0">
              <span className={cn('w-2 h-2 rounded-full flex-shrink-0', STATUS_DOT[c.status] ?? 'bg-surface-500')} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-white truncate">{c.name}</span>
                  {activeCluster?.id === c.id && (
                    <span className="text-2xs px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-400 border border-brand-500/20">active</span>
                  )}
                  {c.environment && (
                    <span className={cn('text-2xs px-1.5 py-0.5 rounded border',
                      c.environment === 'production'  ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                      c.environment === 'staging'     ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' :
                      c.environment === 'development' ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' :
                                                        'text-surface-400 bg-surface-500/10 border-surface-500/20'
                    )}>{c.environment}</span>
                  )}
                </div>
                <p className="text-2xs text-surface-500 mt-0.5">
                  {c.provider} � {c.region || '�'} � v{c.version} � {c.nodeCount} node{c.nodeCount !== 1 ? 's' : ''}
                </p>
              </div>
              </div>
              <div className="flex items-center gap-1.5 sm:ml-0 ml-5">
                {activeCluster?.id !== c.id && (
                  <button onClick={() => setActiveCluster(c)}
                    className="px-2.5 py-1 text-2xs rounded-lg border border-brand-500/30 text-brand-400 hover:bg-brand-500/10 transition-colors">
                    Switch
                  </button>
                )}
                <button onClick={() => handleProbe(c.id)} disabled={probing === c.id} title="Re-probe live stats"
                  className="p-1.5 rounded-lg text-surface-500 hover:text-success hover:bg-success/10 transition-colors disabled:opacity-40">
                  {probing === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => setEditTarget(c)}
                  className="p-1.5 rounded-lg text-surface-500 hover:text-brand-400 hover:bg-brand-500/10 transition-colors" title="Edit cluster">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => handleDelete(c.id, c.name)} disabled={deleting === c.id}
                  className="p-1.5 rounded-lg text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40">
                  {deleting === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {clusters.length > 0 && (
        <a href="/dashboard/settings/clusters?manage=1"
          className="inline-flex items-center gap-1.5 text-xs text-brand-400 hover:underline">
          <ExternalLink className="w-3 h-3" /> Full cluster management page
        </a>
      )}
    </div>
    </>
  )
}

function SettingsInner() {
  const searchParams = useSearchParams()
  const [section, setSection] = useState<SectionId>(
    (searchParams.get('tab') as SectionId) ?? 'connections'
  )
  const [search,  setSearch]  = useState('')
  const { data: session } = useSession()
  const role = ((session?.user as any)?.role ?? 'viewer') as Role
  const router = useRouter()

  const switchSection = (next: SectionId) => {
    if (_dirtySection && _dirtySection !== next) {
      if (!window.confirm(`Unsaved changes in ${_dirtySection} � leave without saving?`)) return
    }
    setSection(next)
  }

  const filteredSections = SECTIONS.filter(s =>
    !search || s.label.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <RoleCtx.Provider value={role}>
      <div className="flex flex-col h-full">
        <div className="px-6 py-4 border-b border-surface-800 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-brand-400" /> Settings
              </h1>
              <p className="text-xs text-surface-500 mt-0.5">Platform configuration · connections · integrations · access</p>
            </div>
            <span className={cn('text-2xs px-2 py-0.5 rounded-full border font-medium capitalize',
              role === 'admin'    ? 'text-brand-400 bg-brand-500/10 border-brand-500/20' :
              role === 'operator' ? 'text-warning bg-warning/10 border-warning/20' :
                                    'text-surface-400 bg-surface-800 border-surface-700')}>
              {role}
            </span>
          </div>
          {role !== 'admin' && (
            <div className="mt-2 rounded-xl bg-surface-800 border border-surface-700 px-3 py-2 flex items-center gap-2 text-xs text-surface-400">
              <Shield className="w-3.5 h-3.5 flex-shrink-0" />
              View-only mode � contact an admin to change settings
            </div>
          )}
        </div>

        {/* Mobile section picker */}
        <div className="md:hidden px-4 py-2 border-b border-surface-800 flex-shrink-0">
          <select
            value={section}
            onChange={e => switchSection(e.target.value as SectionId)}
            className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-brand-500">
            {SECTIONS.map(s => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar � hidden on mobile */}
          <div className="hidden md:flex md:flex-col w-52 flex-shrink-0 border-r border-surface-800 p-3 space-y-0.5 overflow-y-auto">
            <div className="mb-2 relative">
              <input type="text" placeholder="Search sections�" value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full bg-surface-800 border border-surface-700 focus:border-brand-500 rounded-lg px-3 py-1.5 text-xs text-white outline-none transition-all pr-6" />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300">
                  <XCircle className="w-3 h-3" />
                </button>
              )}
            </div>
            {filteredSections.map(s => (
              <button key={s.id} onClick={() => switchSection(s.id)}
                className={cn('w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm transition-all group',
                  section === s.id ? 'bg-brand-500/10 text-brand-400' : 'text-surface-400 hover:bg-surface-800 hover:text-surface-300')}>
                <span className="flex items-center gap-2.5">
                  <s.icon className="w-3.5 h-3.5" />
                  {s.label}
                </span>
                <ChevronRight className={cn('w-3 h-3 transition-transform',
                  section === s.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-50')} />
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-3 md:p-6">
            <AnimatePresence mode="wait">
              <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
                {section === 'connections'   && <ConnectionsTab />}
                {section === 'clusters'       && <ClustersTab />}
                {section === 'datasources'   && <DataSourcesTab />}
                {section === 'integrations'  && <IntegrationsTab />}
                {section === 'notifications' && <NotificationsTab />}
                {section === 'ai-provider'   && <AIProviderTab />}
                {section === 'users'         && <UsersTab />}
                {section === 'oncall'         && <OnCallTab />}
                {section === 'access'        && <AccessTab />}
                {section === 'audit-log'     && <AuditLogTab />}
                {section === 'about'         && <AboutTab />}
                {section === 'profile'       && <ProfileTab />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </RoleCtx.Provider>
  )
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsInner />
    </Suspense>
  )
}

