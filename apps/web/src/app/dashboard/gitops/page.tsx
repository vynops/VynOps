'use client'

import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { GitBranch, GitMerge, RefreshCw, CheckCircle2, XCircle, Clock, AlertTriangle, Info, Package, Layers, ChevronDown, ChevronRight, ExternalLink, Copy, RotateCcw } from 'lucide-react'
import { useLiveData } from '@/hooks/useLiveData'
import { cn } from '@/lib/utils'
import { getClusterHeaders } from '@/store'

interface ArgoApp {
  name: string; namespace: string; project: string
  repoURL: string; path: string; targetRevision: string
  syncStatus: string; healthStatus: string; syncStatusColor: 'healthy' | 'degraded' | 'unknown' | 'syncing'
  lastSyncedAt: string | null; lastSyncMessage: string
  images: string[]; revision: string
  destination: { server: string; namespace: string }
  conditions: { type: string; message: string; level: string }[]
  provider: 'argocd'
}

interface FluxKustomization {
  name: string; namespace: string; sourceRef: Record<string, string>
  path: string; interval: string; prune: boolean
  syncStatus: string; healthStatus: string; syncStatusColor: 'healthy' | 'degraded' | 'unknown' | 'syncing'
  lastSyncedAt: string | null; lastSyncMessage: string; revision: string; repoURL: string
  provider: 'flux'
}

interface FluxHelmRelease {
  name: string; namespace: string; chart: string; chartVersion: string
  sourceRef: Record<string, string>
  syncStatus: string; healthStatus: string; syncStatusColor: 'healthy' | 'degraded' | 'unknown' | 'syncing'
  lastSyncedAt: string | null; lastSyncMessage: string; revision: string
  provider: 'flux'
}

interface GitOpsData {
  provider: 'argocd' | 'flux' | 'none'
  available: boolean
  argoApps: ArgoApp[]
  fluxKustomizations: FluxKustomization[]
  fluxHelmReleases: FluxHelmRelease[]
  managedDeployments: { name: string; namespace: string; managedBy: string; argoApp: string | null; fluxKustomization: string | null }[]
  summary: { total: number; synced: number; degraded: number; syncing: number; unknown: number }
}

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function SyncBadge({ color, status }: { color: 'healthy' | 'degraded' | 'unknown' | 'syncing'; status: string }) {
  const styles = {
    healthy: 'bg-success/10 text-success border-success/20',
    degraded: 'bg-danger/10 text-danger border-danger/20',
    syncing: 'bg-brand-500/10 text-brand-400 border-brand-500/20',
    unknown: 'bg-surface-700 text-surface-400 border-surface-600',
  }
  const icons = {
    healthy: <CheckCircle2 className="w-3 h-3" />,
    degraded: <XCircle className="w-3 h-3" />,
    syncing: <RotateCcw className="w-3 h-3 animate-spin" />,
    unknown: <Clock className="w-3 h-3" />,
  }
  return (
    <span className={cn('inline-flex items-center gap-1 text-2xs font-semibold px-2 py-0.5 rounded-full border', styles[color])}>
      {icons[color]}{status}
    </span>
  )
}

function HealthBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  const style = s === 'healthy' ? 'text-success' : s === 'degraded' || s === 'failed' ? 'text-danger' : s === 'progressing' ? 'text-brand-400' : 'text-surface-400'
  return <span className={cn('text-xs font-medium', style)}>{status}</span>
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      className="p-1 rounded text-surface-600 hover:text-brand-400 transition-colors">
      <Copy className={cn('w-3 h-3', copied && 'text-success')} />
    </button>
  )
}

