'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useChat } from 'ai/react'
import type { Message } from 'ai'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bot, Send, Sparkles, Plus, History, AlertTriangle, Cpu, Boxes, DollarSign,
  Shield, WifiOff, Loader2, Copy, Check, Server, Activity, RefreshCw,
  Zap, Terminal, Search, X, ChevronRight, Database, Brain, TrendingUp,
  Wrench, ShieldAlert, GitBranch, PlayCircle, AlertCircle, ChevronDown,
  Lightbulb, Target, Layers, Radar, BellOff, Square,
} from 'lucide-react'
import { useLiveData } from '@/hooks/useLiveData'
import { cn } from '@/lib/utils'
import { getClusterHeaders, useDashboardStore } from '@/store'

// ── Types ─────────────────────────────────────────────────────
interface Conversation { id: string; title: string; ts: string; messages: Message[]; mode: ModeKey }
type ModeKey = 'investigate' | 'predict' | 'optimize' | 'remediate' | 'chat'

interface Insight {
  id: string; kind: 'prediction' | 'rca' | 'optimization' | 'security' | 'autonomous'
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string; summary: string; confidence: number
  evidence: string[]; suggestedAction?: string; suggestedPrompt: string; metric?: string
}

// ── Constants ─────────────────────────────────────────────────
const STORAGE_KEY = 'vynops_conversations_v2'

const MODES: Record<ModeKey, { label: string; icon: any; color: string; sysHint: string; prompts: string[] }> = {
  investigate: {
    label: 'Investigate', icon: Search, color: 'text-brand-400',
    sysHint: 'Diagnose live incidents with causal RCA',
    prompts: [
      'What is wrong with my cluster right now?',
      'Run multi-layer correlation on the most critical alert',
      'Show blast radius of the worst-affected service',
      'Find all failing pods and explain why',
      'Correlate recent warning events and identify the root cause',
    ],
  },
  predict: {
    label: 'Predict', icon: TrendingUp, color: 'text-purple-400',
    sysHint: 'Forecast failures, capacity exhaustion, SLA breaches',
    prompts: [
      'Predict which workloads are likely to fail in the next hour',
      'Forecast cluster CPU and memory exhaustion',
      'Which services are at risk of breaching SLA?',
      'Detect memory leaks across the cluster',
      'When will my disk capacity run out?',
    ],
  },
  optimize: {
    label: 'Optimize', icon: Lightbulb, color: 'text-warning',
    sysHint: 'Cost, scaling, and security recommendations',
    prompts: [
      'Find over-provisioned workloads and quantify savings',
      'Where should I install HPAs?',
      'Scan the cluster for security misconfigurations',
      'Right-size all deployments in the default namespace',
      'Recommend cost optimizations with exact YAML changes',
    ],
  },
  remediate: {
    label: 'Remediate', icon: Wrench, color: 'text-success',
    sysHint: 'Generate and execute approved fixes',
    prompts: [
      'Generate an autonomous workflow for the current incident',
      'Restart all crash-looping deployments (dry-run first)',
      'Diagnose CrashLoopBackOff in default namespace and fix it',
      'Generate a runbook for OOMKilled pods',
      'Scale payment-api to handle 2x current load',
    ],
  },
  chat: {
    label: 'Free Chat', icon: Sparkles, color: 'text-surface-300',
    sysHint: 'Open-ended questions and reasoning',
    prompts: [
      'Explain SLO error budgets',
      'How do I debug a slow Kubernetes Service?',
      'What is the difference between requests and limits?',
      'Best practices for Prometheus alerting?',
    ],
  },
}

const INITIAL_MESSAGES: Message[] = [
  {
    id: 'init-1',
    role: 'assistant',
    content: `**VynOps AI online.** Real-time SRE copilot with causal reasoning, predictive analytics, and autonomous remediation.

**Capabilities:**
- **Investigate** — multi-layer RCA (L7→L1), blast-radius analysis, live event correlation
- **Predict** — failure forecasting, capacity planning, SLA-breach detection
- **Optimize** — cost right-sizing, HPA recommendations, security scanning
- **Remediate** — auto-generated playbooks with approval gates

Pick a mode above, tap an insight card, or ask me anything.`,
  },
]

// ── Markdown renderer ─────────────────────────────────────────
function MarkdownContent({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0
  let k = 0  // dedicated key counter — never shares values between elements

  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) { codeLines.push(lines[i]!); i++ }
      elements.push(
        <div key={k++} className="my-2 rounded-xl overflow-hidden border border-surface-700">
          {lang && (
            <div className="flex items-center justify-between px-3 py-1.5 bg-surface-700/50 border-b border-surface-700">
              <span className="text-2xs font-mono text-surface-400">{lang}</span>
            </div>
          )}
          <pre className="px-4 py-3 bg-surface-950 text-xs font-mono text-brand-200 overflow-x-auto leading-relaxed whitespace-pre">{codeLines.join('\n')}</pre>
        </div>,
      )
      i++; continue
    }
    if (line.startsWith('### ')) { elements.push(<p key={k++} className="text-xs font-bold text-white mt-3 mb-1">{inline(line.slice(4))}</p>); i++; continue }
    if (line.startsWith('## '))  { elements.push(<p key={k++} className="text-sm font-bold text-white mt-3 mb-1">{inline(line.slice(3))}</p>); i++; continue }
    if (line.startsWith('# '))   { elements.push(<p key={k++} className="text-sm font-extrabold text-white mt-3 mb-1">{inline(line.slice(2))}</p>); i++; continue }
    if (line.match(/^[-*] /)) {
      const items: string[] = []
      while (i < lines.length && lines[i]!.match(/^[-*] /)) { items.push(lines[i]!.slice(2)); i++ }
      elements.push(
        <ul key={k++} className="my-1.5 space-y-0.5 pl-2">
          {items.map((item, j) => (
            <li key={j} className="flex gap-2 text-sm leading-relaxed">
              <span className="text-brand-400 flex-shrink-0 mt-[3px]">›</span>
              <span>{inline(item)}</span>
            </li>
          ))}
        </ul>,
      )
      continue
    }
    if (line.match(/^\d+\. /)) {
      const items: string[] = []
      while (i < lines.length && lines[i]!.match(/^\d+\. /)) { items.push(lines[i]!.replace(/^\d+\. /, '')); i++ }
      elements.push(
        <ol key={k++} className="my-1.5 space-y-0.5 pl-2 list-none">
          {items.map((item, j) => (
            <li key={j} className="flex gap-2 text-sm leading-relaxed">
              <span className="text-brand-400 font-mono text-xs flex-shrink-0 mt-0.5 w-4">{j + 1}.</span>
              <span>{inline(item)}</span>
            </li>
          ))}
        </ol>,
      )
      continue
    }
    if (line.startsWith('> ')) {
      elements.push(<div key={k++} className="my-1.5 pl-3 border-l-2 border-brand-500/40 text-surface-400 text-sm italic">{inline(line.slice(2))}</div>)
      i++; continue
    }
    if (line.match(/^---+$/)) { elements.push(<hr key={k++} className="my-2 border-surface-700" />); i++; continue }
    if (line.trim() === '')   { elements.push(<div key={k++} className="h-1" />); i++; continue }
    elements.push(<p key={k++} className="text-sm leading-relaxed">{inline(line)}</p>)
    i++
  }
  return <div className="space-y-0.5">{elements}</div>
}

