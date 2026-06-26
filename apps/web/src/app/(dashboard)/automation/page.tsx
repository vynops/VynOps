'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Workflow, Play, Search, Zap, GitMerge, RotateCcw, Bell, AlertTriangle,
  CheckCircle2, XCircle, Info, Terminal, Clock, RefreshCw, ChevronRight,
  Activity, Shield, Trash2, Scale, Server, Lock, Image, BarChart3, Wifi, WifiOff,
  Pencil, Plus, GripVertical, X, List,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getClusterHeaders, useDashboardStore } from '@/store'

// ── Types ─────────────────────────────────────────────────────────────────────
type Severity = 'critical' | 'warning' | 'info'
type StepStatus = 'ok' | 'warn' | 'error' | 'info' | 'pending' | 'running'
type RunStatus = 'success' | 'warning' | 'failed'

interface RunbookStep { name: string; type: 'check' | 'remediate' | 'report' }
interface RunbookDef {
  id: string; name: string; description: string
  category: string; severity: Severity; estimatedSecs: number
  icon: React.ElementType
  needsTarget: boolean; needsNode: boolean
  extraParams?: { key: string; label: string; placeholder: string; default?: string }[]
  steps: RunbookStep[]
  tags: string[]
}
interface ExecStep { name: string; status: StepStatus; output: string }
interface ExecResult {
  runbookId: string; namespace: string; target: string
  steps: ExecStep[]; duration: number; status: RunStatus
}
interface RunRecord extends ExecResult { id: string; runAt: string }

// ── 10 Runbook definitions (defaults) ───────────────────────────────────────
const RUNBOOKS_DEFAULTS: RunbookDef[] = [
  {
    id: 'diagnose-crash-loop',
    name: 'Diagnose CrashLoopBackOff',
    description: 'Find crashing pods, pull events and previous container logs to pinpoint root cause',
    category: 'Diagnosis', severity: 'critical', estimatedSecs: 4, icon: AlertTriangle,
    needsTarget: false, needsNode: false, tags: ['crash', 'debug', 'logs'],
    steps: [
      { name: 'Scan for CrashLoopBackOff pods', type: 'check' },
      { name: 'Fetch pod events', type: 'check' },
      { name: 'Retrieve previous container logs', type: 'check' },
      { name: 'Restart count analysis', type: 'report' },
    ],
  },
  {
    id: 'oom-patch-restart',
    name: 'OOMKilled — Patch Memory & Restart',
    description: 'Detect OOMKilled pods, bump the deployment memory limit by +256Mi, trigger rollout restart',
    category: 'Remediate', severity: 'critical', estimatedSecs: 6, icon: Zap,
    needsTarget: true, needsNode: false, tags: ['oom', 'memory', 'restart'],
    steps: [
      { name: 'Find OOMKilled pods', type: 'check' },
      { name: 'Read current memory limit', type: 'check' },
      { name: 'Patch memory limit (+256Mi)', type: 'remediate' },
      { name: 'Trigger rollout restart', type: 'remediate' },
      { name: 'Verify rollout health', type: 'check' },
    ],
  },
  {
    id: 'rollback-deployment',
    name: 'Rollback Failed Deployment',
    description: 'View revision history and roll back a deployment to its previous working revision',
    category: 'Deploy', severity: 'critical', estimatedSecs: 5, icon: RotateCcw,
    needsTarget: true, needsNode: false, tags: ['rollback', 'deploy', 'revision'],
    steps: [
      { name: 'Check current deployment state', type: 'check' },
      { name: 'List revision history', type: 'check' },
      { name: 'Execute rollback', type: 'remediate' },
      { name: 'Post-rollback health check', type: 'check' },
    ],
  },
  {
    id: 'force-delete-terminating',
    name: 'Force Delete Stuck Terminating Pods',
    description: 'Find pods stuck in Terminating state and delete them with gracePeriodSeconds=0',
    category: 'Cleanup', severity: 'warning', estimatedSecs: 3, icon: Trash2,
    needsTarget: false, needsNode: false, tags: ['terminating', 'stuck', 'cleanup'],
    steps: [
      { name: 'Find stuck Terminating pods', type: 'check' },
      { name: 'Force delete (gracePeriod=0)', type: 'remediate' },
      { name: 'Verify cleanup', type: 'check' },
    ],
  },
  {
    id: 'scale-deployment',
    name: 'Scale Deployment Replicas',
    description: 'Quickly scale a deployment up or down to a target replica count',
    category: 'Scale', severity: 'info', estimatedSecs: 4, icon: Scale,
    needsTarget: true, needsNode: false,
    extraParams: [{ key: 'replicas', label: 'Target replicas', placeholder: '3', default: '2' }],
    tags: ['scale', 'hpa', 'replicas'],
    steps: [
      { name: 'Read current replica count', type: 'check' },
      { name: 'Patch replicas', type: 'remediate' },
      { name: 'Watch rollout', type: 'check' },
    ],
  },
  {
    id: 'cleanup-evicted',
    name: 'Cleanup Evicted / Failed Pods',
    description: 'Find all Evicted and Failed pods across the namespace and delete them to free quota',
    category: 'Cleanup', severity: 'warning', estimatedSecs: 3, icon: Trash2,
    needsTarget: false, needsNode: false, tags: ['evicted', 'cleanup', 'quota'],
    steps: [
      { name: 'Scan for evicted/failed pods', type: 'check' },
      { name: 'Bulk delete evicted pods', type: 'remediate' },
    ],
  },
  {
    id: 'cordon-drain-node',
    name: 'Cordon & Drain Node',
    description: 'Cordon a node to prevent new scheduling, identify evictable pods, output drain command',
    category: 'Node', severity: 'warning', estimatedSecs: 5, icon: Server,
    needsTarget: false, needsNode: true,
    extraParams: [{ key: 'node', label: 'Node name', placeholder: 'worker-node-1' }],
    tags: ['node', 'drain', 'maintenance'],
    steps: [
      { name: 'Node health check', type: 'check' },
      { name: 'Cordon node', type: 'remediate' },
      { name: 'List evictable pods', type: 'check' },
      { name: 'Generate drain command', type: 'report' },
    ],
  },
  {
    id: 'audit-tls-certs',
    name: 'Audit TLS Certificates',
    description: 'Inventory all kubernetes.io/tls secrets, decode and report expiry status',
    category: 'Security', severity: 'warning', estimatedSecs: 5, icon: Lock,
    needsTarget: false, needsNode: false, tags: ['tls', 'certs', 'security', 'expiry'],
    steps: [
      { name: 'Find TLS secrets', type: 'check' },
      { name: 'Decode and check expiry', type: 'check' },
      { name: 'Renewal recommendations', type: 'report' },
    ],
  },
  {
    id: 'debug-imagepull',
    name: 'Debug ImagePullBackOff',
    description: 'Find pods failing to pull images, surface error messages, output pull secret fix commands',
    category: 'Diagnosis', severity: 'warning', estimatedSecs: 4, icon: Image,
    needsTarget: false, needsNode: false, tags: ['imagepull', 'registry', 'debug'],
    steps: [
      { name: 'Find ImagePullBackOff pods', type: 'check' },
      { name: 'Fetch pull error events', type: 'check' },
      { name: 'Root cause analysis', type: 'report' },
      { name: 'Remediation commands', type: 'report' },
    ],
  },
  {
    id: 'high-restart-pods',
    name: 'Diagnose High-Restart Pods',
    description: 'Rank pods by restart count, pull previous logs and resource allocation for top offenders',
    category: 'Diagnosis', severity: 'warning', estimatedSecs: 5, icon: BarChart3,
    needsTarget: false, needsNode: false, tags: ['restarts', 'debug', 'oom'],
    steps: [
      { name: 'Rank pods by restart count', type: 'check' },
      { name: 'Fetch events for top offender', type: 'check' },
      { name: 'Previous container logs', type: 'check' },
      { name: 'Resource allocation review', type: 'report' },
    ],
  },
]