function ArgoAppCard({ app }: { app: ArgoApp }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-xl bg-surface-900 border border-surface-800 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-surface-800/40 transition-colors"
        onClick={() => setExpanded(v => !v)}>
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-surface-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-surface-500 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{app.name}</span>
            <span className="text-2xs text-surface-500 bg-surface-800 px-1.5 py-0.5 rounded">{app.project}</span>
          </div>
          <div className="text-2xs text-surface-500 mt-0.5 font-mono truncate">{app.repoURL}{app.path ? `/${app.path}` : ''}</div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <SyncBadge color={app.syncStatusColor} status={app.syncStatus} />
          <HealthBadge status={app.healthStatus} />
          {app.revision && <span className="text-2xs font-mono text-surface-500 bg-surface-800 px-1.5 py-0.5 rounded">{app.revision}</span>}
          <span className="text-2xs text-surface-600" suppressHydrationWarning>{relTime(app.lastSyncedAt)}</span>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-surface-800 px-4 py-3 space-y-3 bg-surface-950/40">
          <div className="grid grid-cols-3 gap-3 text-2xs">
            <div><span className="text-surface-500">Target Revision</span><div className="font-mono text-surface-300 mt-0.5">{app.targetRevision}</div></div>
            <div><span className="text-surface-500">Destination</span><div className="font-mono text-surface-300 mt-0.5 truncate">{app.destination.namespace || app.destination.server || '—'}</div></div>
            <div><span className="text-surface-500">Namespace</span><div className="font-mono text-surface-300 mt-0.5">{app.namespace}</div></div>
          </div>
          {app.lastSyncMessage && (
            <div className={cn('text-2xs rounded-lg px-3 py-2 font-mono',
              app.syncStatusColor === 'degraded' ? 'bg-danger/5 border border-danger/20 text-danger/80' : 'bg-surface-800 text-surface-400'
            )}>{app.lastSyncMessage}</div>
          )}
          {app.images.length > 0 && (
            <div>
              <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1.5">Images</p>
              <div className="flex flex-wrap gap-1.5">
                {app.images.map(img => (
                  <span key={img} className="text-2xs font-mono bg-surface-800 border border-surface-700 px-2 py-0.5 rounded text-surface-300">{img}</span>
                ))}
              </div>
            </div>
          )}
          {app.conditions.length > 0 && (
            <div className="space-y-1">
              {app.conditions.map((c, i) => (
                <div key={i} className={cn('text-2xs rounded px-2 py-1 flex items-start gap-2',
                  c.level === 'Error' ? 'bg-danger/5 text-danger/80' : 'bg-warning/5 text-warning/80'
                )}>
                  <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                  <span><span className="font-semibold">{c.type}:</span> {c.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FluxCard({ item, kind }: { item: FluxKustomization | FluxHelmRelease; kind: 'kustomization' | 'helmrelease' }) {
  const [expanded, setExpanded] = useState(false)
  const hr = kind === 'helmrelease' ? item as FluxHelmRelease : null
  const ks = kind === 'kustomization' ? item as FluxKustomization : null
  return (
    <div className="rounded-xl bg-surface-900 border border-surface-800 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-surface-800/40 transition-colors"
        onClick={() => setExpanded(v => !v)}>
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-surface-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-surface-500 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{item.name}</span>
            <span className="text-2xs text-surface-500 bg-surface-800 px-1.5 py-0.5 rounded font-mono">{item.namespace}</span>
            {hr && <span className="text-2xs text-purple-400 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded">{hr.chart}:{hr.chartVersion}</span>}
            {ks && <span className="text-2xs text-brand-400 bg-brand-500/10 border border-brand-500/20 px-1.5 py-0.5 rounded font-mono">{ks.path}</span>}
          </div>
          {ks && <div className="text-2xs text-surface-500 mt-0.5">Source: {ks.sourceRef.kind}/{ks.sourceRef.name} · Interval: {ks.interval}</div>}
          {hr && <div className="text-2xs text-surface-500 mt-0.5">Source: {hr.sourceRef.kind}/{hr.sourceRef.name}</div>}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <SyncBadge color={item.syncStatusColor} status={item.syncStatus} />
          {item.revision && <span className="text-2xs font-mono text-surface-500 bg-surface-800 px-1.5 py-0.5 rounded">{item.revision}</span>}
          <span className="text-2xs text-surface-600" suppressHydrationWarning>{relTime(item.lastSyncedAt)}</span>
        </div>
      </div>
      {expanded && item.lastSyncMessage && (
        <div className="border-t border-surface-800 px-4 py-3 bg-surface-950/40">
          <div className={cn('text-2xs rounded-lg px-3 py-2 font-mono',
            item.syncStatusColor === 'degraded' ? 'bg-danger/5 border border-danger/20 text-danger/80' : 'bg-surface-800 text-surface-400'
          )}>{item.lastSyncMessage}</div>
        </div>
      )}
    </div>
  )
}

export default function GitOpsPage() {
  const [tab, setTab] = useState<'apps' | 'helm' | 'managed'>('apps')
  const [search, setSearch] = useState('')

  const { data, loading, refresh } = useLiveData('/api/k8s/gitops', {
    provider: 'none' as 'argocd' | 'flux' | 'none',
    available: false,
    argoApps: [] as ArgoApp[],
    fluxKustomizations: [] as FluxKustomization[],
    fluxHelmReleases: [] as FluxHelmRelease[],
    managedDeployments: [] as GitOpsData['managedDeployments'],
    summary: { total: 0, synced: 0, degraded: 0, syncing: 0, unknown: 0 },
  }, (r) => ({
    provider:           r.provider            ?? 'none',
    available:          r.available           ?? false,
    argoApps:           (r.argoApps           ?? []) as ArgoApp[],
    fluxKustomizations: (r.fluxKustomizations ?? []) as FluxKustomization[],
    fluxHelmReleases:   (r.fluxHelmReleases   ?? []) as FluxHelmRelease[],
    managedDeployments: (r.managedDeployments ?? []) as GitOpsData['managedDeployments'],
    summary:            r.summary             ?? { total: 0, synced: 0, degraded: 0, syncing: 0, unknown: 0 },
  }))

  const { provider, available, argoApps, fluxKustomizations, fluxHelmReleases, managedDeployments, summary } = data

  const filteredApps = useMemo(() =>
    argoApps.filter(a => !search || a.name.includes(search) || a.repoURL.includes(search)),
    [argoApps, search])
  const filteredFluxKs = useMemo(() =>
    fluxKustomizations.filter(a => !search || a.name.includes(search)),
    [fluxKustomizations, search])
  const filteredFluxHr = useMemo(() =>
    fluxHelmReleases.filter(a => !search || a.name.includes(search) || a.chart.includes(search)),
    [fluxHelmReleases, search])

  const providerLabel = provider === 'argocd' ? 'Argo CD' : provider === 'flux' ? 'Flux CD' : 'Not detected'
  const providerColor = provider === 'argocd' ? 'text-orange-400 bg-orange-500/10 border-orange-500/20' : provider === 'flux' ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : 'text-surface-400 bg-surface-700 border-surface-600'

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-brand-400" /> GitOps
          </h1>
          <p className="text-sm text-surface-400 mt-0.5">Argo CD · Flux CD — application sync status, health, and drift detection</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('text-xs font-semibold px-2.5 py-1 rounded-full border', providerColor)}>{providerLabel}</span>
          <button onClick={refresh} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-800 hover:bg-surface-700 border border-surface-700 text-xs text-surface-300 transition-all">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {/* Not available */}
      {!available && !loading && (
        <div className="rounded-xl bg-surface-800/50 border border-surface-700/50 p-6 space-y-4">
          <div className="flex items-start gap-3">
            <Info className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-white">No GitOps controller detected</p>
              <p className="text-xs text-surface-400 mt-1">
                VynOps looks for Argo CD Application CRDs and Flux Kustomization/HelmRelease CRDs in the cluster.
                Install one of the following to enable GitOps tracking:
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              { name: 'Argo CD', cmd: 'kubectl create namespace argocd && kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml', color: 'border-orange-500/20 bg-orange-500/5', label: 'text-orange-400' },
              { name: 'Flux CD', cmd: 'flux bootstrap github --owner=<org> --repository=<repo> --branch=main --path=clusters/production', color: 'border-blue-500/20 bg-blue-500/5', label: 'text-blue-400' },
            ].map(tool => (
              <div key={tool.name} className={cn('rounded-xl border p-4', tool.color)}>
                <p className={cn('text-sm font-semibold mb-2', tool.label)}>{tool.name}</p>
                <div className="flex items-start gap-2">
                  <code className="text-2xs font-mono text-surface-300 bg-surface-900 rounded px-2 py-1.5 flex-1 break-all">{tool.cmd}</code>
                  <CopyBtn value={tool.cmd} />
                </div>
              </div>
            ))}
          </div>
          {managedDeployments.length > 0 && (
            <div>
              <p className="text-xs text-surface-400 font-medium mb-2">Found {managedDeployments.length} Helm-managed deployments in the cluster:</p>
              <div className="flex flex-wrap gap-1.5">
                {managedDeployments.map(d => (
                  <span key={`${d.namespace}/${d.name}`} className="text-2xs font-mono bg-surface-800 border border-surface-700 px-2 py-0.5 rounded text-surface-300">
                    {d.namespace}/{d.name} <span className="text-surface-600">({d.managedBy})</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Summary cards */}
      {available && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {[
            { label: 'Total Apps',  value: summary.total,    color: 'text-white'   },
            { label: 'Synced',      value: summary.synced,   color: 'text-success' },
            { label: 'Degraded',    value: summary.degraded, color: 'text-danger'  },
            { label: 'Syncing',     value: summary.syncing,  color: 'text-brand-400' },
            { label: 'Unknown',     value: summary.unknown,  color: 'text-surface-400' },
          ].map(card => (
            <motion.div key={card.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl bg-surface-900 border border-surface-800 px-4 py-3">
              <div className={cn('text-2xl font-bold tabular-nums', card.color)}>{card.value}</div>
              <div className="text-2xs text-surface-500 mt-0.5">{card.label}</div>
            </motion.div>
          ))}
        </div>
      )}

      {/* Tabs + Search */}
      {available && (
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-surface-800 rounded-lg p-0.5">
            {provider === 'argocd' || argoApps.length > 0 ? (
              <button onClick={() => setTab('apps')}
                className={cn('text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5',
                  tab === 'apps' ? 'bg-surface-700 text-white' : 'text-surface-500 hover:text-surface-300'
                )}>
                <GitMerge className="w-3.5 h-3.5" />Applications ({argoApps.length})
              </button>
            ) : null}
            {fluxKustomizations.length > 0 && (
              <button onClick={() => setTab('apps')}
                className={cn('text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5',
                  tab === 'apps' ? 'bg-surface-700 text-white' : 'text-surface-500 hover:text-surface-300'
                )}>
                <Layers className="w-3.5 h-3.5" />Kustomizations ({fluxKustomizations.length})
              </button>
            )}
            {fluxHelmReleases.length > 0 && (
              <button onClick={() => setTab('helm')}
                className={cn('text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5',
                  tab === 'helm' ? 'bg-surface-700 text-white' : 'text-surface-500 hover:text-surface-300'
                )}>
                <Package className="w-3.5 h-3.5" />Helm Releases ({fluxHelmReleases.length})
              </button>
            )}
            {managedDeployments.length > 0 && (
              <button onClick={() => setTab('managed')}
                className={cn('text-xs px-3 py-1.5 rounded-md font-medium transition-all',
                  tab === 'managed' ? 'bg-surface-700 text-white' : 'text-surface-500 hover:text-surface-300'
                )}>Managed ({managedDeployments.length})</button>
            )}
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search apps…"
            className="ml-auto w-48 bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500" />
        </div>
      )}

      {/* Argo CD Apps / Flux Kustomizations */}
      {available && tab === 'apps' && (
        <div className="space-y-2">
          {/* Degraded first */}
          {[...filteredApps.filter(a => a.syncStatusColor === 'degraded'), ...filteredApps.filter(a => a.syncStatusColor !== 'degraded')]
            .map(app => <ArgoAppCard key={app.name} app={app} />)}
          {[...filteredFluxKs.filter(a => a.syncStatusColor === 'degraded'), ...filteredFluxKs.filter(a => a.syncStatusColor !== 'degraded')]
            .map(ks => <FluxCard key={`ks-${ks.name}`} item={ks} kind="kustomization" />)}
          {filteredApps.length === 0 && filteredFluxKs.length === 0 && (
            <div className="text-center py-8 text-surface-500 text-sm">No applications match the search.</div>
          )}
        </div>
      )}

      {/* Flux Helm Releases */}
      {available && tab === 'helm' && (
        <div className="space-y-2">
          {filteredFluxHr.map(hr => <FluxCard key={`hr-${hr.name}`} item={hr} kind="helmrelease" />)}
          {filteredFluxHr.length === 0 && (
            <div className="text-center py-8 text-surface-500 text-sm">No Helm releases found.</div>
          )}
        </div>
      )}

      {/* Managed deployments */}
      {tab === 'managed' && managedDeployments.length > 0 && (
        <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-800 bg-surface-950">
                {['Deployment', 'Namespace', 'Managed By', 'ArgoApp', 'Flux Kustomization'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {managedDeployments.map(d => (
                <tr key={`${d.namespace}/${d.name}`} className="border-b border-surface-800/50 hover:bg-surface-800/30 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-white text-xs">{d.name}</td>
                  <td className="px-4 py-2.5 text-surface-400 text-xs">{d.namespace}</td>
                  <td className="px-4 py-2.5"><span className="text-2xs bg-surface-800 border border-surface-700 px-1.5 py-0.5 rounded font-medium text-surface-300">{d.managedBy}</span></td>
                  <td className="px-4 py-2.5 font-mono text-orange-400 text-xs">{d.argoApp ?? '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-blue-400 text-xs">{d.fluxKustomization ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
