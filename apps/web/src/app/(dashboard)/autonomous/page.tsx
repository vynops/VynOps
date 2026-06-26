'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BrainCircuit, PlayCircle, CheckCircle2, XCircle, Clock, Loader2,
  AlertTriangle, ShieldCheck, Zap, RefreshCw, Info, ToggleLeft, ToggleRight,
  ChevronDown, ChevronUp, TrendingUp, TrendingDown, Minus, FlaskConical,
  Sparkles, ThumbsUp, ThumbsDown, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDashboardStore } from '@/store'

interface AutonomousConfig {
  enabled:             boolean
  dryRun:              boolean
  confidenceThreshold: number
  allowedActions:      string[]
}

interface LoopAction {
  ts:               string
  insightId:        string
  insight:          string
  action:           string
  target:           string
  namespace:        string
  confidence:       number
  dryRun:           boolean
  result:           'ok' | 'failed' | 'dry_run' | 'skipped_cooldown' | 'unresolvable'
  error?:           string
  patternKey?:      string
  outcome?:         'resolved' | 'persisted' | 'unknown' | 'pending'
  outcomeCheckedAt?: string
}

interface PatternStat {
  patternKey:         string
  action:             string
  total:              number
  resolved:           number
  persisted:          number
  successRate:        number
  multiplier:         number
  effectiveThreshold: number
  successRateDisplay: number | null
}

interface LearningData {
  baseThreshold:      number
  overallSuccessRate: number | null
  totalVerified:      number
  resolved:           number
  persisted:          number
  hasEnoughData:      boolean
  patterns:           PatternStat[]
}

interface LoopResult {
  ok:                 boolean
  dryRun:             boolean
  enabled:            boolean
  skipped?:           boolean
  reason?:            string
  insightsAnalyzed:   number
  predictionsMatched: number
  actionsOk:          number
  actionsDryRun:      number
  actionsCooldown:    number
  actionsFailed:      number
  verificationsRun:   number
  verificationResult?: { count: number; resolved: number; persisted: number }
  actions:            LoopAction[]
  ranAt:              string
  error?:             string
}

const RESULT_STYLES: Record<string, string> = {
  ok:               'text-green-400 bg-green-500/10 border-green-500/30',
  dry_run:          'text-blue-400 bg-blue-500/10 border-blue-500/30',
  failed:           'text-red-400 bg-red-500/10 border-red-500/30',
  unresolvable:     'text-orange-400 bg-orange-500/10 border-orange-500/30',
  skipped_cooldown: 'text-surface-400 bg-surface-500/10 border-surface-500/30',
}

const RESULT_LABEL: Record<string, string> = {
  ok:               'Healed',
  dry_run:          'Dry run',
  failed:           'Failed',
  unresolvable:     'Unresolvable',
  skipped_cooldown: 'Cooldown',
}

const OUTCOME_STYLES: Record<string, string> = {
  resolved: 'text-green-400 bg-green-500/10 border-green-500/30',
  persisted: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
  unknown:   'text-surface-400 bg-surface-800 border-surface-700',
  pending:   'text-blue-400 bg-blue-500/10 border-blue-500/30',
}

const OUTCOME_LABEL: Record<string, string> = {
  resolved:  'Resolved ✓',
  persisted: 'Persisted ✗',
  unknown:   'Unknown',
  pending:   'Pending…',
}

const ALLOWED_ACTIONS = [
  { id: 'restart_deployment', label: 'Restart Deployment', risk: 'Low',    comingSoon: false },
  { id: 'delete_pod',         label: 'Delete Pod',         risk: 'Medium', comingSoon: false },
  { id: 'scale_deployment',   label: 'Scale Deployment',   risk: 'Medium', comingSoon: false },
]

// ── AI Remediation Plans types ────────────────────────────────────────────────
interface PlanStep { action: string; target?: string; namespace?: string; reason: string }
interface RemediationPlan {
  id: string; incidentId: string; incidentTitle: string; severity: string; service: string
  createdAt: string; reasoning: string; confidence: number; steps: PlanStep[]
  status: 'pending' | 'approved' | 'dismissed' | 'executing' | 'done' | 'failed'
  executedAt?: string; approvedBy?: string; results?: { step: string; ok: boolean; output: string }[]; namespace: string
}

