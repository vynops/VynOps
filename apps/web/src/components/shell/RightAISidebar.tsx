'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Link from 'next/link'
import {
  X, Sparkles, ChevronRight, TrendingUp, AlertTriangle, Zap,
  Shield, Bot, RefreshCw, Radio, Wrench, CheckCircle2,
} from 'lucide-react'
import { useDashboardStore, getClusterHeaders } from '@/store'
import { cn } from '@/lib/utils'

// ── Types matching real API responses ────────────────────────
type RealInsight = {
  id:               string
  kind:             'prediction' | 'rca' | 'optimization' | 'security' | 'autonomous'
  severity:         'critical' | 'high' | 'medium' | 'low' | 'info'
  title:            string
  summary:          string
  confidence:       number   // 0-100
  metric:           string
  evidence:         string[]
  suggestedAction?: string
  suggestedPrompt?: string
}

type InsightsResp = {
  insights:   RealInsight[]
  cluster:    { healthScore: number; firingAlerts: number; crashLoop: number; cpu: string; memory: string }
  counts:     { total: number; critical: number }
  autoHealed: { deployment: string; namespace: string; ts: string }[]
}

type RealIncident = {
  id:              string
  title:           string
  severity:        string
  state:           string
  service:         string
  slaBreached:     boolean
  alertCount:      number
  durationMinutes: number
  blastRadius: {
    affectedServices:  string[]
    affectedUsers:     number
    slaBreached:       boolean
    dependentServices: string[]
    revenueImpact?:    number
  }
}

type IncidentsResp = {
  incidents: RealIncident[]
  metrics:   { open: number; critical: number; slaBreached: number; totalAlerts: number }
}

// ── Helpers ───────────────────────────────────────────────────
const EMPTY_INSIGHTS: InsightsResp = {
  insights:   [],
  cluster:    { healthScore: 0, firingAlerts: 0, crashLoop: 0, cpu: '0%', memory: '0%' },
  counts:     { total: 0, critical: 0 },
  autoHealed: [],
}
const EMPTY_INC: IncidentsResp = {
  incidents: [],
  metrics:   { open: 0, critical: 0, slaBreached: 0, totalAlerts: 0 },
}

const confColor = (c: number) =>
  c >= 85 ? 'text-success' : c >= 65 ? 'text-warning' : 'text-danger'

const kindIcon = (kind: string) => {
  switch (kind) {
    case 'rca':          return <AlertTriangle className="w-3.5 h-3.5" />
    case 'prediction':   return <TrendingUp    className="w-3.5 h-3.5" />
    case 'optimization': return <Zap           className="w-3.5 h-3.5" />
    case 'security':     return <Shield        className="w-3.5 h-3.5" />
    case 'autonomous':   return <Bot           className="w-3.5 h-3.5" />
    default:             return <Sparkles      className="w-3.5 h-3.5" />
  }
}

const KIND_LABEL: Record<string, string> = {
  rca: 'RCA', prediction: 'Predict', optimization: 'Optimize',
  security: 'Security', autonomous: 'Auto-fix',
}

const SEV_ICON_COLOR: Record<string, string> = {
  rca:          'text-danger',
  prediction:   'text-warning',
  optimization: 'text-brand-400',
  security:     'text-purple-400',
  autonomous:   'text-green-400',
}