function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[LIVE\]|\[UNAVAILABLE\])/g)
  return parts.map((part, i) => {
    if (part === '[LIVE]')        return <span key={i} className="inline-flex items-center gap-1 text-2xs font-bold text-success bg-success/10 px-1.5 py-0.5 rounded">LIVE</span>
    if (part === '[UNAVAILABLE]') return <span key={i} className="inline-flex items-center gap-1 text-2xs font-bold text-danger bg-danger/10 px-1.5 py-0.5 rounded">UNAVAILABLE</span>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} className="font-semibold text-white">{part.slice(2, -2)}</strong>
    if (part.startsWith('*')  && part.endsWith('*'))  return <em key={i} className="italic text-surface-300">{part.slice(1, -1)}</em>
    if (part.startsWith('`')  && part.endsWith('`'))  return <code key={i} className="font-mono text-brand-300 bg-surface-900/80 px-1.5 py-0.5 rounded text-xs">{part.slice(1, -1)}</code>
    return part
  })
}

// ── Tool registry ─────────────────────────────────────────────
const TOOL_META: Record<string, { label: string; icon: any; group: string }> = {
  get_cluster_health:        { label: 'Cluster health',     icon: Server,        group: 'Investigate' },
  get_pod_status:            { label: 'Pod status',         icon: Boxes,         group: 'Investigate' },
  get_node_status:           { label: 'Node status',        icon: Cpu,           group: 'Investigate' },
  get_incidents:             { label: 'Incidents',          icon: AlertTriangle, group: 'Investigate' },
  get_alerts:                { label: 'Alerts',             icon: Zap,           group: 'Investigate' },
  get_events:                { label: 'K8s events',         icon: Activity,      group: 'Investigate' },
  get_service_metrics:       { label: 'Service metrics',    icon: Activity,      group: 'Investigate' },
  run_prometheus_query:      { label: 'PromQL',             icon: Database,      group: 'Investigate' },
  suggest_remediation:       { label: 'Remediation plan',   icon: Terminal,      group: 'Remediate' },
  correlate_pod_issue:       { label: 'Pod correlation',    icon: Search,        group: 'RCA' },
  predict_failures:          { label: 'Failure prediction', icon: Brain,         group: 'Predict' },
  forecast_capacity:         { label: 'Capacity forecast',  icon: TrendingUp,    group: 'Predict' },
  predict_sla_breach:        { label: 'SLA prediction',     icon: Target,        group: 'Predict' },
  analyze_blast_radius:      { label: 'Blast radius',       icon: Radar,         group: 'RCA' },
  multi_layer_correlate:     { label: 'Multi-layer RCA',    icon: Layers,        group: 'RCA' },
  recommend_cost_optimization: { label: 'Cost optimization', icon: DollarSign,   group: 'Optimize' },
  recommend_scaling:         { label: 'Scaling',            icon: GitBranch,     group: 'Optimize' },
  recommend_security:        { label: 'Security scan',      icon: ShieldAlert,   group: 'Optimize' },
  execute_remediation:       { label: 'Execute',            icon: PlayCircle,    group: 'Autonomous' },
  generate_workflow:         { label: 'Workflow',           icon: GitBranch,     group: 'Autonomous' },
  silence_alert:             { label: 'Silence alert',      icon: BellOff,       group: 'Remediate'  },
}

// ── Workflow step execution card ──────────────────────────────
function WorkflowStepCard({ step, dryRun = false }: { step: any; dryRun?: boolean }) {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [output, setOutput]  = useState<string | null>(null)

  const executeStep = async () => {
    setStatus('running')
    try {
      const cmd  = step.command ?? ''
      const restartM = cmd.match(/kubectl rollout restart deployment\/(\S+)\s+-n\s+(\S+)/)
      const scaleM   = cmd.match(/kubectl scale deployment\/(\S+)\s+--replicas=(\d+)\s+-n\s+(\S+)/)
      const deleteM  = cmd.match(/kubectl delete pod\s+(\S+)\s+-n\s+(\S+)/)
      let body: any
      if      (restartM) body = { action: 'restart_deployment', name: restartM[1], namespace: restartM[2] }
      else if (scaleM)   body = { action: 'scale_deployment',   name: scaleM[1],   replicas: parseInt(scaleM[2]), namespace: scaleM[3] }
      else if (deleteM)  body = { action: 'delete_pod',         name: deleteM[1],  namespace: deleteM[2] }
      else { setStatus('done'); setOutput(dryRun ? '[dry-run] Read-only step — would run in terminal' : 'Read-only — run in terminal to see output'); return }
      if (dryRun) { setStatus('done'); setOutput(`[dry-run] Would execute: ${body.action} on ${body.name} in ${body.namespace}`); return }
      const r    = await fetch('/api/k8s/remediate', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getClusterHeaders() }, body: JSON.stringify(body) })
      const data = await r.json()
      if (r.ok && data.status !== 'failed') { setStatus('done'); setOutput(data.message ?? 'Executed successfully') }
      else { setStatus('error'); setOutput(data.error ?? 'Execution failed') }
    } catch (e: any) { setStatus('error'); setOutput(e.message) }
  }

  const isExecutable = /kubectl\s+(rollout|scale|delete)/.test(step.command ?? '')

  return (
    <div className={cn('rounded-xl border px-3 py-2 transition-all',
      status === 'done'    ? 'bg-success/5 border-success/30' :
      status === 'error'   ? 'bg-danger/5 border-danger/30' :
      status === 'running' ? 'bg-brand-500/5 border-brand-500/30' :
      'bg-surface-900/50 border-surface-700'
    )}>
      <div className="flex items-center gap-2">
        <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center">
          {status === 'idle'    && <div className="w-3 h-3 rounded-full border border-surface-500" />}
          {status === 'running' && <Loader2 className="w-3.5 h-3.5 text-brand-400 animate-spin" />}
          {status === 'done'    && <Check className="w-3.5 h-3.5 text-success" />}
          {status === 'error'   && <AlertCircle className="w-3.5 h-3.5 text-danger" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-white font-medium">{step.action}</span>
            {step.risk !== 'none' && (
              <span className={cn('text-2xs font-bold px-1.5 py-0.5 rounded flex-shrink-0',
                step.risk === 'high' ? 'text-danger bg-danger/10' : step.risk === 'medium' ? 'text-warning bg-warning/10' : 'text-success bg-success/10'
              )}>{step.risk} risk</span>
            )}
            {isExecutable && status === 'idle' && (
              <button onClick={executeStep}
                className={cn('ml-auto flex items-center gap-1 px-2.5 py-1 text-2xs font-bold border rounded-lg transition-all flex-shrink-0',
                  dryRun
                    ? 'bg-surface-700/50 hover:bg-surface-700 text-surface-400 border-surface-600'
                    : 'bg-success/10 hover:bg-success/20 text-success border-success/30'
                )}>
                <PlayCircle className="w-2.5 h-2.5" />
                {dryRun ? 'Dry-run' : 'Execute'}
              </button>
            )}
          </div>
          <code className="text-2xs font-mono text-brand-300 leading-relaxed block mt-0.5 truncate">{step.command}</code>
          {output && <p className="text-2xs text-surface-400 mt-0.5">{output}</p>}
        </div>
        <button onClick={() => navigator.clipboard.writeText(step.command ?? '')}
          className="p-1 rounded hover:bg-surface-700 text-surface-500 hover:text-white flex-shrink-0">
          <Copy className="w-2.5 h-2.5" />
        </button>
      </div>
    </div>
  )
}