const SEV_COLOR: Record<string, string> = {
  critical: 'text-red-400 border-red-500/30 bg-red-500/10',
  high:     'text-orange-400 border-orange-500/30 bg-orange-500/10',
  medium:   'text-yellow-400 border-yellow-500/30 bg-yellow-500/10',
  low:      'text-blue-400 border-blue-500/30 bg-blue-500/10',
}
const PLAN_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending review', approved: 'Approved', dismissed: 'Dismissed',
  executing: 'Executing…', done: 'Done ✓', failed: 'Failed ✗',
}
const PLAN_STATUS_COLOR: Record<string, string> = {
  pending:   'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  approved:  'text-blue-400 bg-blue-500/10 border-blue-500/30',
  dismissed: 'text-surface-500 bg-surface-800 border-surface-700',
  executing: 'text-brand-400 bg-brand-500/10 border-brand-500/30',
  done:      'text-green-400 bg-green-500/10 border-green-500/30',
  failed:    'text-red-400 bg-red-500/10 border-red-500/30',
}

function AiPlansSection() {
  const [plans,      setPlans]      = useState<RemediationPlan[]>([])
  const [planEnabled,setPlanEnabled]= useState(false)
  const [autoExec,   setAutoExec]   = useState(false)
  const [threshold,  setThreshold]  = useState(85)
  const [cfgSaved,   setCfgSaved]   = useState(false)
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set())
  const [filter,     setFilter]     = useState<'pending' | 'all'>('pending')
  const [generating, setGenerating] = useState(false)
  const [planError,  setPlanError]  = useState<string | null>(null)

  async function loadConfig() {
    const r = await fetch('/api/settings/config')
    if (!r.ok) return
    const d = await r.json()
    setPlanEnabled(d.auto_plan_enabled ?? false)
    setAutoExec(d.auto_execute_plans ?? false)
    setThreshold(d.auto_execute_threshold ?? 85)
  }
  async function loadPlans() {
    const r = await fetch('/api/autonomous/plan')
    if (!r.ok) return
    const d = await r.json()
    setPlans(d.plans ?? [])
  }
  useEffect(() => { loadConfig(); loadPlans() }, [])

  async function savePlanConfig() {
    setPlanError(null)
    const r = await fetch('/api/settings/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_plan_enabled: planEnabled, auto_execute_plans: autoExec, auto_execute_threshold: threshold }),
    })
    if (!r.ok) { setPlanError(`Config save failed (HTTP ${r.status})`); return }
    setCfgSaved(true); setTimeout(() => setCfgSaved(false), 2000)
  }
  async function generateNow() {
    setGenerating(true)
    setPlanError(null)
    try {
      const r = await fetch('/api/autonomous/plan', { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await loadPlans()
    } catch (e: any) {
      setPlanError(e.message)
    } finally {
      setGenerating(false)
    }
  }
  async function approvePlan(id: string) {
    setLoadingIds(prev => new Set(prev).add(id))
    setPlanError(null)
    try {
      const r = await fetch(`/api/autonomous/plan/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      if (!d.ok) throw new Error(d.error ?? `Plan execution ${d.status}`)
      await loadPlans()
    } catch (e: any) {
      setPlanError(e.message)
      await loadPlans()  // refresh so failed status is visible
    } finally {
      setLoadingIds(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }
  async function dismissPlan(id: string) {
    setLoadingIds(prev => new Set(prev).add(id))
    setPlanError(null)
    try {
      const r = await fetch(`/api/autonomous/plan/${id}/approve`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await loadPlans()
    } catch (e: any) {
      setPlanError(e.message)
    } finally {
      setLoadingIds(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }
  function toggleExpand(id: string) {
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }

  const displayed     = filter === 'pending' ? plans.filter(p => p.status === 'pending') : plans
  const pendingCount  = plans.filter(p => p.status === 'pending').length

  return (
    <div className="bg-surface-900 border border-surface-700 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-surface-700">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-purple-400" /> AI Remediation Plans
          {pendingCount > 0 && <span className="px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-2xs font-bold">{pendingCount} pending</span>}
        </h2>
        <div className="flex items-center gap-2">
          <button onClick={generateNow} disabled={generating}
            className="px-3 py-1.5 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 text-xs transition-colors disabled:opacity-50 flex items-center gap-1.5">
            {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Generate now
          </button>
          <button onClick={() => setFilter(f => f === 'pending' ? 'all' : 'pending')}
            className="px-3 py-1.5 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 text-xs transition-colors">
            {filter === 'pending' ? 'Show all' : 'Pending only'}
          </button>
        </div>
      </div>

      {/* Config strip */}
      <div className="px-5 py-3 border-b border-surface-800 bg-surface-950/40 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <button onClick={() => setPlanEnabled(v => !v)}
            className={cn('w-9 h-5 rounded-full transition-colors relative', planEnabled ? 'bg-purple-500' : 'bg-surface-700')}>
            <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all', planEnabled ? 'left-4' : 'left-0.5')} />
          </button>
          <span className="text-xs text-surface-300">AI plan generation</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <button onClick={() => setAutoExec(v => !v)}
            className={cn('w-9 h-5 rounded-full transition-colors relative', autoExec ? 'bg-green-500' : 'bg-surface-700')}>
            <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all', autoExec ? 'left-4' : 'left-0.5')} />
          </button>
          <span className="text-xs text-surface-300">Auto-execute plans</span>
        </label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-surface-400">Threshold</span>
          <input type="range" min={50} max={99} value={threshold} onChange={e => setThreshold(Number(e.target.value))}
            className="w-24 accent-purple-500" />
          <span className="text-xs text-purple-300 w-8">{threshold}%</span>
        </div>
        <button onClick={savePlanConfig}
          className={cn('ml-auto px-3 py-1 rounded-lg text-xs font-medium transition-colors', cfgSaved ? 'bg-green-500/20 text-green-400' : 'bg-surface-700 hover:bg-surface-600 text-white')}>
          {cfgSaved ? 'Saved ✓' : 'Save config'}
        </button>
      </div>

      {/* Error banner */}
      {planError && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center gap-2">
          <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {planError}
          <button onClick={() => setPlanError(null)} className="ml-auto text-red-400/60 hover:text-red-400">×</button>
        </div>
      )}

      {/* Plan cards */}
      {displayed.length === 0 ? (
        <div className="p-8 text-center text-surface-500 text-sm">
          {filter === 'pending' ? 'No pending plans — system is clear ✓' : 'No plans generated yet'}
        </div>
      ) : (
        <div className="divide-y divide-surface-800">
          {displayed.map(plan => {
            const isExpanded  = expanded.has(plan.id)
            const isLoading   = loadingIds.has(plan.id)
            return (
              <div key={plan.id} className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className={cn('px-1.5 py-0.5 rounded text-2xs font-bold uppercase border', SEV_COLOR[plan.severity] ?? SEV_COLOR.low)}>{plan.severity}</span>
                      <span className={cn('px-1.5 py-0.5 rounded text-2xs font-medium border', PLAN_STATUS_COLOR[plan.status] ?? '')}>{PLAN_STATUS_LABEL[plan.status]}</span>
                      {plan.approvedBy === 'system' && <span className="px-1.5 py-0.5 rounded text-2xs bg-purple-500/10 text-purple-400 border border-purple-500/30">[auto]</span>}
                    </div>
                    <p className="text-sm font-medium text-white truncate">{plan.incidentTitle}</p>
                    <p className="text-xs text-surface-400 mt-0.5">{plan.reasoning}</p>
                  </div>
                  <div className="flex-shrink-0 flex flex-col items-end gap-1 w-20">
                    <span className="text-xs text-surface-300 font-mono">{plan.confidence}%</span>
                    <div className="w-full h-1.5 rounded-full bg-surface-700">
                      <div className={cn('h-1.5 rounded-full', plan.confidence >= 80 ? 'bg-green-500' : plan.confidence >= 60 ? 'bg-yellow-500' : 'bg-red-500')}
                        style={{ width: `${plan.confidence}%` }} />
                    </div>
                    <span className="text-2xs text-surface-500">{plan.steps.length} steps</span>
                  </div>
                </div>

                <button onClick={() => toggleExpand(plan.id)}
                  className="flex items-center gap-1 text-xs text-surface-400 hover:text-surface-300 transition-colors">
                  {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  {isExpanded ? 'Hide steps' : 'View steps'}
                </button>

                {isExpanded && (
                  <ol className="space-y-1.5 pl-1">
                    {plan.steps.map((step, i) => {
                      const sr = plan.results?.find(r => r.step === step.action)
                      return (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          <span className="w-4 h-4 rounded-full bg-surface-800 text-surface-400 text-2xs flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                          <div>
                            <span className="font-mono text-brand-300">{step.action}</span>
                            {step.target && <span className="text-surface-400"> → <span className="text-surface-300">{step.target}</span></span>}
                            <span className="text-surface-500 ml-1">— {step.reason}</span>
                            {sr && (
                              <div className={cn('mt-0.5 text-2xs font-mono rounded px-1.5 py-0.5 inline-block', sr.ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400')}>
                                {sr.output.slice(0, 120)}
                              </div>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                )}

                {plan.status === 'pending' && (
                  <div className="flex items-center gap-2">
                    <button onClick={() => approvePlan(plan.id)} disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-400 text-xs font-medium transition-colors disabled:opacity-50">
                      {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />} Approve &amp; Execute
                    </button>
                    <button onClick={() => dismissPlan(plan.id)} disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-400 text-xs transition-colors disabled:opacity-50">
                      <ThumbsDown className="w-3 h-3" /> Dismiss
                    </button>
                    <span className="text-2xs text-surface-500 ml-auto">{plan.service} · {new Date(plan.createdAt).toLocaleTimeString()}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function AutonomousPage() {
  const { activeCluster } = useDashboardStore()
  const [cfg,      setCfg]      = useState<AutonomousConfig | null>(null)
  const [history,  setHistory]  = useState<LoopAction[]>([])
  const [totalRuns,setTotalRuns]= useState(0)
  const [learning, setLearning] = useState<LearningData | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [running,  setRunning]  = useState(false)
  const [verifying,setVerifying]= useState(false)
  const [lastResult, setLastResult] = useState<LoopResult | null>(null)
  const [showResult, setShowResult] = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [success,  setSuccess]  = useState<string | null>(null)
  const [histExpanded, setHistExpanded] = useState(false)

  const loadConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/autonomous/config')
      if (r.ok) setCfg(await r.json())
    } catch { /* ignore */ }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch('/api/autonomous/history?limit=50')
      if (r.ok) {
        const d = await r.json()
        setHistory(d.entries ?? [])
        setTotalRuns(d.total ?? 0)
      }
    } catch { /* ignore */ }
  }, [])

  const loadLearning = useCallback(async () => {
    try {
      const r = await fetch('/api/autonomous/learning')
      if (r.ok) setLearning(await r.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    Promise.all([loadConfig(), loadHistory(), loadLearning()]).finally(() => setLoading(false))
  }, [loadConfig, loadHistory, loadLearning])

  // Auto-refresh history and learning every 30s so cron-triggered actions appear without manual reload
  useEffect(() => {
    const id = setInterval(() => {
      loadHistory()
      loadLearning()
    }, 30_000)
    return () => clearInterval(id)
  }, [loadHistory, loadLearning])

  async function saveConfig(update: Partial<AutonomousConfig>) {
    if (!cfg) return
    const next = { ...cfg, ...update }
    setCfg(next)
    setSaving(true)
    setError(null)
    try {
      const r = await fetch('/api/autonomous/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(next),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setSuccess('Settings saved.')
      setTimeout(() => setSuccess(null), 2500)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function runNow() {
    setRunning(true)
    setError(null)
    setShowResult(false)
    try {
      const r = await fetch('/api/autonomous/loop', { method: 'POST' })
      const d: LoopResult = await r.json()
      setLastResult(d)
      setShowResult(true)
      await Promise.all([loadHistory(), loadLearning()])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  async function verifyNow() {
    setVerifying(true)
    setError(null)
    try {
      const r = await fetch('/api/autonomous/verify', { method: 'POST' })
      const d = await r.json()
      setSuccess(`Verified ${d.verified} action${d.verified !== 1 ? 's' : ''}.`)
      setTimeout(() => setSuccess(null), 3000)
      await Promise.all([loadHistory(), loadLearning()])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setVerifying(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-surface-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
      </div>
    )
  }

  return (
    <div className="p-3 sm:p-6 max-w-4xl mx-auto space-y-6">

      {/* Page title */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center">
            <BrainCircuit className="w-5 h-5 text-brand-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Autonomous Ops</h1>
            <p className="text-xs text-surface-400">{activeCluster && <><span className="text-surface-300 font-medium">{activeCluster.name ?? activeCluster.displayName}</span>{' · '}</>}AI-triggered self-healing for your Kubernetes clusters</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { loadConfig(); loadHistory(); loadLearning() }}
            className="p-2 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-white transition-colors" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={verifyNow}
            disabled={verifying}
            className="flex items-center gap-2 px-3 py-2 bg-surface-800 hover:bg-surface-700 disabled:opacity-50 text-surface-300 rounded-xl text-sm font-medium transition-colors border border-surface-700"
            title="Check if previously healed workloads recovered"
          >
            {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
            {verifying ? 'Verifying…' : 'Verify Now'}
          </button>
          <button
            onClick={runNow}
            disabled={running}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-xl text-sm font-medium transition-colors"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
            {running ? 'Running…' : 'Run Now'}
          </button>
        </div>
      </div>

      {/* Feedback */}
      <AnimatePresence>
        {error && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
            <XCircle className="w-4 h-4 flex-shrink-0" /> {error}
            <button onClick={() => setError(null)} className="ml-auto opacity-60 hover:opacity-100">✕</button>
          </motion.div>
        )}
        {success && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="flex items-center gap-2 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl text-green-400 text-sm">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> {success}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Last run result */}
      <AnimatePresence>
        {showResult && lastResult && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden">
            <div className={cn('rounded-xl border p-4',
              lastResult.error ? 'bg-red-500/5 border-red-500/30'
                : lastResult.skipped ? 'bg-surface-800 border-surface-700'
                : lastResult.actionsOk > 0 ? 'bg-green-500/5 border-green-500/30'
                : 'bg-blue-500/5 border-blue-500/30')}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-white flex items-center gap-2">
                  <Zap className="w-4 h-4 text-brand-400" /> Run Result
                </span>
                <button onClick={() => setShowResult(false)} className="text-surface-500 hover:text-surface-300 text-xs">Dismiss</button>
              </div>
              {lastResult.error ? (
                <p className="text-sm text-red-400">{lastResult.error}</p>
              ) : lastResult.skipped ? (
                <p className="text-sm text-surface-400">{lastResult.reason}</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                  {[
                    { label: 'Insights analysed',  value: lastResult.insightsAnalyzed },
                    { label: 'Predictions matched', value: lastResult.predictionsMatched },
                    { label: lastResult.dryRun ? 'Would heal' : 'Healed', value: lastResult.dryRun ? lastResult.actionsDryRun : lastResult.actionsOk },
                    { label: 'Failed',             value: lastResult.actionsFailed },
                    { label: 'Outcomes verified',  value: lastResult.verificationsRun ?? 0 },
                  ].map(s => (
                    <div key={s.label} className="bg-surface-800 rounded-lg px-3 py-2">
                      <div className="text-surface-500">{s.label}</div>
                      <div className="text-white font-bold text-base mt-0.5">{s.value}</div>
                    </div>
                  ))}
                </div>
              )}
              {lastResult.dryRun && !lastResult.skipped && (
                <p className="mt-2 text-2xs text-blue-400 flex items-center gap-1">
                  <Info className="w-3 h-3" /> Dry-run mode — no changes were made. Disable dry-run to apply healing.
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {cfg && (
        <>
          {/* Master toggle */}
          <div className="bg-surface-900 border border-surface-700 rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">Autonomous Healing</h2>
                <p className="text-xs text-surface-400 mt-0.5">
                  When enabled, VynOps automatically remediates high-confidence predictions on a 5-minute cycle.
                </p>
              </div>
              <button
                onClick={() => saveConfig({ enabled: !cfg.enabled })}
                disabled={saving}
                className="flex-shrink-0 ml-4"
              >
                {cfg.enabled
                  ? <ToggleRight className="w-10 h-6 text-green-400" />
                  : <ToggleLeft  className="w-10 h-6 text-surface-500" />
                }
              </button>
            </div>

            {/* Status pill */}
            <div className={cn('mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border',
              cfg.enabled ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-surface-400 bg-surface-800 border-surface-700')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', cfg.enabled ? 'bg-green-400 animate-pulse' : 'bg-surface-500')} />
              {cfg.enabled ? 'Active — loop fires every 5 minutes' : 'Disabled'}
            </div>
          </div>

          {/* Configuration */}
          <div className="bg-surface-900 border border-surface-700 rounded-2xl p-5 space-y-5">
            <h2 className="text-sm font-semibold text-white">Configuration</h2>

            {/* Dry-run toggle */}
            <div className="flex items-center justify-between p-3 bg-surface-800 rounded-xl border border-surface-700">
              <div>
                <div className="text-sm text-white font-medium flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-blue-400" /> Dry-run mode
                </div>
                <p className="text-xs text-surface-400 mt-0.5">Log what would be done, but take no actual action. Recommended when testing.</p>
              </div>
              <button onClick={() => saveConfig({ dryRun: !cfg.dryRun })} disabled={saving} className="ml-4 flex-shrink-0">
                {cfg.dryRun
                  ? <ToggleRight className="w-10 h-6 text-blue-400" />
                  : <ToggleLeft  className="w-10 h-6 text-surface-500" />
                }
              </button>
            </div>

            {/* Confidence threshold */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider">
                  Min Confidence Threshold
                </label>
                <span className="text-sm font-bold text-brand-400">{cfg.confidenceThreshold}%</span>
              </div>
              <input
                type="range" min={50} max={99} step={5}
                value={cfg.confidenceThreshold}
                onChange={e => setCfg(c => c ? { ...c, confidenceThreshold: +e.target.value } : c)}
                onMouseUp={e => saveConfig({ confidenceThreshold: +(e.target as HTMLInputElement).value })}
                className="w-full accent-brand-500"
              />
              <div className="flex justify-between text-2xs text-surface-500 mt-1">
                <span>50% (aggressive)</span>
                <span>99% (conservative)</span>
              </div>
              <p className="text-xs text-surface-500 mt-1">
                Only predictions with AI confidence ≥ {cfg.confidenceThreshold}% will trigger an action.
              </p>
            </div>

            {/* Allowed actions */}
            <div>
              <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider block mb-2">Allowed Actions</label>
              <div className="space-y-2">
                {ALLOWED_ACTIONS.map(a => (
                  <label key={a.id} className={cn(
                    'flex items-center gap-3 p-3 bg-surface-800 rounded-xl border border-surface-700 transition-colors',
                    a.comingSoon ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-surface-600',
                  )}>
                    <input
                      type="checkbox"
                      disabled={a.comingSoon}
                      checked={!a.comingSoon && cfg.allowedActions.includes(a.id)}
                      onChange={e => {
                        if (a.comingSoon) return
                        const next = e.target.checked
                          ? [...cfg.allowedActions, a.id]
                          : cfg.allowedActions.filter(x => x !== a.id)
                        saveConfig({ allowedActions: next })
                      }}
                      className="accent-brand-500 w-4 h-4"
                    />
                    <div className="flex-1">
                      <span className="text-sm text-white">{a.label}</span>
                      {a.comingSoon && <span className="ml-2 text-2xs text-surface-500">(not yet wired)</span>}
                    </div>
                    <span className={cn('text-2xs px-2 py-0.5 rounded-full border',
                      a.risk === 'Low'    ? 'text-green-400 bg-green-500/10 border-green-500/30' :
                      a.risk === 'Medium' ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30' :
                                            'text-red-400 bg-red-500/10 border-red-500/30')}>
                      {a.risk} risk
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* How it works */}
      <div className="bg-surface-900/50 border border-surface-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <Info className="w-4 h-4 text-brand-400" /> How it works
        </h2>
        <ol className="space-y-2 text-xs text-surface-400 list-none">
          {[
            ['Every 5 min', 'VynOps polls live AI insights (restart trends, OOM kills, CPU throttle, memory pressure)'],
            ['Qualify',     `Only predictions with severity critical/high AND confidence ≥ ${cfg?.confidenceThreshold ?? 80}% proceed`],
            ['Cooldown',    'Each workload has a 1-hour cooldown — no repeated healing storms'],
            ['Resolve',     'Pod → ReplicaSet → Deployment owner chain is resolved before patching'],
            ['Act or Log',  'In dry-run mode: logged only. Live mode: patches K8s, sends Slack alert, appends to audit log'],
          ].map(([step, desc], i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="w-5 h-5 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center text-2xs font-bold flex-shrink-0 mt-0.5">{i + 1}</span>
              <span><strong className="text-surface-300">{step}:</strong> {desc}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* ── AI Remediation Plans (L5) ── */}
      <AiPlansSection />

      {/* History */}
      <div className="bg-surface-900 border border-surface-700 rounded-2xl overflow-hidden">
        <button
          onClick={() => setHistExpanded(h => !h)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface-800/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-brand-400" />
            <span className="text-sm font-semibold text-white">Action History</span>
            <span className="text-2xs px-2 py-0.5 bg-surface-800 rounded-full text-surface-400 border border-surface-700">{totalRuns} total</span>
          </div>
          {histExpanded ? <ChevronUp className="w-4 h-4 text-surface-500" /> : <ChevronDown className="w-4 h-4 text-surface-500" />}
        </button>

        <AnimatePresence>
          {histExpanded && (
            <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
              {history.length === 0 ? (
                <div className="px-5 pb-5 text-sm text-surface-500 text-center py-8">
                  No actions recorded yet. Click <strong>Run Now</strong> to execute a loop cycle.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-800 border-t border-surface-700">
                      <tr>
                        {['Time', 'Insight', 'Action', 'Target', 'Confidence', 'Result', 'Outcome'].map(h => (
                          <th key={h} className="px-4 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-800">
                      {history.map((a, i) => (
                        <tr key={i} className="hover:bg-surface-800/30 transition-colors">
                          <td className="px-4 py-2.5 font-mono text-surface-400 whitespace-nowrap">
                            {new Date(a.ts).toLocaleString()}
                          </td>
                          <td className="px-4 py-2.5 text-surface-300 max-w-[180px] truncate" title={a.insight}>{a.insight}</td>
                          <td className="px-4 py-2.5">
                            <span className="font-mono text-2xs bg-brand-500/10 text-brand-400 px-1.5 py-0.5 rounded">{a.action}</span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-surface-300">{a.namespace}/{a.target}</td>
                          <td className="px-4 py-2.5 text-surface-300">{a.confidence}%</td>
                          <td className="px-4 py-2.5">
                            <span className={cn('text-2xs px-2 py-0.5 rounded-full border', RESULT_STYLES[a.result] ?? RESULT_STYLES.failed)}>
                              {RESULT_LABEL[a.result] ?? a.result}
                            </span>
                            {a.error && <span className="ml-1 text-red-400 text-2xs" title={a.error}>⚠</span>}
                          </td>
                          <td className="px-4 py-2.5">
                            {a.outcome ? (
                              <span className={cn('text-2xs px-2 py-0.5 rounded-full border', OUTCOME_STYLES[a.outcome] ?? OUTCOME_STYLES.unknown)}
                                title={a.outcomeCheckedAt ? `Checked: ${new Date(a.outcomeCheckedAt).toLocaleString()}` : undefined}>
                                {OUTCOME_LABEL[a.outcome] ?? a.outcome}
                              </span>
                            ) : (
                              <span className="text-surface-600 text-2xs">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Warning */}
      <div className="flex items-start gap-3 px-4 py-3 bg-yellow-500/5 border border-yellow-500/20 rounded-xl text-xs text-yellow-400">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>
          <strong>Important:</strong> Autonomous healing takes real actions on your cluster. Always start with dry-run enabled,
          review the action history, and only disable dry-run once you are confident in the configuration.
          A 1-hour per-workload cooldown prevents healing storms.
        </span>
      </div>

      {/* Learning panel */}
      <div className="bg-surface-900 border border-surface-700 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-brand-400" /> Learning Insights
          </h2>
          {learning && (
            <span className={cn('text-2xs px-2 py-0.5 rounded-full border',
              learning.hasEnoughData
                ? 'text-green-400 bg-green-500/10 border-green-500/30'
                : 'text-surface-400 bg-surface-800 border-surface-700')}>
              {learning.hasEnoughData ? 'Adaptation active' : `${learning.totalVerified}/5 samples needed`}
            </span>
          )}
        </div>

        {!learning ? (
          <p className="text-xs text-surface-500">Loading…</p>
        ) : learning.totalVerified === 0 ? (
          <p className="text-xs text-surface-400">
            No verified outcomes yet. After each live heal, the loop re-checks the workload after 5 minutes and records
            whether it recovered (<span className="text-green-400">Resolved</span>) or is still failing (<span className="text-orange-400">Persisted</span>).
            Once you have 5+ verified results, confidence thresholds auto-adjust per pattern.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                {
                  label: 'Overall Success',
                  value: learning.overallSuccessRate !== null ? `${Math.round(learning.overallSuccessRate * 100)}%` : '—',
                  sub:   `${learning.resolved} resolved / ${learning.persisted} persisted`,
                  icon:  learning.overallSuccessRate !== null && learning.overallSuccessRate >= 0.6
                    ? <TrendingUp className="w-3.5 h-3.5 text-green-400" />
                    : learning.overallSuccessRate !== null && learning.overallSuccessRate < 0.4
                      ? <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                      : <Minus className="w-3.5 h-3.5 text-surface-400" />,
                },
                {
                  label: 'Verified Actions', value: learning.totalVerified,
                  sub:   learning.hasEnoughData ? 'Thresholds adapting' : 'Need 5+ to adapt',
                  icon:  <FlaskConical className="w-3.5 h-3.5 text-brand-400" />,
                },
                {
                  label: 'Patterns tracked', value: learning.patterns.length,
                  sub:   learning.patterns.map(p => p.patternKey.split(':')[1]).join(', ') || '—',
                  icon:  <BrainCircuit className="w-3.5 h-3.5 text-brand-400" />,
                },
              ].map(s => (
                <div key={s.label} className="bg-surface-800 rounded-xl p-3 border border-surface-700">
                  <div className="flex items-center gap-1.5 text-surface-500 text-2xs mb-1">{s.icon} {s.label}</div>
                  <div className="text-lg font-bold text-white">{s.value}</div>
                  <div className="text-2xs text-surface-500 mt-0.5 truncate">{s.sub}</div>
                </div>
              ))}
            </div>

            {learning.patterns.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-surface-700">
                <table className="w-full text-xs">
                  <thead className="bg-surface-800 border-b border-surface-700">
                    <tr>
                      {['Pattern', 'Fires', 'Resolved', 'Persisted', 'Success', 'Eff. Threshold', 'Adjustment'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-800">
                    {learning.patterns.map(p => (
                      <tr key={p.patternKey} className="hover:bg-surface-800/40">
                        <td className="px-3 py-2 font-mono text-brand-400 whitespace-nowrap">{p.patternKey}</td>
                        <td className="px-3 py-2 text-surface-300">{p.total}</td>
                        <td className="px-3 py-2 text-green-400">{p.resolved}</td>
                        <td className="px-3 py-2 text-orange-400">{p.persisted}</td>
                        <td className="px-3 py-2">
                          {p.successRateDisplay !== null
                            ? <span className={cn(p.successRateDisplay >= 60 ? 'text-green-400' : p.successRateDisplay >= 40 ? 'text-yellow-400' : 'text-red-400')}>{p.successRateDisplay}%</span>
                            : <span className="text-surface-500">—</span>}
                        </td>
                        <td className="px-3 py-2 font-mono text-white">{p.effectiveThreshold}%</td>
                        <td className="px-3 py-2">
                          {p.multiplier === 1.0
                            ? <span className="text-surface-500 flex items-center gap-1"><Minus className="w-3 h-3" /> No change</span>
                            : p.multiplier < 1.0
                              ? <span className="text-green-400 flex items-center gap-1"><TrendingDown className="w-3 h-3" /> Lowered (reward)</span>
                              : <span className="text-orange-400 flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Raised (caution)</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