export default function RightAISidebar() {
  const { rightSidebarOpen, toggleRightSidebar } = useDashboardStore()

  // Hide entirely on small screens (< 1024px)
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const [insightsData, setInsightsData] = useState<InsightsResp>(EMPTY_INSIGHTS)
  const [incidentsData, setIncidentsData] = useState<IncidentsResp>(EMPTY_INC)
  const [loading,     setLoading]     = useState(true)
  const [refreshing,  setRefreshing]  = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ai-dismissed') ?? '[]') as string[]) } catch { return new Set() }
  })
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    const ch = getClusterHeaders()
    try {
      const [insR, incR] = await Promise.allSettled([
        fetch('/api/ai/insights', { cache: 'no-store', headers: ch }).then(r => r.ok ? r.json() : EMPTY_INSIGHTS),
        fetch('/api/incidents',   { cache: 'no-store', headers: ch }).then(r => r.ok ? r.json() : EMPTY_INC),
      ])
      if (insR.status === 'fulfilled' && insR.value?.insights) setInsightsData(insR.value)
      if (incR.status === 'fulfilled' && incR.value?.incidents) setIncidentsData(incR.value)
      setLastUpdated(new Date())
    } catch { /* non-fatal */ }
    finally { setLoading(false); setRefreshing(false) }
  }, [])

  // Fetch on open; auto-refresh every 60s
  useEffect(() => {
    if (!rightSidebarOpen) return
    fetchAll()
    timerRef.current = setInterval(() => fetchAll(false), 60_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [rightSidebarOpen, fetchAll])

  const activeInsights  = insightsData.insights.filter(i => !dismissed.has(i.id))
  const activeIncident  = incidentsData.incidents.find(
    i => i.state !== 'resolved' && (i.severity === 'critical' || i.severity === 'high'),
  )
  const suggestedActions = activeInsights.filter(i => i.suggestedAction).slice(0, 3)

  return (
    <AnimatePresence>
      {isDesktop && rightSidebarOpen && (
        <motion.aside
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 280, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="flex flex-col bg-surface-950 border-l border-surface-800 h-full overflow-hidden flex-shrink-0"
        >
          {/* ── Header ── */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800 flex-shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-md bg-gradient-to-br from-brand-500 to-purple-500 flex items-center justify-center">
                <Sparkles className="w-3 h-3 text-white" />
              </div>
              <span className="text-sm font-semibold text-white">AI Intelligence</span>
              {lastUpdated && !loading && (
                <span className="flex items-center gap-1 text-2xs text-success">
                  <Radio className="w-2.5 h-2.5 animate-pulse" /> Live
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => fetchAll(true)}
                disabled={refreshing}
                className="w-6 h-6 flex items-center justify-center rounded-lg text-surface-500 hover:text-white hover:bg-surface-800 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
              </button>
              <button
                onClick={toggleRightSidebar}
                className="w-6 h-6 flex items-center justify-center rounded-lg text-surface-500 hover:text-white hover:bg-surface-800 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-none space-y-4 p-3">

            {/* ── Loading skeleton ── */}
            {loading && (
              <div className="space-y-2">
                {[1, 2, 3].map(n => (
                  <div key={n} className="rounded-xl bg-surface-900 border border-surface-800 p-2.5 space-y-2 animate-pulse">
                    <div className="h-3 w-3/4 bg-surface-800 rounded" />
                    <div className="h-2 w-full bg-surface-800 rounded" />
                    <div className="h-2 w-1/2 bg-surface-800 rounded" />
                  </div>
                ))}
              </div>
            )}

            {!loading && (
              <>
                {/* ── Auto-healed banner ── */}
                {insightsData.autoHealed.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl bg-success/10 border border-success/30 p-2.5 flex items-start gap-2"
                  >
                    <Wrench className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-semibold text-success">
                        Auto-healed {insightsData.autoHealed.length} deployment{insightsData.autoHealed.length > 1 ? 's' : ''}
                      </p>
                      <p className="text-2xs text-surface-400 mt-0.5 leading-snug">
                        {insightsData.autoHealed.map(h => `${h.namespace}/${h.deployment}`).join(', ')}
                      </p>
                    </div>
                  </motion.div>
                )}

                {/* ── Active incident banner ── */}
                {activeIncident && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl bg-danger/10 border border-danger/30 p-3 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-danger opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-danger" />
                      </span>
                      <span className="text-xs font-semibold text-danger uppercase tracking-wide">Active Incident</span>
                    </div>
                    <p className="text-xs font-medium text-white leading-snug">{activeIncident.title}</p>
                    <div className="flex items-center justify-between text-2xs text-surface-400">
                      <span>{activeIncident.alertCount} alert{activeIncident.alertCount !== 1 ? 's' : ''} · {activeIncident.service}</span>
                      <Link href="/incidents" className="text-danger hover:text-danger/80 font-medium flex items-center gap-0.5">
                        View <ChevronRight className="w-3 h-3" />
                      </Link>
                    </div>
                  </motion.div>
                )}

                {/* ── AI Insights ── */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">AI Insights</span>
                    <span className={cn('text-2xs font-medium',
                      insightsData.counts.critical > 0 ? 'text-danger' : 'text-brand-400')}>
                      {activeInsights.length} active
                      {insightsData.counts.critical > 0 && ` · ${insightsData.counts.critical} critical`}
                    </span>
                  </div>
                  <div className="space-y-2">
                    <AnimatePresence>
                      {activeInsights.length === 0 ? (
                        <div key="empty" className="rounded-xl bg-surface-900/50 border border-surface-800 p-4 text-center">
                          <CheckCircle2 className="w-5 h-5 text-success mx-auto mb-1.5" />
                          <p className="text-xs font-medium text-white">All clear</p>
                          <p className="text-2xs text-surface-500 mt-0.5">No active issues detected</p>
                        </div>
                      ) : (
                        activeInsights.slice(0, 6).map(insight => (
                          <motion.div
                            key={insight.id}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20, height: 0 }}
                            className={cn(
                              'rounded-xl border p-2.5 space-y-1.5 group',
                              insight.severity === 'critical' ? 'bg-danger/5  border-danger/20'  :
                              insight.severity === 'high'     ? 'bg-warning/5 border-warning/20' :
                                                                'bg-surface-900 border-surface-800',
                            )}
                          >
                            <div className="flex items-start gap-2">
                              <span className={cn(
                                'mt-0.5 flex-shrink-0',
                                insight.severity === 'critical' ? 'text-danger' :
                                insight.severity === 'high'     ? 'text-warning' :
                                SEV_ICON_COLOR[insight.kind]    ?? 'text-surface-400',
                              )}>
                                {kindIcon(insight.kind)}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 mb-0.5">
                                  <span className="text-2xs text-surface-500 font-mono bg-surface-800 px-1 py-0.5 rounded">
                                    {KIND_LABEL[insight.kind] ?? insight.kind}
                                  </span>
                                  {insight.metric && (
                                    <span className="text-2xs font-mono text-surface-500 truncate">{insight.metric}</span>
                                  )}
                                </div>
                                <p className="text-xs text-white font-medium leading-snug">{insight.title}</p>
                              </div>
                            </div>
                            <p className="text-2xs text-surface-400 line-clamp-2 leading-relaxed">{insight.summary}</p>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1">
                                <span className="text-2xs text-surface-500">Conf.</span>
                                <span className={cn('text-2xs font-bold', confColor(insight.confidence))}>
                                  {insight.confidence}%
                                </span>
                              </div>
                              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                {insight.suggestedPrompt && (
                                  <Link
                                    href={`/ai-copilot?q=${encodeURIComponent(insight.suggestedPrompt)}`}
                                    className="text-2xs text-brand-400 hover:text-brand-300"
                                  >
                                    Ask AI
                                  </Link>
                                )}
                                <button
                                  onClick={() => setDismissed(d => { const next = new Set([...d, insight.id]); try { localStorage.setItem('ai-dismissed', JSON.stringify([...next])) } catch {} return next })}
                                  className="text-2xs text-surface-500 hover:text-surface-300"
                                >
                                  dismiss
                                </button>
                              </div>
                            </div>
                          </motion.div>
                        ))
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* ── Suggested Actions ── */}
                {suggestedActions.length > 0 && (
                  <div>
                    <div className="text-2xs font-semibold text-surface-500 uppercase tracking-wider mb-2">Suggested Actions</div>
                    <div className="space-y-1.5">
                      {suggestedActions.map(insight => (
                        <Link
                          key={insight.id}
                          href={`/ai-copilot?q=${encodeURIComponent(insight.suggestedPrompt ?? insight.suggestedAction ?? '')}`}
                          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg bg-surface-900 hover:bg-surface-800 border border-surface-800 hover:border-surface-700 text-left transition-all group"
                        >
                          <span className={cn(
                            'flex-shrink-0',
                            insight.severity === 'critical' ? 'text-danger' :
                            insight.severity === 'high'     ? 'text-warning' : 'text-brand-400',
                          )}>
                            {kindIcon(insight.kind)}
                          </span>
                          <span className="text-xs text-surface-300 flex-1 leading-snug line-clamp-2">
                            {insight.suggestedAction}
                          </span>
                          <ChevronRight className="w-3 h-3 text-surface-600 group-hover:text-surface-400 flex-shrink-0" />
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Blast Radius ── */}
                {activeIncident && (
                  <div className="rounded-xl bg-surface-900 border border-surface-800 p-3 space-y-2">
                    <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Blast Radius</p>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-surface-400">Services affected</span>
                        <span className={cn('text-xs font-bold',
                          activeIncident.blastRadius.affectedServices.length > 3 ? 'text-danger' :
                          activeIncident.blastRadius.affectedServices.length > 0 ? 'text-warning' : 'text-surface-400')}>
                          {activeIncident.blastRadius.affectedServices.length || '—'}
                        </span>
                      </div>
                      {activeIncident.blastRadius.dependentServices.length > 0 && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-surface-400">Dependent services</span>
                          <span className="text-xs font-bold text-warning">
                            {activeIncident.blastRadius.dependentServices.length}
                          </span>
                        </div>
                      )}
                      {activeIncident.blastRadius.affectedUsers > 0 && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-surface-400">Affected users</span>
                          <span className="text-xs font-bold text-danger">
                            {activeIncident.blastRadius.affectedUsers.toLocaleString()}
                          </span>
                        </div>
                      )}
                      {(activeIncident.blastRadius.revenueImpact ?? 0) > 0 && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-surface-400">Revenue impact</span>
                          <span className="text-xs font-bold text-warning">
                            ${activeIncident.blastRadius.revenueImpact!.toLocaleString()}/min
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-surface-400">SLA breached</span>
                        <span className={cn('text-xs font-bold',
                          activeIncident.slaBreached ? 'text-danger' : 'text-success')}>
                          {activeIncident.slaBreached ? 'Yes' : 'No'}
                        </span>
                      </div>
                      {activeIncident.blastRadius.affectedServices.length > 0 && (
                        <div className="pt-1.5 border-t border-surface-800">
                          <p className="text-2xs text-surface-500 mb-1">Services</p>
                          <div className="flex flex-wrap gap-1">
                            {activeIncident.blastRadius.affectedServices.slice(0, 4).map(s => (
                              <span key={s} className="text-2xs bg-surface-800 text-surface-400 px-1.5 py-0.5 rounded font-mono truncate max-w-[120px]">
                                {s}
                              </span>
                            ))}
                            {activeIncident.blastRadius.affectedServices.length > 4 && (
                              <span className="text-2xs text-surface-500">
                                +{activeIncident.blastRadius.affectedServices.length - 4}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Cluster Health summary ── */}
                {insightsData.cluster.healthScore === 0 && !loading && (
                  <div className="rounded-xl bg-surface-900 border border-surface-800 p-3 text-center">
                    <p className="text-xs text-surface-500">Cluster health unavailable</p>
                    <p className="text-2xs text-surface-600 mt-0.5">Prometheus may be unreachable</p>
                  </div>
                )}
                {insightsData.cluster.healthScore > 0 && (
                  <div className="rounded-xl bg-surface-900 border border-surface-800 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Cluster Health</p>
                      <span className={cn('text-xs font-bold',
                        insightsData.cluster.healthScore >= 80 ? 'text-success' :
                        insightsData.cluster.healthScore >= 60 ? 'text-warning' : 'text-danger')}>
                        {insightsData.cluster.healthScore}/100
                      </span>
                    </div>
                    {/* Health bar */}
                    <div className="h-1.5 w-full bg-surface-800 rounded-full mb-3 overflow-hidden">
                      <div
                        className={cn('h-full rounded-full transition-all',
                          insightsData.cluster.healthScore >= 80 ? 'bg-success' :
                          insightsData.cluster.healthScore >= 60 ? 'bg-warning' : 'bg-danger')}
                        style={{ width: `${insightsData.cluster.healthScore}%` }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-surface-400">CPU</span>
                        <span className="text-xs font-mono text-surface-300">{insightsData.cluster.cpu}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-surface-400">Memory</span>
                        <span className="text-xs font-mono text-surface-300">{insightsData.cluster.memory}</span>
                      </div>
                      {insightsData.cluster.firingAlerts > 0 && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-surface-400">Firing alerts</span>
                          <span className="text-xs font-bold text-danger">{insightsData.cluster.firingAlerts}</span>
                        </div>
                      )}
                      {insightsData.cluster.crashLoop > 0 && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-surface-400">CrashLoops</span>
                          <span className="text-xs font-bold text-danger">{insightsData.cluster.crashLoop}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