// ── GenerateWorkflow result (extracted to comply with Rules of Hooks) ────────
function GenerateWorkflowResult({ result }: { result: any }) {
  const [dryRun, setDryRun] = useState(true)
  const wf = result?.workflow
  if (!wf) return null
  const executableSteps = (wf.steps ?? []).filter((s: any) => /kubectl\s+(rollout|scale|delete)/.test(s.command ?? ''))
  return (
    <div className="space-y-3 mt-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-white">{wf.title}</p>
        <div className="flex items-center gap-1.5">
          <span className={cn('text-2xs font-bold px-2 py-0.5 rounded-full border',
            wf.riskLevel === 'high' ? 'text-danger border-danger/40 bg-danger/10' : wf.riskLevel === 'medium' ? 'text-warning border-warning/40 bg-warning/10' : 'text-success border-success/40 bg-success/10'
          )}>{(wf.riskLevel ?? 'low').toUpperCase()} RISK</span>
          <span className="text-2xs text-surface-500">{wf.estimatedDuration}</span>
        </div>
      </div>
      {executableSteps.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-800/60 border border-surface-700">
          <button onClick={() => setDryRun(d => !d)}
            className={cn('flex items-center gap-1.5 text-2xs font-bold px-2.5 py-1 rounded-lg border transition-all',
              dryRun ? 'bg-warning/10 text-warning border-warning/30' : 'bg-surface-700 text-surface-400 border-surface-600'
            )}>
            <Shield className="w-2.5 h-2.5" />
            {dryRun ? 'Dry-run ON' : 'Dry-run OFF'}
          </button>
          <span className="text-2xs text-surface-500 flex-1">{executableSteps.length} executable step{executableSteps.length !== 1 ? 's' : ''}</span>
          {!dryRun && <span className="text-2xs text-danger font-bold animate-pulse">&#9888; Live mode &mdash; changes will apply</span>}
        </div>
      )}
      {(['Diagnose', 'Remediate', 'Verify', 'Optimize'] as const).map((phase) => {
        const phaseSteps = (wf.steps ?? []).filter((s: any) => s.phase === phase)
        if (!phaseSteps.length) return null
        return (
          <div key={phase}>
            <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider mb-1.5">{phase}</p>
            <div className="space-y-1.5">{phaseSteps.map((s: any) => <WorkflowStepCard key={s.id} step={s} dryRun={dryRun} />)}</div>
          </div>
        )
      })}
      {wf.rollbackPlan && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-900/50 border border-surface-700">
          <span className="text-2xs text-surface-500">Rollback:</span>
          <code className="text-2xs font-mono text-warning flex-1">{wf.rollbackPlan}</code>
          <button onClick={() => navigator.clipboard.writeText(wf.rollbackPlan)} className="p-1 rounded hover:bg-surface-700 text-surface-500 hover:text-white"><Copy className="w-2.5 h-2.5" /></button>
        </div>
      )}
    </div>
  )
}