const SEVERITY_STYLE: Record<Severity, string> = {
  critical: 'bg-danger/10 border-danger/30 text-danger',
  warning:  'bg-warning/10 border-warning/30 text-warning',
  info:     'bg-brand-500/10 border-brand-500/30 text-brand-400',
}

const STEP_STATUS_ICON: Record<StepStatus, React.ReactNode> = {
  ok:      <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0" />,
  warn:    <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0" />,
  error:   <XCircle className="w-3.5 h-3.5 text-danger flex-shrink-0" />,
  info:    <Info className="w-3.5 h-3.5 text-brand-400 flex-shrink-0" />,
  pending: <div className="w-3.5 h-3.5 rounded-full border border-surface-600 flex-shrink-0" />,
  running: <div className="w-3.5 h-3.5 rounded-full border-2 border-brand-400 border-t-transparent animate-spin flex-shrink-0" />,
}

// ── Step pipeline SVG ─────────────────────────────────────────────────────────
function StepPipeline({ steps, execSteps, running }: {
  steps: RunbookStep[]; execSteps: ExecStep[]; running: boolean
}) {
  const TYPE_CLR: Record<string, string> = { check: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/5', remediate: 'text-success border-success/30 bg-success/5', report: 'text-indigo-400 border-indigo-500/30 bg-indigo-500/5' }
  return (
    <div className="flex items-center gap-0 overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin', scrollbarColor: '#334155 #0f172a' }}>
      {steps.map((step, i) => {
        const exec = execSteps[i]
        const isRunning = running && i === execSteps.length
        const status: StepStatus = isRunning ? 'running' : (exec?.status ?? 'pending')
        const borderClr = status === 'ok' ? 'border-success/60' : status === 'warn' ? 'border-warning/60' : status === 'error' ? 'border-danger/60' : status === 'running' ? 'border-brand-500/60' : 'border-surface-700'
        const typeCls = TYPE_CLR[step.type] ?? 'text-surface-400 border-surface-700 bg-surface-800'
        return (
          <div key={step.name} className="flex items-center flex-shrink-0">
            <div className={`flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border ${borderClr} bg-surface-900 min-w-[130px] max-w-[160px]`}>
              <span className={`text-2xs px-1.5 py-0.5 rounded border font-bold uppercase ${typeCls}`}>{step.type}</span>
              <span className="text-xs font-medium text-white text-center leading-tight">{step.name}</span>
              {status === 'running' && <span className="text-2xs text-brand-400 animate-pulse">running…</span>}
              {status === 'ok' && <span className="text-2xs text-success">✓ done</span>}
              {status === 'error' && <span className="text-2xs text-danger">✗ error</span>}
              {status === 'warn' && <span className="text-2xs text-warning">⚠ warn</span>}
            </div>
            {i < steps.length - 1 && (
              <div className="flex items-center flex-shrink-0 px-1">
                <div className="w-6 h-px bg-surface-700" />
                <div className="w-0 h-0 border-t-4 border-b-4 border-l-4 border-t-transparent border-b-transparent border-l-surface-600" />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Runbook editor modal ─────────────────────────────────────────────────────
const CATEGORIES = ['Diagnosis', 'Remediate', 'Deploy', 'Cleanup', 'Scale', 'Security', 'Networking', 'Custom']
const SEVERITIES: Severity[] = ['critical', 'warning', 'info']
const STEP_TYPES: RunbookStep['type'][] = ['check', 'remediate', 'report']

function RunbookEditorModal({
  initial, onSave, onClose,
}: {
  initial: RunbookDef | null  // null = create new
  onSave: (rb: RunbookDef) => void
  onClose: () => void
}) {
  const isNew = !initial
  const [name, setName]               = useState(initial?.name ?? '')
  const [desc, setDesc]               = useState(initial?.description ?? '')
  const [category, setCategory]       = useState(initial?.category ?? 'Custom')
  const [severity, setSeverity]       = useState<Severity>(initial?.severity ?? 'info')
  const [estSecs, setEstSecs]         = useState(String(initial?.estimatedSecs ?? 5))
  const [needsTarget, setNeedsTarget] = useState(initial?.needsTarget ?? false)
  const [needsNode,   setNeedsNode]   = useState(initial?.needsNode   ?? false)
  const [tagsRaw, setTagsRaw]         = useState((initial?.tags ?? []).join(', '))
  const [steps, setSteps]             = useState<RunbookStep[]>(
    initial?.steps ?? [{ name: '', type: 'check' }]
  )

  const addStep    = () => setSteps(s => [...s, { name: '', type: 'check' }])
  const removeStep = (i: number) => setSteps(s => s.filter((_, idx) => idx !== i))
  const setStepName = (i: number, v: string) =>
    setSteps(s => s.map((st, idx) => idx === i ? { ...st, name: v } : st))
  const setStepType = (i: number, v: RunbookStep['type']) =>
    setSteps(s => s.map((st, idx) => idx === i ? { ...st, type: v } : st))

  const canSave = name.trim().length > 0 && steps.some(s => s.name.trim())

  const handleSave = () => {
    if (!canSave) return
    const rb: RunbookDef = {
      id:             initial?.id ?? `custom-${Date.now()}`,
      name:           name.trim(),
      description:    desc.trim(),
      category,
      severity,
      estimatedSecs:  Math.max(1, parseInt(estSecs) || 5),
      icon:           initial?.icon ?? Zap,
      needsTarget,
      needsNode,
      tags:           tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
      steps:          steps.filter(s => s.name.trim()),
    }
    onSave(rb)
  }

  const inputCls = 'w-full bg-surface-900 border border-surface-700 rounded-xl px-3 py-2 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 transition-colors'
  const labelCls = 'block text-2xs text-surface-500 mb-1 font-medium uppercase tracking-wider'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        transition={{ duration: 0.18 }}
        className="relative z-10 w-full max-w-2xl max-h-[90vh] bg-surface-950 border border-surface-700 rounded-2xl shadow-2xl flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800">
          <div className="flex items-center gap-2">
            {isNew ? <Plus className="w-4 h-4 text-brand-400" /> : <Pencil className="w-4 h-4 text-brand-400" />}
            <h2 className="text-sm font-bold text-white">{isNew ? 'New Runbook' : `Edit — ${initial!.name}`}</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center text-surface-500 hover:text-white hover:bg-surface-800 rounded-lg transition-all">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-5 space-y-5">
          {/* Name + Category + Severity row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="col-span-3 sm:col-span-3">
              <label className={labelCls}>Runbook Name *</label>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="e.g. Restart Unhealthy Pods" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Category</label>
              <select value={category} onChange={e => setCategory(e.target.value)}
                className={inputCls}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Severity</label>
              <select value={severity} onChange={e => setSeverity(e.target.value as Severity)}
                className={inputCls}>
                {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Est. Duration (secs)</label>
              <input type="number" min={1} max={300} value={estSecs}
                onChange={e => setEstSecs(e.target.value)} className={inputCls} />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className={labelCls}>Description</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)}
              rows={2} placeholder="What does this runbook do?"
              className={inputCls + ' resize-none'} />
          </div>

          {/* Tags + needs-target row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Tags (comma-separated)</label>
              <input value={tagsRaw} onChange={e => setTagsRaw(e.target.value)}
                placeholder="debug, restart, oom" className={inputCls} />
            </div>
            <div className="flex items-end pb-1">
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <span className={cn(
                    'w-9 h-5 rounded-full border transition-all relative flex-shrink-0',
                    needsTarget ? 'bg-brand-500 border-brand-500' : 'bg-surface-800 border-surface-700'
                  )} onClick={() => setNeedsTarget(v => !v)}>
                    <span className={cn(
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all',
                      needsTarget ? 'left-4' : 'left-0.5'
                    )} />
                  </span>
                  <span className="text-xs text-surface-300">Requires deployment target</span>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <span className={cn(
                    'w-9 h-5 rounded-full border transition-all relative flex-shrink-0',
                    needsNode ? 'bg-brand-500 border-brand-500' : 'bg-surface-800 border-surface-700'
                  )} onClick={() => setNeedsNode(v => !v)}>
                    <span className={cn(
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all',
                      needsNode ? 'left-4' : 'left-0.5'
                    )} />
                  </span>
                  <span className="text-xs text-surface-300">Requires node name</span>
                </label>
              </div>
            </div>
          </div>

          {/* Steps editor */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={labelCls}>Execution Steps</label>
              <button onClick={addStep}
                className="flex items-center gap-1 text-2xs px-2 py-1 bg-brand-500/10 border border-brand-500/30 rounded-lg text-brand-400 hover:bg-brand-500/20 transition-all">
                <Plus className="w-3 h-3" /> Add Step
              </button>
            </div>
            <div className="space-y-2">
              {steps.map((step, i) => (
                <div key={i} className="flex items-center gap-2">
                  <GripVertical className="w-4 h-4 text-surface-600 flex-shrink-0" />
                  <span className="text-2xs text-surface-600 w-4 flex-shrink-0">{i + 1}.</span>
                  <input
                    value={step.name}
                    onChange={e => setStepName(i, e.target.value)}
                    placeholder={`Step ${i + 1} name…`}
                    className="flex-1 bg-surface-900 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 transition-colors"
                  />
                  <select
                    value={step.type}
                    onChange={e => setStepType(i, e.target.value as RunbookStep['type'])}
                    className="bg-surface-900 border border-surface-700 rounded-xl px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500 transition-colors">
                    {STEP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button onClick={() => removeStep(i)}
                    disabled={steps.length <= 1}
                    className="w-7 h-7 flex items-center justify-center text-surface-500 hover:text-danger hover:bg-danger/10 rounded-lg transition-all disabled:opacity-30">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-surface-800">
          <p className="text-2xs text-surface-500">
            {steps.filter(s => s.name.trim()).length} step{steps.filter(s => s.name.trim()).length !== 1 ? 's' : ''} · {category} · {severity}
          </p>
          <div className="flex items-center gap-2">
            <button onClick={onClose}
              className="px-4 py-2 text-xs text-surface-400 hover:text-white bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl transition-all">
              Cancel
            </button>
            <button onClick={handleSave} disabled={!canSave}
              className="px-4 py-2 text-xs font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              {isNew ? 'Create Runbook' : 'Save Changes'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AutomationPage() {
  const { activeCluster } = useDashboardStore()
  const [activeId, setActiveId]         = useState(RUNBOOKS_DEFAULTS[0]!.id)
  const [search, setSearch]             = useState('')
  const [catFilter, setCatFilter]       = useState('All')
  const [namespace, setNamespace]       = useState('default')
  const [target, setTarget]             = useState('')
  const [extraParams, setExtraParams]   = useState<Record<string, string>>({})
  const [running, setRunning]           = useState(false)
  const [result, setResult]             = useState<ExecResult | null>(null)
  const [history, setHistory]           = useState<RunRecord[]>([])
  const [rightTab, setRightTab]         = useState<'output' | 'history'>('output')
  const [mobilePanel, setMobilePanel]   = useState<'list' | 'detail' | 'output'>('list')
  const [namespaces, setNamespaces]     = useState<string[]>(['default'])
  const [deployments, setDeployments]   = useState<string[]>([])
  const [k8sLive, setK8sLive]           = useState(false)
  const [runbooks, setRunbooks]         = useState<RunbookDef[]>(RUNBOOKS_DEFAULTS)
  const [editorOpen, setEditorOpen]     = useState(false)
  const [editTarget, setEditTarget]     = useState<RunbookDef | null>(null)
  // Auto-trigger: master switch + per-runbook opt-in
  const [autoEnabled,   setAutoEnabled]   = useState(false)
  const [autoAllowed,   setAutoAllowed]   = useState<Record<string, boolean>>({})
  const [autoSaved,     setAutoSaved]     = useState(false)

  const active = runbooks.find(r => r.id === activeId) ?? runbooks[0]!

  const openNew  = () => { setEditTarget(null); setEditorOpen(true) }
  const openEdit = (rb: RunbookDef) => { setEditTarget(rb); setEditorOpen(true) }
  const closeEditor = () => setEditorOpen(false)
  const saveRunbook = (rb: RunbookDef) => {
    setRunbooks(prev => {
      const idx = prev.findIndex(r => r.id === rb.id)
      if (idx >= 0) { const next = [...prev]; next[idx] = rb; return next }
      return [...prev, rb]
    })
    setActiveId(rb.id)
    setEditorOpen(false)
  }
  const deleteRunbook = (id: string) => {
    setRunbooks(prev => {
      const next = prev.filter(r => r.id !== id)
      setActiveId(next[0]?.id ?? '')
      return next
    })
  }

  // ── Load custom runbooks from localStorage on mount ──────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem('vynops_custom_runbooks')
      if (saved) {
        const custom: RunbookDef[] = JSON.parse(saved)
        const toAdd = custom.filter(c => !RUNBOOKS_DEFAULTS.some(d => d.id === c.id))
        if (toAdd.length > 0) setRunbooks([...RUNBOOKS_DEFAULTS, ...toAdd])
      }
    } catch {}
  }, [])

  // ── Persist custom runbooks to localStorage when runbooks change ──────────
  useEffect(() => {
    const custom = runbooks.filter(r => !RUNBOOKS_DEFAULTS.some(d => d.id === r.id))
    try { localStorage.setItem('vynops_custom_runbooks', JSON.stringify(custom)) } catch {}
  }, [runbooks])

  // ── Load run history from API on mount + polling ─────────────────────────
  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch('/api/automation/history?limit=200')
      if (r.ok) {
        const d = await r.json()
        setHistory(d.entries ?? [])
      }
    } catch { /* non-critical */ }
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory])

  useEffect(() => {
    const id = setInterval(() => loadHistory(), 30_000)
    return () => clearInterval(id)
  }, [loadHistory])

  // Load auto-trigger config
  useEffect(() => {
    // Default auto-run opt-in per runbook (mirrors PATTERN_MAP.autoRunAllowedDefault in auto-trigger route)
    const AUTO_RUN_DEFAULTS: Record<string, boolean> = {
      'diagnose-crash-loop':      true,
      'debug-imagepull':          true,
      'high-restart-pods':        true,
      'cleanup-evicted':          true,
      'audit-tls-certs':          true,
      'oom-patch-restart':        false,
      'force-delete-terminating': false,
      'rollback-deployment':      false,
      'scale-deployment':         false,
    }
    fetch('/api/settings/config').then(r => r.json()).then(cfg => {
      setAutoEnabled(cfg.auto_runbook_enabled ?? false)
      // Merge stored values over defaults so first-time users see the right toggles
      setAutoAllowed({ ...AUTO_RUN_DEFAULTS, ...(cfg.auto_runbook_allowed ?? {}) })
    }).catch(() => {})
  }, [])

  const saveAutoConfig = async (enabled: boolean, allowed: Record<string, boolean>) => {
    await fetch('/api/settings/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_runbook_enabled: enabled, auto_runbook_allowed: allowed }),
    }).catch(() => {})
    setAutoSaved(true)
    setTimeout(() => setAutoSaved(false), 2500)
  }

  const clearHistory = async () => {
    try {
      await fetch('/api/automation/history', { method: 'DELETE' })
      setHistory([])
    } catch { /* non-critical */ }
  }

  const deleteRun = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await fetch(`/api/automation/history?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      setHistory(h => h.filter(r => r.id !== id))
    } catch { /* non-critical */ }
  }

  // ── Fetch namespaces via workloads API ────────────────────────────────────
  useEffect(() => {
    fetch('/api/k8s/workloads', { headers: getClusterHeaders(), signal: AbortSignal.timeout(6000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return
        const ns = [...new Set<string>(
          (d.deployments ?? []).map((dep: any) => dep.namespace as string).filter(Boolean)
        )].sort()
        if (ns.length) { setNamespaces(ns); setK8sLive(true) }
      })
      .catch(() => {})
  }, [])

  // ── Fetch deployments when namespace changes ──────────────────────────────
  useEffect(() => {
    setTarget('')
    fetch(`/api/k8s/deployments?namespace=${namespace}`, { headers: getClusterHeaders(), signal: AbortSignal.timeout(4000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const deps: string[] = (d?.items ?? d?.deployments ?? []).map((dep: any) =>
          dep.metadata?.name ?? dep.name ?? dep
        )
        setDeployments(deps)
        if (deps.length) setTarget(deps[0]!)
      })
      .catch(() => {})
  }, [namespace])

  // ── Reset result when runbook changes ─────────────────────────────────────
  useEffect(() => {
    setResult(null)
    const rb = runbooks.find(r => r.id === activeId)
    if (rb?.extraParams) {
      const defaults: Record<string, string> = {}
      rb.extraParams.forEach(p => { defaults[p.key] = p.default ?? '' })
      setExtraParams(defaults)
    } else {
      setExtraParams({})
    }
  }, [activeId])

  // ── Execute runbook ────────────────────────────────────────────────────────
  const executeRunbook = useCallback(async () => {
    if (running) return
    setRunning(true)
    setResult(null)
    setRightTab('output')

    try {
      const res = await fetch('/api/automation/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getClusterHeaders() },
        body: JSON.stringify({
          runbookId: active.id,
          namespace,
          target,
          params: extraParams,
        }),
      })
      const data: ExecResult = await res.json()
      setResult(data)
      // Persist to server then reload to get authoritative list (avoids duplicates)
      const record: RunRecord = { ...data, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), runAt: new Date().toISOString() }
      fetch('/api/automation/history', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(record),
      }).then(() => loadHistory()).catch(() => {
        // Fall back to optimistic update if server is unavailable
        setHistory(h => [record, ...h].slice(0, 200))
      })
    } catch (err: any) {
      const failed: ExecResult = {
        runbookId: active.id, namespace, target,
        steps: [{ name: 'Network error', status: 'error', output: String(err.message ?? err) }],
        duration: 0, status: 'failed',
      }
      setResult(failed)
    } finally {
      setRunning(false)
    }
  }, [running, active, namespace, target, extraParams])

  // ── Derived ────────────────────────────────────────────────────────────────
  const categories = ['All', ...new Set(runbooks.map(r => r.category))]
  const filtered = runbooks.filter(r => {
    if (catFilter !== 'All' && r.category !== catFilter) return false
    if (search && !r.name.toLowerCase().includes(search.toLowerCase()) &&
        !r.tags.some(t => t.includes(search.toLowerCase()))) return false
    return true
  })

  const todayRuns    = history.filter(h => h.runAt.startsWith(new Date().toISOString().slice(0, 10)))
  const autoRuns     = history.filter((h: any) => h.triggeredBy === 'incident')
  const isCustom     = !RUNBOOKS_DEFAULTS.some(r => r.id === active?.id)
  const successCount = history.filter(h => h.status === 'success').length
  const successRate  = history.length ? Math.round(successCount / history.length * 100) : 0
  const avgDuration  = history.length
    ? Math.round(history.reduce((s, h) => s + h.duration, 0) / history.length / 100) / 10
    : 0

  return (
    <>
    <div className="flex flex-col h-full">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800 flex-shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Workflow className="w-5 h-5 text-brand-400" /> Automation Studio
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">{activeCluster && <><span className="text-surface-300 font-medium">{activeCluster.name ?? activeCluster.displayName}</span>{' · '}</>}Production runbooks · live K8s execution · real cluster data</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Session stats */}
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-surface-800 border border-surface-700 rounded-xl text-surface-300">
              <Activity className="w-3 h-3" /> {todayRuns.length} runs today
            </span>
            {history.length > 0 && (
              <span className={cn('flex items-center gap-1.5 text-xs px-2.5 py-1 border rounded-xl',
                successRate >= 80 ? 'bg-success/10 border-success/20 text-success' : 'bg-warning/10 border-warning/20 text-warning')}>
                <CheckCircle2 className="w-3 h-3" /> {successRate}% success
              </span>
            )}
            {avgDuration > 0 && (
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-brand-500/10 border border-brand-500/20 rounded-xl text-brand-400">
                <Clock className="w-3 h-3" /> {avgDuration}s avg
              </span>
            )}
          </div>
          {k8sLive
            ? <span className="flex items-center gap-1 px-2.5 py-1 bg-success/10 border border-success/20 rounded-xl text-xs text-success"><Wifi className="w-3 h-3" /> Live K8s</span>
            : <span className="flex items-center gap-1 px-2.5 py-1 bg-surface-800 border border-surface-700 rounded-xl text-xs text-surface-400"><WifiOff className="w-3 h-3" /> K8s offline</span>
          }
          {/* Auto-trigger master switch */}
          <button
            onClick={async () => { const next = !autoEnabled; setAutoEnabled(next); await saveAutoConfig(next, autoAllowed) }}
            className={cn('flex items-center gap-1.5 px-2.5 py-1 border rounded-xl text-xs transition-all',
              autoEnabled
                ? 'bg-brand-500/15 border-brand-500/30 text-brand-400'
                : 'bg-surface-800 border-surface-700 text-surface-500 hover:text-surface-300')}
            title={autoEnabled ? 'Auto-trigger ON — click to disable' : 'Auto-trigger OFF — click to enable'}>
            <Zap className="w-3 h-3" />
            Auto-trigger {autoEnabled ? 'ON' : 'OFF'}
            {autoSaved && <CheckCircle2 className="w-3 h-3 text-success ml-0.5" />}
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">

        {/* ── Left sidebar: Runbook list ── */}
        <div className={`${mobilePanel === 'list' ? 'flex' : 'hidden'} md:flex w-full md:w-64 flex-shrink-0 border-r border-surface-800 flex-col`}>
          {/* Search */}
          <div className="p-3 border-b border-surface-800">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-500" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search runbooks…"
                className="w-full bg-surface-900 border border-surface-700 rounded-xl pl-7 pr-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 transition-colors" />
            </div>
          </div>
          {/* Category filter */}
          <div className="flex gap-1 px-3 py-2 border-b border-surface-800 flex-wrap">
            {categories.map(cat => (
              <button key={cat} onClick={() => setCatFilter(cat)}
                className={cn('px-2 py-0.5 rounded-lg text-2xs font-medium transition-all',
                  catFilter === cat ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30' : 'text-surface-500 hover:text-surface-300')}>
                {cat}
              </button>
            ))}
          </div>
          {/* New runbook button */}
          <div className="px-3 py-2 border-b border-surface-800">
            <button onClick={openNew}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 rounded-xl text-xs font-medium text-brand-400 transition-all">
              <Plus className="w-3.5 h-3.5" /> New Runbook
            </button>
          </div>
          {/* Runbook list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filtered.map(rb => {
              const Icon = rb.icon
              const lastRun = history.find(h => h.runbookId === rb.id)
              return (
                <button key={rb.id} onClick={() => setActiveId(rb.id)}
                  className={cn('w-full text-left px-3 py-2.5 rounded-xl border transition-all',
                    activeId === rb.id
                      ? 'bg-brand-500/10 border-brand-500/30'
                      : 'bg-surface-900 border-surface-800 hover:border-surface-700 hover:bg-surface-800/50')}>
                  <div className="flex items-start gap-2">
                    <Icon className={cn('w-3.5 h-3.5 mt-0.5 flex-shrink-0',
                      activeId === rb.id ? 'text-brand-400' : 'text-surface-500')} />
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-xs font-medium leading-tight',
                        activeId === rb.id ? 'text-brand-300' : 'text-white')}>
                        {rb.name}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className={cn('text-2xs px-1.5 py-0.5 rounded border capitalize',
                          SEVERITY_STYLE[rb.severity])}>
                          {rb.severity}
                        </span>
                        <span className="text-2xs text-surface-500">{rb.category}</span>
                        {lastRun && (
                          <span className={cn('w-1.5 h-1.5 rounded-full ml-auto',
                            lastRun.status === 'success' ? 'bg-success' :
                            lastRun.status === 'warning' ? 'bg-warning' : 'bg-danger')} />
                        )}
                      </div>
                      {/* Per-runbook auto-trigger lock/unlock */}
                      {autoEnabled && (
                        <button
                          onClick={async e => {
                            e.stopPropagation()
                            const next = { ...autoAllowed, [rb.id]: !(autoAllowed[rb.id] ?? false) }
                            setAutoAllowed(next)
                            await saveAutoConfig(autoEnabled, next)
                          }}
                          className={cn('mt-1.5 flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded-lg border transition-all',
                            (autoAllowed[rb.id] ?? false)
                              ? 'bg-brand-500/10 border-brand-500/30 text-brand-400'
                              : 'bg-surface-800 border-surface-700 text-surface-600 hover:text-surface-400')}
                          title={(autoAllowed[rb.id] ?? false) ? 'Auto-run enabled — click to lock' : 'Auto-run locked — click to unlock'}>
                          {(autoAllowed[rb.id] ?? false)
                            ? <><Zap className="w-2.5 h-2.5" /> auto</>
                            : <><Lock className="w-2.5 h-2.5" /> locked</>}
                        </button>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Center: Runbook detail ── */}
        <div className={`${mobilePanel === 'detail' ? 'flex' : 'hidden'} md:flex flex-1 flex-col min-w-0 border-r border-surface-800`}>
          {/* Runbook header */}
          <div className="px-5 py-4 border-b border-surface-800 flex-shrink-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <h2 className="text-base font-bold text-white">{active.name}</h2>
                  <span className={cn('text-2xs px-2 py-0.5 rounded-full border font-medium capitalize', SEVERITY_STYLE[active.severity])}>
                    {active.severity}
                  </span>
                  <span className="text-2xs px-2 py-0.5 rounded-full bg-surface-800 border border-surface-700 text-surface-400">
                    {active.category}
                  </span>
                  <span className="flex items-center gap-1 text-2xs text-surface-500">
                    <Clock className="w-3 h-3" /> ~{active.estimatedSecs}s
                  </span>
                  {isCustom && (
                    <span className="text-2xs px-2 py-0.5 rounded-full bg-warning/10 border border-warning/20 text-warning" title="Custom runbooks display steps but execute using the selected step types only">
                      custom
                    </span>
                  )}
                </div>
                <p className="text-xs text-surface-400 max-w-xl">{active.description}</p>
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  {active.tags.map(t => (
                    <span key={t} className="text-2xs px-1.5 py-0.5 bg-surface-800 border border-surface-700 rounded text-surface-500">
                      #{t}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={() => openEdit(active)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border bg-surface-800 hover:bg-surface-700 border-surface-700 text-surface-300 hover:text-white transition-all">
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
                {isCustom && (
                  <button onClick={() => deleteRunbook(active.id)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border bg-danger/5 hover:bg-danger/15 border-danger/20 text-danger transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={executeRunbook}
                  disabled={running || (active.needsTarget && !target) || (active.needsNode && !extraParams['node']?.trim())}
                  title={isCustom ? 'Custom runbooks run their defined steps but use a default executor' : undefined}
                  className={cn('flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition-all',
                    running
                      ? 'bg-brand-500/10 border-brand-500/30 text-brand-400'
                      : (active.needsTarget && !target) || (active.needsNode && !extraParams['node']?.trim())
                      ? 'bg-surface-800 border-surface-700 text-surface-500 cursor-not-allowed'
                      : 'bg-success/10 hover:bg-success/20 border-success/30 text-success')}>
                  {running
                    ? <><RefreshCw className="w-4 h-4 animate-spin" /> Running…</>
                    : <><Play className="w-4 h-4" /> Run Now</>
                  }
                </button>
              </div>
            </div>
          </div>

          {/* Step pipeline */}
          <div className="px-5 py-4 border-b border-surface-800 flex-shrink-0 bg-surface-950">
            <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider mb-3">Execution Pipeline</p>
            <StepPipeline
              steps={active.steps}
              execSteps={result?.runbookId === active.id ? (result.steps as ExecStep[]) : []}
              running={running}
            />
          </div>

          {/* Param form */}
          <div className="px-5 py-4 border-b border-surface-800 flex-shrink-0">
            <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider mb-3">Parameters</p>
            <div className="flex items-end gap-3 flex-wrap">
              {/* Namespace */}
              <div className="flex flex-col gap-1">
                <label className="text-2xs text-surface-500">Namespace</label>
                <select value={namespace} onChange={e => setNamespace(e.target.value)}
                  className="bg-surface-900 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white outline-none focus:border-brand-500 transition-colors min-w-32">
                  {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                </select>
              </div>
              {/* Target deployment */}
              {active.needsTarget && (
                <div className="flex flex-col gap-1">
                  <label className="text-2xs text-surface-500">
                    Deployment {active.needsTarget && <span className="text-danger">*</span>}
                  </label>
                  {deployments.length > 0 ? (
                    <select value={target} onChange={e => setTarget(e.target.value)}
                      className="bg-surface-900 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white outline-none focus:border-brand-500 transition-colors min-w-40">
                      <option value="">Select deployment…</option>
                      {deployments.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  ) : (
                    <input value={target} onChange={e => setTarget(e.target.value)}
                      placeholder="deployment-name"
                      className="bg-surface-900 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 transition-colors w-44" />
                  )}
                </div>
              )}
              {/* Extra params */}
              {(active.extraParams ?? []).map(p => (
                <div key={p.key} className="flex flex-col gap-1">
                  <label className="text-2xs text-surface-500">{p.label}</label>
                  <input
                    value={extraParams[p.key] ?? ''}
                    onChange={e => setExtraParams(prev => ({ ...prev, [p.key]: e.target.value }))}
                    placeholder={p.placeholder}
                    className="bg-surface-900 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 transition-colors w-36" />
                </div>
              ))}
            </div>
          </div>

          {/* Step detail strip */}
          <div className="px-5 py-3 overflow-x-auto flex-shrink-0" style={{ scrollbarWidth: 'thin', scrollbarColor: '#334155 #0f172a' }}>
            <div className="flex items-center gap-2">
              {active.steps.map((step, i) => {
                const TYPE_CLR: Record<string, string> = { check: 'text-cyan-400', remediate: 'text-success', report: 'text-brand-400' }
                return (
                  <div key={step.name} className="flex items-center gap-2 flex-shrink-0">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-900 border border-surface-800 rounded-xl">
                      <span className={cn('text-2xs font-bold uppercase', TYPE_CLR[step.type])}>{step.type}</span>
                      <span className="text-xs text-surface-300">{step.name}</span>
                    </div>
                    {i < active.steps.length - 1 && <ChevronRight className="w-3 h-3 text-surface-600 flex-shrink-0" />}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ── Right panel: Output + History ── */}
        <div className={`${mobilePanel === 'output' ? 'flex' : 'hidden'} md:flex w-full md:w-72 lg:w-80 flex-shrink-0 flex-col`}>
          {/* Tab bar */}
          <div className="flex border-b border-surface-800 flex-shrink-0">
            {(['output', 'history'] as const).map(tab => (
              <button key={tab} onClick={() => setRightTab(tab)}
                className={cn('flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-medium border-b-2 transition-all capitalize',
                  rightTab === tab ? 'border-brand-500 text-brand-400' : 'border-transparent text-surface-500 hover:text-surface-300')}>
                {tab === 'output' ? <Terminal className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                {tab}
                {tab === 'history' && history.length > 0 && (
                  <span className="px-1.5 py-0.5 bg-surface-800 rounded-full text-2xs text-surface-400">{history.length}</span>
                )}
              </button>
            ))}
          </div>

          {/* Output tab */}
          {rightTab === 'output' && (
            <div className="flex-1 overflow-y-auto">
              {!result && !running && (
                <div className="flex flex-col items-center justify-center h-full text-center p-6">
                  <Terminal className="w-10 h-10 text-surface-700 mb-3" />
                  <p className="text-surface-400 text-sm font-medium">No output yet</p>
                  <p className="text-surface-600 text-xs mt-1">Configure parameters and click Run Now</p>
                </div>
              )}
              {running && !result && (
                <div className="flex flex-col items-center justify-center h-full gap-3">
                  <RefreshCw className="w-8 h-8 text-brand-400 animate-spin" />
                  <p className="text-brand-400 text-sm font-medium">Executing {active.name}…</p>
                  <p className="text-surface-500 text-xs">{namespace}{target ? ` / ${target}` : ''}</p>
                </div>
              )}
              {result && (
                <div className="p-4 space-y-3">
                  {/* Result header */}
                  <div className={cn('flex items-center justify-between px-3 py-2 rounded-xl border',
                    result.status === 'success' ? 'bg-success/5 border-success/20' :
                    result.status === 'warning' ? 'bg-warning/5 border-warning/20' :
                                                   'bg-danger/5 border-danger/20')}>
                    <div className="flex items-center gap-2">
                      {result.status === 'success' ? <CheckCircle2 className="w-4 h-4 text-success" /> :
                       result.status === 'warning'  ? <AlertTriangle className="w-4 h-4 text-warning" /> :
                                                      <XCircle className="w-4 h-4 text-danger" />}
                      <span className={cn('text-sm font-semibold capitalize',
                        result.status === 'success' ? 'text-success' :
                        result.status === 'warning' ? 'text-warning' : 'text-danger')}>
                        {result.status === 'success' ? 'Completed' : result.status === 'warning' ? 'Completed with warnings' : 'Failed'}
                      </span>
                    </div>
                    <span className="text-2xs text-surface-500 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {(result.duration / 1000).toFixed(1)}s
                    </span>
                  </div>

                  {/* Step outputs */}
                  <AnimatePresence>
                    {result.steps.map((step, i) => (
                      <motion.div key={i}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05 }}
                        className="rounded-xl border border-surface-800 bg-surface-900 overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-800">
                          {STEP_STATUS_ICON[step.status as StepStatus]}
                          <span className="text-xs font-medium text-white">{step.name}</span>
                          <span className={cn('ml-auto text-2xs px-1.5 py-0.5 rounded font-medium uppercase',
                            step.status === 'ok'    ? 'bg-success/10 text-success' :
                            step.status === 'warn'  ? 'bg-warning/10 text-warning' :
                            step.status === 'error' ? 'bg-danger/10  text-danger' :
                                                      'bg-brand-500/10 text-brand-400')}>
                            {step.status}
                          </span>
                          <button
                            onClick={() => navigator.clipboard.writeText(step.output).catch(() => {})}
                            className="ml-1 p-1 rounded hover:bg-surface-700 text-surface-600 hover:text-surface-300 transition-colors"
                            title="Copy output">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          </button>
                        </div>
                        <pre className="px-3 py-2.5 text-2xs font-mono text-surface-300 whitespace-pre-wrap leading-relaxed overflow-x-auto">
                          {step.output}
                        </pre>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          )}

          {/* History tab */}
          {rightTab === 'history' && (
            <div className="flex flex-col flex-1 min-h-0">
              {/* History header */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-surface-800 flex-shrink-0">
                <span className="text-2xs text-surface-500">
                  {history.length} run{history.length !== 1 ? 's' : ''} stored
                </span>
                {history.length > 0 && (
                  <button
                    onClick={clearHistory}
                    className="flex items-center gap-1 text-2xs text-surface-500 hover:text-danger transition-colors px-2 py-1 rounded-lg hover:bg-danger/10"
                    title="Clear all run history"
                  >
                    <Trash2 className="w-3 h-3" /> Clear all
                  </button>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {history.length === 0 && (
                <div className="flex flex-col items-center justify-center h-40 text-center">
                  <Clock className="w-8 h-8 text-surface-700 mb-2" />
                  <p className="text-surface-500 text-sm">No runs yet</p>
                </div>
              )}
              {history.map(run => {
                const rb = runbooks.find(r => r.id === run.runbookId)
                const Icon = rb?.icon ?? Workflow
                return (
                  <button key={run.id}
                    onClick={() => { setActiveId(run.runbookId); setResult(run); setRightTab('output') }}
                    className="w-full text-left px-3 py-2.5 bg-surface-900 hover:bg-surface-800 border border-surface-800 rounded-xl transition-all group">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="w-3.5 h-3.5 text-surface-400" />
                      <span className="text-xs font-medium text-white truncate flex-1">{rb?.name ?? run.runbookId}</span>
                      {(run as any).triggeredBy === 'incident' && (
                        <span className="text-2xs px-1.5 py-0.5 rounded bg-brand-500/15 text-brand-400 border border-brand-500/20 flex-shrink-0">auto</span>
                      )}
                      <span className={cn('w-2 h-2 rounded-full flex-shrink-0',
                        run.status === 'success' ? 'bg-success' :
                        run.status === 'warning' ? 'bg-warning' : 'bg-danger')} />
                      <button
                        onClick={e => deleteRun(run.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-danger/10 text-surface-600 hover:text-danger transition-all"
                        title="Remove this run"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-2xs text-surface-500">
                      <span>{run.namespace}</span>
                      {run.target && <><span>·</span><span>{run.target}</span></>}
                      {(run as any).incidentId && <span className="text-brand-500/60">· {(run as any).incidentId}</span>}
                      <span className="ml-auto flex items-center gap-0.5">
                        <Clock className="w-2.5 h-2.5" /> {(run.duration / 1000).toFixed(1)}s
                      </span>
                    </div>
                    <p className="text-2xs text-surface-600 mt-0.5">
                      {new Date(run.runAt).toLocaleString()}
                    </p>
                  </button>
                )
              })}
              </div>
            </div>
          )}
        </div>

      </div>

      {/* Mobile bottom nav */}
      <div className="md:hidden flex border-t border-surface-800 flex-shrink-0">
        {([
          { id: 'list',   label: 'Runbooks', icon: List },
          { id: 'detail', label: 'Detail',   icon: Play },
          { id: 'output', label: 'Output',   icon: Terminal },
        ] as { id: 'list' | 'detail' | 'output'; label: string; icon: any }[]).map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setMobilePanel(id)}
            className={cn('flex-1 flex flex-col items-center gap-1 py-2.5 text-2xs font-medium transition-all',
              mobilePanel === id ? 'text-brand-400 bg-brand-500/5' : 'text-surface-500 hover:text-surface-300')}>
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>
    </div>

    {/* ── Runbook editor modal ── */}
    <AnimatePresence>
      {editorOpen && (
        <RunbookEditorModal
          initial={editTarget}
          onSave={saveRunbook}
          onClose={closeEditor}
        />
      )}
    </AnimatePresence>
    </>
  )
}


interface WorkflowNode {
  id: string
  type: 'trigger' | 'condition' | 'action' | 'notify'
  label: string
  description: string
  x: number
  y: number
}

interface WorkflowEdge {
  from: string
  to: string
  label?: string
}

const NODE_ICONS = {
  trigger: Zap,
  condition: GitMerge,
  action: RotateCcw,
  notify: Bell,
}

const NODE_COLORS = {
  trigger:   { bg: 'bg-brand-500/10', border: 'border-brand-500/40', text: 'text-brand-400' },
  condition: { bg: 'bg-warning/10',   border: 'border-warning/30',   text: 'text-warning' },
  action:    { bg: 'bg-success/10',   border: 'border-success/30',   text: 'text-success' },
  notify:    { bg: 'bg-purple-500/10', border: 'border-purple-500/30', text: 'text-purple-400' },
}

const TEMPLATES = [
  {
    id: 'restart-oom',
    name: 'Auto-Restart OOMKilled Pods',
    description: 'Detect OOMKilled pods, increase memory limit, restart',
    nodes: [
      { id: 'n1', type: 'trigger' as const,   label: 'OOMKilled Alert',        description: 'Fires when pod OOMKilled',             x: 80,  y: 80 },
      { id: 'n2', type: 'condition' as const, label: 'Restart count < 5?',     description: 'Avoid infinite restart loop',          x: 280, y: 80 },
      { id: 'n3', type: 'action' as const,    label: 'Increase Memory Limit',  description: 'Patch deployment +256Mi',              x: 480, y: 40 },
      { id: 'n4', type: 'action' as const,    label: 'Restart Pod',            description: 'kubectl rollout restart',              x: 480, y: 140 },
      { id: 'n5', type: 'notify' as const,    label: 'Notify Slack',           description: '#incidents channel',                  x: 680, y: 90 },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3', label: 'Yes' },
      { from: 'n2', to: 'n4', label: 'No' },
      { from: 'n3', to: 'n5' },
      { from: 'n4', to: 'n5' },
    ],
  },
  {
    id: 'rollback',
    name: 'Auto-Rollback on Error Spike',
    description: 'Rollback deployment if error rate > 5% for 2 minutes',
    nodes: [
      { id: 'n1', type: 'trigger' as const,   label: 'Error Rate > 5%',        description: 'Prometheus alert fires',               x: 80,  y: 80 },
      { id: 'n2', type: 'condition' as const, label: 'Duration > 2min?',       description: 'Wait to avoid flapping',               x: 280, y: 80 },
      { id: 'n3', type: 'action' as const,    label: 'Rollback Deployment',    description: 'kubectl rollout undo',                 x: 480, y: 60 },
      { id: 'n4', type: 'notify' as const,    label: 'Page On-Call',           description: 'PagerDuty + Slack alert',             x: 680, y: 80 },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3', label: 'Yes' },
      { from: 'n3', to: 'n4' },
    ],
  },
  {
    id: 'scale',
    name: 'Auto-Scale on High CPU',
    description: 'Scale deployment when CPU > 80% for 5 minutes',
    nodes: [
      { id: 'n1', type: 'trigger' as const,   label: 'CPU Alert',              description: 'CPU > 80% for 5 min',                 x: 80,  y: 80 },
      { id: 'n2', type: 'condition' as const, label: 'Max replicas reached?',  description: 'Check HPA limits',                    x: 280, y: 80 },
      { id: 'n3', type: 'action' as const,    label: 'Scale +2 Replicas',      description: 'kubectl scale --replicas=+2',          x: 480, y: 60 },
      { id: 'n4', type: 'notify' as const,    label: 'Notify Team',            description: 'Slack: scaling event',                x: 680, y: 80 },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3', label: 'No' },
      { from: 'n3', to: 'n4' },
    ],
  },
]

function WorkflowCanvas({ nodes, edges }: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) {
  return (
    <svg width="100%" height="100%" viewBox="0 0 820 260" className="select-none">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill="#475569" />
        </marker>
      </defs>
      <rect width="820" height="260" fill="#020617" />
      {/* Edges */}
      {edges.map((e, i) => {
        const src = nodes.find(n => n.id === e.from)
        const tgt = nodes.find(n => n.id === e.to)
        if (!src || !tgt) return null
        const x1 = src.x + 90, y1 = src.y + 24, x2 = tgt.x, y2 = tgt.y + 24
        const mx = (x1 + x2) / 2
        return (
          <g key={i}>
            <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="#334155" strokeWidth="1.5" markerEnd="url(#arrow)" />
            {e.label && (
              <text x={mx} y={(y1 + y2) / 2 - 5} textAnchor="middle" fill="#6b7280" fontSize="9">{e.label}</text>
            )}
          </g>
        )
      })}
      {/* Nodes */}
      {nodes.map(node => {
        const colors = NODE_COLORS[node.type]
        return (
          <g key={node.id} transform={`translate(${node.x},${node.y})`} className="cursor-pointer">
            <rect width="90" height="48" rx="10" ry="10"
              fill="#0f172a" stroke="#334155" strokeWidth="1"
              className="hover:stroke-brand-500 transition-colors"
            />
            <text x="45" y="16" textAnchor="middle" fill="#94a3b8" fontSize="9" fontFamily="Inter">{node.type.toUpperCase()}</text>
            <text x="45" y="30" textAnchor="middle" fill="#f1f5f9" fontSize="10" fontWeight="600" fontFamily="Inter">
              {node.label.length > 12 ? node.label.slice(0, 11) + '…' : node.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