// ── Rich tool result renderers ────────────────────────────────
function ToolResultContent({ toolName, result }: { toolName: string; result: any }) {
  if (toolName === 'generate_workflow') {
    return <GenerateWorkflowResult result={result} />
  }

  if (toolName === 'multi_layer_correlate') {
    const chain: any[] = result?.causalChain ?? []
    if (!chain.length) return (
      <div className="mt-2 flex items-center gap-2 text-success text-xs"><Check className="w-3.5 h-3.5" /> {result?.rootCause ?? 'No issues detected'}</div>
    )
    return (
      <div className="mt-2 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-2xs text-surface-400">Root: <span className="font-bold text-white">{result?.rootCause}</span></span>
          <span className="text-2xs text-surface-500">Conf: {((result?.confidence ?? 0) * 100).toFixed(0)}%</span>
        </div>
        <div className="space-y-1.5">
          {chain.map((layer: any, i: number) => (
            <div key={i} className={cn('flex gap-2 items-start px-3 py-2 rounded-xl border',
              layer.severity === 'critical' ? 'bg-danger/5 border-danger/30' : layer.severity === 'high' ? 'bg-warning/5 border-warning/30' : 'bg-surface-900/50 border-surface-700'
            )}>
              <div className={cn('flex-shrink-0 mt-0.5 text-2xs font-bold font-mono px-1.5 py-0.5 rounded whitespace-nowrap',
                layer.severity === 'critical' ? 'text-danger bg-danger/10' : layer.severity === 'high' ? 'text-warning bg-warning/10' : 'text-brand-400 bg-brand-500/10'
              )}>{layer.layer}</div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-surface-200 leading-snug">{layer.finding}</p>
                {(layer.resources ?? []).filter(Boolean).slice(0, 3).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {layer.resources.filter(Boolean).slice(0, 3).map((r: string, j: number) => (
                      <span key={j} className="text-2xs font-mono bg-surface-900 border border-surface-700 px-1.5 py-0.5 rounded">{r}</span>
                    ))}
                  </div>
                )}
                <p className="text-2xs text-surface-500 mt-0.5">{layer.causalDirection}</p>
              </div>
              {i === 0 && <span className="text-2xs bg-danger/20 text-danger px-2 py-0.5 rounded-full font-bold flex-shrink-0">ROOT</span>}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (toolName === 'predict_failures') {
    const risks: any[] = result?.risks ?? []
    if (!risks.length) return <div className="mt-2 text-xs text-success flex items-center gap-2"><Check className="w-3.5 h-3.5" />{result?.summary}</div>
    return (
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-2 mb-2">
          {(result?.criticalCount ?? 0) > 0 && <span className="text-2xs font-bold text-danger bg-danger/10 border border-danger/30 px-2 py-0.5 rounded-full">{result.criticalCount} CRITICAL</span>}
          {(result?.highCount ?? 0) > 0 && <span className="text-2xs font-bold text-warning bg-warning/10 border border-warning/30 px-2 py-0.5 rounded-full">{result.highCount} HIGH</span>}
          <span className="text-2xs text-surface-500">window: {result?.analyzedWindow}</span>
        </div>
        {risks.slice(0, 8).map((r: any, i: number) => (
          <div key={i} className={cn('flex items-center gap-2 px-3 py-1.5 rounded-xl border',
            r.severity === 'critical' ? 'bg-danger/5 border-danger/30' : r.severity === 'high' ? 'bg-warning/5 border-warning/30' : 'bg-surface-900/50 border-surface-700'
          )}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5"><span className="text-xs text-white font-mono truncate">{r.workload}</span><span className="text-2xs text-surface-500">{r.namespace}</span></div>
              <div className="text-2xs text-surface-400 mt-0.5">{r.value}</div>
            </div>
            <div className="flex-shrink-0 text-right">
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-16 bg-surface-700 rounded-full overflow-hidden">
                  <div className={cn('h-full rounded-full', r.severity === 'critical' ? 'bg-danger' : r.severity === 'high' ? 'bg-warning' : 'bg-brand-500')} style={{ width: `${((r.probability ?? 0) * 100).toFixed(0)}%` }} />
                </div>
                <span className="text-2xs font-bold text-surface-300 w-8 text-right">{((r.probability ?? 0) * 100).toFixed(0)}%</span>
              </div>
              <div className="text-2xs text-surface-500 capitalize mt-0.5">{(r.riskFactor ?? '').replace(/_/g, ' ')}</div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (toolName === 'recommend_cost_optimization') {
    const opps: any[] = result?.opportunities ?? []
    if (!opps.length) return <div className="mt-2 text-xs text-success flex items-center gap-2"><Check className="w-3.5 h-3.5" />{result?.summary}</div>
    return (
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-success/5 border border-success/30">
          <span className="text-xs font-bold text-white">{result?.totalOpportunities} Savings Opportunities</span>
          <div className="text-right">
            <div className="text-sm font-black text-success">{result?.estimatedMonthlySavings}/mo</div>
            <div className="text-2xs text-surface-400">{result?.estimatedAnnualSavings}/yr</div>
          </div>
        </div>
        {opps.slice(0, 6).map((op: any, i: number) => (
          <div key={i} className="px-3 py-2 rounded-xl bg-surface-900/50 border border-surface-700">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono text-white">{op.workload}</span>
              <span className="text-xs font-bold text-success">{op.estimatedMonthlySavings}/mo</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 text-2xs text-surface-400">
              <span>CPU: {op.currentCpu} → <span className="text-success">{op.recommendedCpu}</span> ({op.cpuUtil} used)</span>
              <span>Mem: {op.currentMem} → <span className="text-success">{op.recommendedMem}</span> ({op.memUtil} used)</span>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (toolName === 'recommend_security') {
    const findings: any[] = result?.findings ?? []
    if (!findings.length) return <div className="mt-2 text-xs text-success flex items-center gap-2"><Check className="w-3.5 h-3.5" />{result?.summary}</div>
    return (
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xs font-bold text-danger bg-danger/10 border border-danger/30 px-2 py-0.5 rounded-full">{result?.critical} CRITICAL</span>
          <span className="text-2xs font-bold text-warning bg-warning/10 border border-warning/30 px-2 py-0.5 rounded-full">{result?.high} HIGH</span>
          <span className="text-2xs font-bold text-brand-400 bg-brand-500/10 border border-brand-500/30 px-2 py-0.5 rounded-full">{result?.medium} MEDIUM</span>
          <span className="text-2xs text-surface-500 ml-auto">Risk: {result?.riskScore}/100</span>
        </div>
        {findings.slice(0, 8).map((f: any, i: number) => (
          <div key={i} className={cn('px-3 py-2 rounded-xl border',
            f.severity === 'critical' ? 'bg-danger/5 border-danger/30' : f.severity === 'high' ? 'bg-warning/5 border-warning/30' : 'bg-surface-900/50 border-surface-700'
          )}>
            <div className="flex items-start gap-2">
              <span className={cn('text-2xs font-bold uppercase flex-shrink-0 mt-0.5 px-1.5 py-0.5 rounded',
                f.severity === 'critical' ? 'text-danger bg-danger/10' : f.severity === 'high' ? 'text-warning bg-warning/10' : 'text-brand-400 bg-brand-500/10'
              )}>{f.severity}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-white">{f.finding}</p>
                <p className="text-2xs text-surface-400 font-mono truncate">{f.resource}</p>
                <p className="text-2xs text-success mt-0.5">→ {f.remediation}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (toolName === 'recommend_scaling') {
    const recs: any[] = result?.recommendations ?? []
    if (!recs.length) return <div className="mt-2 text-xs text-success flex items-center gap-2"><Check className="w-3.5 h-3.5" />{result?.summary}</div>
    return (
      <div className="mt-2 space-y-1.5">
        {(result?.criticalCount ?? 0) > 0 && <div className="text-2xs font-bold text-danger bg-danger/10 border border-danger/30 px-3 py-1.5 rounded-xl">{result.criticalCount} critical — high utilization risks imminent failure</div>}
        {recs.slice(0, 6).map((rec: any, i: number) => (
          <div key={i} className={cn('px-3 py-2 rounded-xl border',
            rec.priority === 'critical' ? 'bg-danger/5 border-danger/30' : rec.priority === 'high' ? 'bg-warning/5 border-warning/30' : 'bg-surface-900/50 border-surface-700'
          )}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono text-white">{rec.workload}</span>
              <span className="text-2xs text-surface-400">{rec.currentReplicas} → <span className="text-white font-bold">{rec.suggestedReplicas}</span> replicas</span>
            </div>
            <div className="text-2xs text-surface-400 mb-1">{rec.cpuUtil ? `CPU: ${rec.cpuUtil}` : ''}{rec.memUtil ? ` · Mem: ${rec.memUtil}` : ''}{rec.reason ?? ''}</div>
            <div className="flex items-center gap-2">
              <code className="text-2xs font-mono text-brand-300 bg-surface-900 px-2 py-0.5 rounded flex-1 truncate">{rec.command}</code>
              <button onClick={() => navigator.clipboard.writeText(rec.command ?? '')} className="p-1 rounded hover:bg-surface-700 text-surface-500 hover:text-white flex-shrink-0"><Copy className="w-2.5 h-2.5" /></button>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (toolName === 'analyze_blast_radius') {
    const br = result?.blastRadius ?? {}
    return (
      <div className="mt-2 space-y-2">
        <div className={cn('flex items-center gap-3 px-3 py-2 rounded-xl border',
          result?.severity === 'critical' ? 'bg-danger/5 border-danger/30' : result?.severity === 'high' ? 'bg-warning/5 border-warning/30' : 'bg-surface-900/50 border-surface-700'
        )}>
          {(['pods', 'services', 'ingresses', 'hpas'] as const).map((key) => (
            <div key={key} className="text-center flex-1">
              <div className={cn('text-lg font-black', (br[key] ?? 0) > 0 ? 'text-danger' : 'text-success')}>{br[key] ?? 0}</div>
              <div className="text-2xs text-surface-500 capitalize">{key}</div>
            </div>
          ))}
        </div>
        {result?.userImpact && <div className="text-xs text-warning px-3 py-2 rounded-xl bg-warning/5 border border-warning/30">{result.userImpact}</div>}
        {(result?.affected?.pods ?? []).slice(0, 4).map((p: any, i: number) => (
          <div key={i} className="flex items-center gap-2 px-2 py-1 rounded bg-surface-900/50 text-xs">
            <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', p.phase === 'Running' ? 'bg-success' : 'bg-danger')} />
            <span className="font-mono text-surface-300 truncate">{p.name}</span>
            <span className="text-surface-500 text-2xs">{p.restarts}r</span>
          </div>
        ))}
      </div>
    )
  }

  if (toolName === 'execute_remediation') {
    return (
      <div className="mt-2">
        <div className={cn('flex items-center gap-2 px-3 py-2 rounded-xl border',
          result?.status === 'executed' ? 'bg-success/5 border-success/30' : result?.status === 'dry_run_success' ? 'bg-brand-500/5 border-brand-500/30' : 'bg-danger/5 border-danger/30'
        )}>
          {result?.status === 'executed'      && <Check       className="w-3.5 h-3.5 text-success flex-shrink-0" />}
          {result?.status === 'dry_run_success' && <Terminal  className="w-3.5 h-3.5 text-brand-400 flex-shrink-0" />}
          {result?.status === 'failed'        && <AlertCircle className="w-3.5 h-3.5 text-danger flex-shrink-0" />}
          <div className="flex-1">
            <p className="text-xs text-white">{result?.message}</p>
            <p className="text-2xs text-surface-500">{result?.action} · {result?.name} · {result?.namespace}{result?.latencyMs ? ` · ${result.latencyMs}ms` : ''}</p>
          </div>
          {result?.dryRun && <span className="text-2xs font-bold text-brand-400 bg-brand-500/10 border border-brand-500/30 px-2 py-0.5 rounded-full flex-shrink-0">DRY RUN</span>}
        </div>
      </div>
    )
  }

  if (toolName === 'forecast_capacity') {
    return (
      <div className="mt-2 space-y-1.5">
        <div className={cn('text-xs font-bold px-3 py-1.5 rounded-xl border text-center',
          result?.overallRisk === 'critical' ? 'text-danger border-danger/30 bg-danger/5' : result?.overallRisk === 'warning' ? 'text-warning border-warning/30 bg-warning/5' : 'text-success border-success/30 bg-success/5'
        )}>Forecast: {result?.forecastWindow} — {(result?.overallRisk ?? 'healthy').toUpperCase()}</div>
        {Object.entries(result?.current ?? {}).map(([k, v]: any) => (
          <div key={k} className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-surface-900/50 border border-surface-700">
            <span className="text-xs text-surface-400 capitalize">{k}</span>
            <span className="text-xs font-bold text-surface-200">{v}</span>
          </div>
        ))}
        {(result?.recommendations ?? []).length > 0 && (
          <div className="space-y-1">
            {(result.recommendations as string[]).map((r, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-1.5 rounded-xl bg-warning/5 border border-warning/30 text-2xs text-warning">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />{r}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (toolName === 'predict_sla_breach') {
    const svcs: any[] = result?.services ?? []
    return (
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-2">
          {(result?.breachedCount ?? 0) > 0 && <span className="text-2xs font-bold text-danger bg-danger/10 border border-danger/30 px-2 py-0.5 rounded-full">{result.breachedCount} BREACHED</span>}
          {(result?.atRiskCount ?? 0) > 0 && <span className="text-2xs font-bold text-warning bg-warning/10 border border-warning/30 px-2 py-0.5 rounded-full">{result.atRiskCount} AT RISK</span>}
          {(result?.breachedCount ?? 0) === 0 && (result?.atRiskCount ?? 0) === 0 && <span className="text-2xs text-success">All services within SLO targets</span>}
        </div>
        {svcs.slice(0, 6).map((svc: any, i: number) => (
          <div key={i} className={cn('px-3 py-2 rounded-xl border',
            svc.breachRisk === 'breached' ? 'bg-danger/5 border-danger/30' : svc.breachRisk === 'at_risk' ? 'bg-warning/5 border-warning/30' : 'bg-surface-900/50 border-surface-700'
          )}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-white">{svc.service}</span>
              <span className={cn('text-2xs font-bold uppercase', svc.breachRisk === 'breached' ? 'text-danger' : svc.breachRisk === 'at_risk' ? 'text-warning' : 'text-success')}>{(svc.breachRisk ?? '').replace(/_/g, ' ')}</span>
            </div>
            <div className="text-2xs text-surface-400 mt-0.5">Avail: {svc.currentAvailability} · Budget used: {svc.errorBudgetUsed} · {svc.readyReplicas}</div>
          </div>
        ))}
      </div>
    )
  }

  if (toolName === 'suggest_remediation') {
    const steps: any[] = result?.steps ?? []
    if (!steps.length) return null
    return (
      <div className="mt-2 space-y-2">
        {result?.failureType && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-900/50 border border-surface-700">
            <span className="text-2xs text-surface-500">Detected:</span>
            <span className="text-2xs font-mono text-warning capitalize">{result.failureType.replace(/_/g, ' ')}</span>
          </div>
        )}
        <div className="space-y-1.5">
          {steps.map((s: any) => (
            <div key={s.priority} className="px-3 py-2 rounded-xl bg-surface-900/50 border border-surface-700">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-2xs font-bold text-brand-400 w-4 flex-shrink-0">{s.priority}.</span>
                <span className="text-xs text-white flex-1">{s.action}</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="text-2xs font-mono text-brand-300 bg-surface-950 px-2 py-0.5 rounded flex-1 truncate">{s.command}</code>
                <button onClick={() => navigator.clipboard.writeText(s.command ?? '')} className="p-1 rounded hover:bg-surface-700 text-surface-500 hover:text-white flex-shrink-0"><Copy className="w-2.5 h-2.5" /></button>
              </div>
            </div>
          ))}
        </div>
        {result?.escalation && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-warning/5 border border-warning/20 text-2xs text-warning">
            <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />{result.escalation}
          </div>
        )}
      </div>
    )
  }

  if (toolName === 'silence_alert') {
    if (result?.error) return (
      <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-xl bg-danger/5 border border-danger/30 text-xs text-danger">
        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{result.error}
      </div>
    )
    return (
      <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-success/5 border border-success/30">
        <Check className="w-3.5 h-3.5 text-success flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-white">{result?.message}</p>
          {result?.silenceId && <p className="text-2xs text-surface-500 font-mono">ID: {result.silenceId}</p>}
        </div>
        {result?.endsAt && <span className="text-2xs text-surface-500 flex-shrink-0">until {new Date(result.endsAt).toLocaleDateString()}</span>}
      </div>
    )
  }

  // Default: compact JSON for other tools
  return (
    <div className="mt-2 max-h-48 overflow-auto">
      <pre className="text-2xs font-mono text-surface-300 leading-relaxed whitespace-pre-wrap break-words">{JSON.stringify(result, null, 2)}</pre>
    </div>
  )
}

// ── Tool invocation card ──────────────────────────────────────
function ToolInvocationCard({ inv }: { inv: any }) {
  const RICH_TOOLS = new Set(['generate_workflow', 'multi_layer_correlate', 'predict_failures', 'recommend_security', 'recommend_cost_optimization', 'analyze_blast_radius', 'predict_sla_breach', 'forecast_capacity', 'recommend_scaling', 'execute_remediation'])
  const [open, setOpen] = useState(false)
  const [didAutoOpen, setDidAutoOpen] = useState(false)
  const meta    = TOOL_META[inv.toolName] ?? { label: inv.toolName, icon: Sparkles, group: 'Tool' }
  const Icon    = meta.icon
  const pending = inv.state !== 'result'

  useEffect(() => {
    if (!didAutoOpen && !pending && inv.result && RICH_TOOLS.has(inv.toolName)) {
      setOpen(true); setDidAutoOpen(true)
    }
  }, [pending, inv.result, inv.toolName, didAutoOpen])

  return (
    <div className={cn(
      'rounded-xl border text-xs overflow-hidden transition-all',
      pending ? 'bg-brand-500/5 border-brand-500/30' : 'bg-surface-900/50 border-surface-700',
    )}>
      <button onClick={() => !pending && setOpen(!open)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <div className={cn(
          'w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0',
          pending ? 'bg-brand-500/20 text-brand-400' : 'bg-surface-800 text-surface-400',
        )}>
          {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={pending ? 'text-brand-300' : 'text-surface-300'}>{meta.label}</span>
            <span className="text-2xs text-surface-500">{meta.group}</span>
            {pending && <span className="text-2xs text-brand-400 animate-pulse">running…</span>}
          </div>
          {inv.args && Object.keys(inv.args).length > 0 && (
            <div className="text-2xs text-surface-500 font-mono truncate">
              {Object.entries(inv.args).map(([k, v]: any) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ')}
            </div>
          )}
        </div>
        {!pending && <ChevronDown className={cn('w-3 h-3 text-surface-500 transition-transform flex-shrink-0', open && 'rotate-180')} />}
      </button>
      {open && !pending && inv.result && (
        <div className="px-3 pb-3 border-t border-surface-800 overflow-auto max-h-[520px]">
          <ToolResultContent toolName={inv.toolName} result={inv.result} />
        </div>
      )}
    </div>
  )
}

// ── Chat message ──────────────────────────────────────────────
function ChatMessage({ msg, onCopy }: { msg: Message; onCopy: (text: string) => void }) {
  const isUser = msg.role === 'user'
  const invocations = msg.toolInvocations ?? []

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}
      className={cn('flex gap-2.5', isUser ? 'justify-end' : 'justify-start')}
    >
      {!isUser && (
        <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-glow-brand">
          <Sparkles className="w-3.5 h-3.5 text-white" />
        </div>
      )}

      <div className="flex flex-col gap-2 max-w-[82%] min-w-0">
        {invocations.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {invocations.map((inv: any) => <ToolInvocationCard key={inv.toolCallId} inv={inv} />)}
          </div>
        )}

        {(msg.content || invocations.length === 0) && (
          <div className={cn(
            'rounded-2xl px-4 py-3 text-sm leading-relaxed group relative',
            isUser
              ? 'bg-brand-500/20 border border-brand-500/30 text-white rounded-tr-sm'
              : 'bg-surface-800 border border-surface-700 text-surface-200 rounded-tl-sm',
          )}>
            {msg.content ? (
              <>
                <MarkdownContent content={msg.content} />
                {!isUser && (
                  <button onClick={() => onCopy(msg.content)}
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-surface-700 text-surface-500 hover:text-surface-300 transition-all">
                    <Copy className="w-3 h-3" />
                  </button>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2 text-surface-400 py-0.5">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <motion.div key={i} className="w-1.5 h-1.5 rounded-full bg-brand-400"
                      animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, delay: i * 0.2, repeat: Infinity }} />
                  ))}
                </div>
                <span className="text-xs">Reasoning…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {isUser && (
        <div className="w-7 h-7 rounded-xl bg-surface-700 border border-surface-600 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-bold text-surface-300">U</div>
      )}
    </motion.div>
  )
}

// ── Insight card ──────────────────────────────────────────────
const SEV_COLOR: Record<string, string> = {
  critical: 'border-danger/40 bg-danger/5 text-danger',
  high:     'border-warning/40 bg-warning/5 text-warning',
  medium:   'border-brand-500/40 bg-brand-500/5 text-brand-400',
  low:      'border-surface-700 bg-surface-900/50 text-surface-400',
  info:     'border-purple-500/40 bg-purple-500/5 text-purple-400',
}
const KIND_ICON: Record<string, any> = {
  prediction:   Brain,
  rca:          Layers,
  optimization: Lightbulb,
  security:     ShieldAlert,
  autonomous:   PlayCircle,
}

function InsightCard({ insight, onAct }: { insight: Insight; onAct: (prompt: string) => void }) {
  const Icon = KIND_ICON[insight.kind]
  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      onClick={() => onAct(insight.suggestedPrompt)}
      className={cn(
        'min-w-[280px] w-[280px] flex-shrink-0 text-left rounded-2xl border p-3 transition-all hover:shadow-glow-brand group',
        SEV_COLOR[insight.severity],
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5" />
          <span className="text-2xs font-bold uppercase tracking-wider">{insight.kind}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {insight.metric && <span className="text-2xs font-mono font-bold opacity-90">{insight.metric}</span>}
          <span className="text-2xs opacity-60">{insight.confidence}%</span>
        </div>
      </div>
      <p className="text-xs font-semibold text-white leading-snug mb-1 line-clamp-2">{insight.title}</p>
      <p className="text-2xs text-surface-300 leading-relaxed line-clamp-2 mb-2">{insight.summary}</p>
      <div className="flex items-center gap-1 text-2xs opacity-80 group-hover:opacity-100">
        <Sparkles className="w-2.5 h-2.5" />
        <span>Ask AI</span>
        <ChevronRight className="w-2.5 h-2.5 ml-auto group-hover:translate-x-0.5 transition-transform" />
      </div>
    </motion.button>
  )
}

// ── Right context panel ───────────────────────────────────────
function ContextPanel({ insights, cluster }: { insights: Insight[]; cluster: any }) {
  const counts = {
    pred: insights.filter(i => i.kind === 'prediction').length,
    rca:  insights.filter(i => i.kind === 'rca').length,
    opt:  insights.filter(i => i.kind === 'optimization').length,
    sec:  insights.filter(i => i.kind === 'security').length,
  }

  return (
    <div className="w-60 flex-shrink-0 border-l border-surface-800 flex flex-col p-4 space-y-4 overflow-y-auto">
      <div className="flex items-center justify-between">
        <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Live Cluster</p>
        <span className="flex items-center gap-1 text-2xs text-success">
          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" /> Live
        </span>
      </div>

      <div className="space-y-1.5">
        {[
          { label: 'Nodes', value: `${(cluster?.nodes ?? 0) - (cluster?.notReady ?? 0)}/${cluster?.nodes ?? 0}`, ok: (cluster?.notReady ?? 0) === 0 },
          { label: 'Pods running', value: `${(cluster?.pods ?? 0) - (cluster?.failed ?? 0) - (cluster?.crashLoop ?? 0)}/${cluster?.pods ?? 0}`, ok: (cluster?.failed ?? 0) + (cluster?.crashLoop ?? 0) === 0 },
          { label: 'CrashLoop', value: cluster?.crashLoop ?? 0, ok: (cluster?.crashLoop ?? 0) === 0 },
          { label: 'Alerts firing', value: cluster?.firingAlerts ?? 0, ok: (cluster?.firingAlerts ?? 0) === 0 },
          { label: 'CPU', value: cluster?.cpu ?? '—', ok: parseFloat(cluster?.cpu ?? '0') < 85 },
          { label: 'Memory', value: cluster?.memory ?? '—', ok: parseFloat(cluster?.memory ?? '0') < 85 },
          { label: 'Disk', value: cluster?.disk ?? '—', ok: parseFloat(cluster?.disk ?? '0') < 85 },
        ].map((row) => (
          <div key={row.label} className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-surface-900 border border-surface-800">
            <span className="text-xs text-surface-400">{row.label}</span>
            <span className={cn('text-xs font-bold tabular-nums', row.ok ? 'text-success' : 'text-warning')}>{row.value}</span>
          </div>
        ))}
      </div>

      <div className="pt-1 border-t border-surface-800 space-y-1.5">
        <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">AI Insights</p>
        {[
          { label: 'Predictions',  count: counts.pred, icon: Brain,        color: 'text-purple-400' },
          { label: 'Active RCAs',  count: counts.rca,  icon: Layers,       color: 'text-danger' },
          { label: 'Optimizations',count: counts.opt,  icon: Lightbulb,    color: 'text-warning' },
          { label: 'Security',     count: counts.sec,  icon: ShieldAlert,  color: 'text-brand-400' },
        ].map((x) => {
          const Icon = x.icon
          return (
            <div key={x.label} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-surface-900 transition-colors">
              <div className="flex items-center gap-2">
                <Icon className={cn('w-3.5 h-3.5', x.color)} />
                <span className="text-xs text-surface-400">{x.label}</span>
              </div>
              <span className="text-xs font-bold text-surface-300 tabular-nums">{x.count}</span>
            </div>
          )
        })}
      </div>

      <div className="pt-1 border-t border-surface-800 space-y-1">
        <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Capabilities</p>
        {Object.values(TOOL_META).slice(0, 10).map((t, idx) => {
          const Icon = t.icon
          return (
            <div key={idx} className="flex items-center gap-2 text-xs text-surface-500">
              <Icon className="w-3 h-3 text-brand-500 flex-shrink-0" />
              <span className="truncate">{t.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────
export default function AICopilotPage() {
  const { activeCluster } = useDashboardStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)
  const [copied, setCopied]                 = useState<string | null>(null)
  const [showMobileSidebar, setShowMobileSidebar] = useState(false)
  const [conversations, setConversations]   = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId]     = useState<string>('default')
  const [mode, setMode]                     = useState<ModeKey>('investigate')
  const [showInsights, setShowInsights]     = useState(true)
  const [showModeHints, setShowModeHints]   = useState(false)

  const { data: insightsData, refresh: refreshInsights } = useLiveData<any>(
    '/api/ai/insights',
    { insights: [], cluster: {}, counts: {} },
    undefined,
    60_000,
  )
  const insights: Insight[] = insightsData?.insights ?? []
  const cluster              = insightsData?.cluster ?? {}

  const { data: usageData } = useLiveData<any>(
    '/api/ai/usage?limit=1',
    { totals: { today: { requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 } } },
    undefined,
    30_000,
  )
  const usageToday = usageData?.totals?.today ?? { requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 }

  const { messages, input, handleInputChange, handleSubmit, isLoading, error, append, setMessages, setInput, stop } =
    useChat({ api: '/api/ai/chat', initialMessages: INITIAL_MESSAGES })

  useEffect(() => {
    // Load from API first, fall back to localStorage
    fetch('/api/ai/chat/history')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.conversations?.length) {
          setConversations(d.conversations)
        } else {
          try { setConversations(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')) } catch {}
        }
      })
      .catch(() => {
        try { setConversations(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')) } catch {}
      })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (isLoading) return
    if (messages.length <= 1) return
    const firstUser = messages.find((m) => m.role === 'user')
    if (!firstUser) return
    const title = firstUser.content.slice(0, 60) + (firstUser.content.length > 60 ? '…' : '')
    setConversations((prev) => {
      const existing = prev.find((c) => c.id === activeConvId)
      let updated: Conversation[]
      if (existing) {
        updated = prev.map((c) => c.id === activeConvId ? { ...c, messages, title, mode } : c)
      } else {
        updated = [{ id: activeConvId, title, ts: new Date().toISOString(), messages, mode }, ...prev.slice(0, 19)]
      }
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)) } catch {}
      // Persist to server (fire-and-forget)
      fetch('/api/ai/chat/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversations: updated }),
      }).catch(() => {})
      return updated
    })
  }, [messages, isLoading, activeConvId, mode])

  const newConversation = useCallback(() => {
    const id = `conv-${Date.now()}`
    setActiveConvId(id)
    setMessages(INITIAL_MESSAGES)
    setInput('')
    inputRef.current?.focus()
  }, [setMessages, setInput])

  const loadConversation = useCallback((conv: Conversation) => {
    setActiveConvId(conv.id)
    setMessages(conv.messages)
    if (conv.mode) setMode(conv.mode)
  }, [setMessages])

  const deleteConversation = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setConversations((prev) => {
      const updated = prev.filter((c) => c.id !== id)
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)) } catch {}
      return updated
    })
    if (activeConvId === id) newConversation()
  }, [activeConvId, newConversation])

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(text.slice(0, 20))
      setTimeout(() => setCopied(null), 2000)
    })
  }, [])

  const sendPrompt = useCallback((text: string) => {
    setInput('')
    append({ role: 'user', content: text }, { headers: getClusterHeaders() })
  }, [append, setInput])

  const showWelcome = messages.length <= 1
  const activeMode = MODES[mode]

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Mobile sidebar overlay */}
      {showMobileSidebar && (
        <div className="sm:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowMobileSidebar(false)} />
          <div className="relative w-64 flex flex-col bg-surface-950 border-r border-surface-800 z-50 h-full overflow-y-auto">
            <div className="px-3 py-3 border-b border-surface-800 flex items-center justify-between">
              <button onClick={newConversation}
                className="flex-1 flex items-center gap-2 px-3 py-2 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 rounded-xl text-sm text-brand-400 font-medium transition-all">
                <Plus className="w-3.5 h-3.5" /> New Conversation
              </button>
              <button onClick={() => setShowMobileSidebar(false)} className="ml-2 p-2 text-surface-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-0.5">
              <p className="text-2xs font-semibold text-surface-600 uppercase tracking-wider px-2 py-1 mt-1">History</p>
              {conversations.length === 0 && <p className="text-2xs text-surface-600 px-2 py-2">No conversations yet</p>}
              {conversations.map((conv) => {
                const ModeIcon = MODES[conv.mode ?? 'chat']?.icon ?? History
                return (
                  <button key={conv.id} onClick={() => { loadConversation(conv); setShowMobileSidebar(false) }}
                    className={cn('w-full flex items-start gap-2 px-2 py-2 rounded-xl text-left transition-all', conv.id === activeConvId ? 'bg-brand-500/10 text-brand-400' : 'hover:bg-surface-800 text-surface-400')}>
                    <ModeIcon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span className="flex-1 text-xs line-clamp-2 leading-relaxed">{conv.title}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
      {/* Left sidebar — history (desktop only) */}
      <div className="hidden lg:flex w-48 flex-shrink-0 border-r border-surface-800 flex-col bg-surface-950">
        <div className="px-3 py-3 border-b border-surface-800">
          <button onClick={newConversation}
            className="w-full flex items-center gap-2 px-3 py-2 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 rounded-xl text-sm text-brand-400 font-medium transition-all">
            <Plus className="w-3.5 h-3.5" /> New Conversation
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-0.5">
          <p className="text-2xs font-semibold text-surface-600 uppercase tracking-wider px-2 py-1 mt-1">History</p>
          {conversations.length === 0 && <p className="text-2xs text-surface-600 px-2 py-2">No conversations yet</p>}
          {conversations.map((conv) => {
            const ModeIcon = MODES[conv.mode ?? 'chat']?.icon ?? History
            return (
              <button key={conv.id} onClick={() => loadConversation(conv)}
                className={cn(
                  'w-full flex items-start gap-2 px-2 py-2 rounded-xl text-left transition-all group',
                  conv.id === activeConvId ? 'bg-brand-500/10 text-brand-400' : 'hover:bg-surface-800 text-surface-400 hover:text-surface-300',
                )}>
                <ModeIcon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span className="flex-1 text-xs line-clamp-2 leading-relaxed">{conv.title}</span>
                <button onClick={(e) => deleteConversation(conv.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-danger transition-all flex-shrink-0">
                  <X className="w-3 h-3" />
                </button>
              </button>
            )
          })}
        </div>
        {conversations.length > 0 && (
          <div className="px-3 py-2 border-t border-surface-800">
            <Link href="/ai-copilot/history"
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-xl text-2xs text-surface-500 hover:text-brand-400 hover:bg-brand-500/5 transition-all">
              <History className="w-3 h-3" /> View full history
            </Link>
          </div>
        )}
        {/* Token usage today */}
        <div className="px-3 py-2.5 border-t border-surface-800 space-y-1.5">
          <p className="text-2xs font-semibold text-surface-600 uppercase tracking-wider">Tokens today</p>
          <div className="grid grid-cols-2 gap-1">
            <div className="flex flex-col gap-0.5 px-2 py-1.5 rounded-lg bg-surface-900 border border-surface-800">
              <span className="text-2xs text-surface-500">Requests</span>
              <span className="text-xs font-bold text-white">{usageToday.requests.toLocaleString()}</span>
            </div>
            <div className="flex flex-col gap-0.5 px-2 py-1.5 rounded-lg bg-surface-900 border border-surface-800">
              <span className="text-2xs text-surface-500">Total</span>
              <span className="text-xs font-bold text-brand-400">{usageToday.totalTokens >= 1000 ? `${(usageToday.totalTokens / 1000).toFixed(1)}k` : usageToday.totalTokens}</span>
            </div>
            <div className="flex flex-col gap-0.5 px-2 py-1.5 rounded-lg bg-surface-900 border border-surface-800">
              <span className="text-2xs text-surface-500">In</span>
              <span className="text-xs font-bold text-surface-300">{usageToday.promptTokens >= 1000 ? `${(usageToday.promptTokens / 1000).toFixed(1)}k` : usageToday.promptTokens}</span>
            </div>
            <div className="flex flex-col gap-0.5 px-2 py-1.5 rounded-lg bg-surface-900 border border-surface-800">
              <span className="text-2xs text-surface-500">Out</span>
              <span className="text-xs font-bold text-success">{usageToday.completionTokens >= 1000 ? `${(usageToday.completionTokens / 1000).toFixed(1)}k` : usageToday.completionTokens}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Center column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="border-b border-surface-800 flex-shrink-0">
          {/* Row 1: icon + title + refresh */}
          <div className="flex items-center gap-2 px-3 sm:px-5 py-2.5">
            {/* Mobile: history toggle */}
            <button onClick={() => setShowMobileSidebar(true)}
              className="lg:hidden p-2 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-white transition-colors flex-shrink-0">
              <History className="w-4 h-4" />
            </button>
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center shadow-glow-brand flex-shrink-0">
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-white">VynOps AI Online</p>
              <p className="text-2xs text-surface-400 truncate">
                Real-time SRE copilot — causal reasoning, predictive analytics &amp; autonomous remediation
              </p>
            </div>
            <button onClick={() => refreshInsights()}
              className="p-2 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-white transition-colors flex-shrink-0"
              title="Refresh insights">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            {copied && <span className="flex items-center gap-1 text-2xs text-success flex-shrink-0"><Check className="w-3 h-3" /> Copied</span>}
          </div>
          {/* Row 2: mode tabs */}
          <div className="flex items-center gap-0.5 px-3 sm:px-5 pb-2 overflow-x-auto scrollbar-none">
            {(Object.entries(MODES) as [ModeKey, any][]).map(([key, m]) => {
              const Icon = m.icon
              return (
                <button key={key} onClick={() => { setMode(key); setShowModeHints(true) }}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex-shrink-0 whitespace-nowrap',
                    mode === key
                      ? 'bg-surface-800 text-white shadow-sm'
                      : 'text-surface-400 hover:text-white hover:bg-surface-800/50',
                  )}>
                  <Icon className={cn('w-3 h-3', mode === key ? m.color : '')} />
                  {m.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* AI Insights hero strip */}
        {showInsights && insights.length > 0 && (
          <div className="px-5 py-3 border-b border-surface-800 flex-shrink-0">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                <p className="text-xs font-bold text-white">AI Insights</p>
                <span className="text-2xs text-surface-500">— {insights.length} signals from live cluster · tap to investigate</span>
              </div>
              <button onClick={() => setShowInsights(false)} className="text-2xs text-surface-500 hover:text-surface-300">Hide</button>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {insights.map((ins) => <InsightCard key={ins.id} insight={ins} onAct={sendPrompt} />)}
            </div>
          </div>
        )}
        {!showInsights && (
          <button onClick={() => setShowInsights(true)}
            className="mx-5 mt-2 self-start flex items-center gap-1.5 px-3 py-1 text-2xs text-surface-500 hover:text-brand-400 transition-colors">
            <Sparkles className="w-3 h-3" /> Show AI Insights
          </button>
        )}

        {/* Error banner */}
        {error && (
          <div className="mx-4 mt-3 flex items-start gap-2 p-3 rounded-xl bg-warning/5 border border-warning/20 text-warning text-xs flex-shrink-0">
            <WifiOff className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="space-y-0.5">
              <span className="font-semibold">AI error</span>{' — '}
              <span className="font-mono">{error.message || 'Request failed — check server logs.'}</span>
              {(error.message?.includes('API key') || error.message?.includes('401') || error.message?.includes('503')) && (
                <div className="mt-1 text-surface-400">
                  Check <code className="font-mono bg-surface-900 px-1 rounded">GROQ_API_KEY</code> in{' '}
                  <code className="font-mono bg-surface-900 px-1 rounded">.env.local</code> and restart.
                </div>
              )}
              {error.message?.includes('Rate limit') && (
                <div className="mt-1 text-surface-400">Rate limit reached (20&nbsp;req/min). Wait a moment then try again.</div>
              )}
            </div>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
          <AnimatePresence initial={false}>
            {messages.filter(m => m.id !== 'init-1').map((msg) => <ChatMessage key={msg.id} msg={msg} onCopy={handleCopy} />)}
          </AnimatePresence>

          {/* Suggested prompts inline — shown when no messages or mode just switched */}
          {(showWelcome || showModeHints) && (
            <div className="pt-1 pb-2">
              <div className="flex items-center justify-between mb-2">
                <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider flex items-center gap-1.5">
                  <activeMode.icon className={cn('w-3 h-3', activeMode.color)} />
                  {activeMode.label} prompts
                </p>
                {!showWelcome && (
                  <button onClick={() => setShowModeHints(false)} className="text-2xs text-surface-500 hover:text-surface-300 transition-colors">Hide</button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {activeMode.prompts.map((p) => (
                  <button key={p} onClick={() => { sendPrompt(p); setShowModeHints(false) }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 hover:border-brand-500/40 rounded-xl text-xs text-surface-300 hover:text-white transition-all max-w-xs truncate">
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isLoading && messages[messages.length - 1]?.role === 'user' && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5">
              <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
              </div>
              <div className="rounded-2xl rounded-tl-sm px-4 py-3 bg-surface-800 border border-surface-700">
                <div className="flex items-center gap-2 text-surface-400">
                  <div className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <motion.div key={i} className="w-1.5 h-1.5 rounded-full bg-brand-400"
                        animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, delay: i * 0.2, repeat: Infinity }} />
                    ))}
                  </div>
                  <span className="text-xs">Querying live infrastructure & reasoning…</span>
                </div>
              </div>
            </motion.div>
          )}
        </div>

        {/* Input */}
        <form onSubmit={(e) => handleSubmit(e, { headers: getClusterHeaders() })} className="px-5 pb-5 pt-2 flex-shrink-0">
          <div className="flex items-center gap-2 bg-surface-800 border border-surface-700 focus-within:border-brand-500/60 rounded-2xl px-4 py-3 transition-all">
            <activeMode.icon className={cn('w-4 h-4 flex-shrink-0', activeMode.color)} />
            <input ref={inputRef} value={input} onChange={handleInputChange}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e as any, { headers: getClusterHeaders() }) } }}
              placeholder={`Ask in ${activeMode.label.toLowerCase()} mode…`}
              className="flex-1 bg-transparent text-sm text-white placeholder-surface-500 outline-none" disabled={isLoading} />
            {isLoading ? (
              <button type="button" onClick={stop}
                className="w-8 h-8 flex items-center justify-center bg-danger/15 hover:bg-danger/25 border border-danger/30 rounded-xl text-danger transition-all flex-shrink-0"
                title="Stop generating">
                <Square className="w-3 h-3 fill-current" />
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()}
                className="w-8 h-8 flex items-center justify-center bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-white transition-all flex-shrink-0">
                <Send className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <p className="text-2xs text-surface-600 text-center mt-2">
            Live K8s + Prometheus · 20 AI tools · Causal RCA · Predictive · Autonomous (with approval gates)
          </p>
        </form>
      </div>

      {/* Right context panel — removed; shell RightAISidebar shows the same cluster data */}
    </div>
  )
}
