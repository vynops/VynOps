'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import {
  Activity, Siren, Server, Zap, ArrowRight, Clock,
  DollarSign, Bot, Sparkles, ShieldAlert, CheckCircle2,
  AlertTriangle, Radio, RefreshCw, TrendingUp, TrendingDown,
  GitBranch, Layers, Cpu, MemoryStick, Gauge, Flame,
  ChevronRight, ExternalLink, Phone,
} from 'lucide-react'
import { useDashboardStore } from '@/store'
import KPICard from '@/components/widgets/KPICard'
import { MetricChart, Sparkline } from '@/components/charts/MetricChart'
import { cn, formatLatency, timeAgo } from '@/lib/utils'
import { useLiveData } from '@/hooks/useLiveData'
import type { GlobalHealthScore } from '@/types'

const fadeUp = {
  hidden:   { opacity: 0, y: 16 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.05, duration: 0.3, ease: 'easeOut' } }),
}

// ── Types ─────────────────────────────────────────────────────

type IncidentItem = {
  id: string; title: string; severity: string; state: string
  service: string; createdAt: string; slaBreached: boolean
  alertCount: number; durationMinutes: number; source: string
  blastRadius: { affectedServices: string[] }
}
type IncidentResp = {
  incidents: IncidentItem[]
  metrics: { open: number; critical: number; slaBreached: number; slaBreaching: number; avgMttrMinutes: number | null; totalAlerts: number; slaCompliancePct: number }
}
type SummaryResp = {
  cluster: { name: string; version: string; nodeCount: number; healthyNodes: number; podCount: number; runningPods: number; crashPods: number; deploymentCount: number; cpuPct: number; memPct: number }
  cost:    { totalPerMo: number; wastedPerMo: number; projected: number; cpuEfficiency: number; memEfficiency: number; cpuPct: number; memPct: number }
  dora:    { deployFrequency7d: number; successRate: number; changeFailureRate: number; recentDeploys: number; frequencyBand: string; cfrBand: string }
  alertSummary: { total: number; critical: number; oldestAlertDays: number }
  insights: { id: string; type: string; title: string; description: string; severity: string; action?: string }[]
}
type MetricsResp = {
  clusterMetrics: {
    cpuUsage: number; memoryUsage: number; requestRate: number; errorRate: number
    p99Latency: number; p50Latency: number
    history: { cpu: any[]; memory: any[]; requests: any[]; errors: any[] }
  }
  serviceMetrics: { name: string; namespace: string; requestRate: number; errorRate: number; p99Latency: number; availability: number; status: string }[]
}

const EMPTY_INC: IncidentResp = { incidents: [], metrics: { open: 0, critical: 0, slaBreached: 0, slaBreaching: 0, avgMttrMinutes: null, totalAlerts: 0, slaCompliancePct: 100 } }
const EMPTY_SUM: SummaryResp = {
  cluster: { name: '\u2014', version: '\u2014', nodeCount: 0, healthyNodes: 0, podCount: 0, runningPods: 0, crashPods: 0, deploymentCount: 0, cpuPct: 0, memPct: 0 },
  cost:    { totalPerMo: 0, wastedPerMo: 0, projected: 0, cpuEfficiency: 0, memEfficiency: 0, cpuPct: 0, memPct: 0 },
  dora:    { deployFrequency7d: 0, successRate: 0, changeFailureRate: 0, recentDeploys: 0, frequencyBand: 'low', cfrBand: 'low' },
  alertSummary: { total: 0, critical: 0, oldestAlertDays: 0 },
  insights: [],
}
const EMPTY_MET: MetricsResp = {
  clusterMetrics: { cpuUsage: 0, memoryUsage: 0, requestRate: 0, errorRate: 0, p99Latency: 0, p50Latency: 0, history: { cpu: [], memory: [], requests: [], errors: [] } },
  serviceMetrics: [],
}

type OnCallMember = { id: string; name: string; email: string; slack?: string }
type OnCallSchedule = { id: string; name: string; currentOnCall: OnCallMember | null; nextRotationAt: string }
type OnCallResp = { schedules: OnCallSchedule[] }
const EMPTY_ONCALL: OnCallResp = { schedules: [] }

// ── Helpers ───────────────────────────────────────────────────

function fmtDur(m: number) { return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m` }
function fmtFreq(f: number) {
  if (f >= 1) return `${f.toFixed(1)}/day`
  if (f * 7 >= 1) return `${(f * 7).toFixed(1)}/week`
  return `${(f * 30).toFixed(1)}/month`
}

const BAND_CLR: Record<string, string> = {
  elite:  'text-success',
  high:   'text-brand-400',
  medium: 'text-warning',
  low:    'text-danger',
}

const INS_ICON: Record<string, React.ReactNode> = {
  alert:       <AlertTriangle className="w-3.5 h-3.5 text-danger" />,
  cost:        <DollarSign className="w-3.5 h-3.5 text-warning" />,
  performance: <Gauge className="w-3.5 h-3.5 text-warning" />,
  reliability: <Flame className="w-3.5 h-3.5 text-danger" />,
  dora:        <GitBranch className="w-3.5 h-3.5 text-brand-400" />,
  info:        <CheckCircle2 className="w-3.5 h-3.5 text-success" />,
}

const SEV_BADGE: Record<string, string> = {
  critical: 'text-danger  bg-danger/10  border-danger/20',
  high:     'text-warning bg-warning/10 border-warning/20',
  medium:   'text-blue-400 bg-blue-400/10 border-blue-400/20',
  low:      'text-surface-400 bg-surface-800 border-surface-700',
}
const STATE_CLR: Record<string, string> = {
  open:          'text-danger  bg-danger/10  border-danger/20',
  investigating: 'text-warning bg-warning/10 border-warning/20',
  identified:    'text-blue-400 bg-blue-400/10 border-blue-400/20',
  monitoring:    'text-brand-400 bg-brand-400/10 border-brand-400/20',
  resolved:      'text-success bg-success/10 border-success/20',
}

// ── Platform Health Ring ──────────────────────────────────────────

type PlatformScoreInputs = {
  podHealth: number      // % pods running (0–100), defaults 100 if no pods yet
  nodeHealth: number     // % nodes ready (0–100), defaults 100 if no nodes yet
  slaCompliance: number  // % SLA met (0–100), defaults 100 if no incidents yet
  successRate: number    // % deploy success (0–100), defaults 100 if no deploys yet
  criticalOpen: number   // count of critical-severity open incidents
  highOpen: number       // count of high-severity open incidents
}

function platformScore(inputs: PlatformScoreInputs): { score: number; breakdown: { podPts: number; nodePts: number; slaPts: number; velPts: number; penalty: number } } {
  const { podHealth, nodeHealth, slaCompliance, successRate, criticalOpen, highOpen } = inputs
  const podPts  = Math.round(podHealth  * 0.35)
  const nodePts = Math.round(nodeHealth * 0.25)
  const slaPts  = Math.round(slaCompliance * 0.20)
  const velPts  = Math.round(successRate   * 0.20)
  const penalty = Math.min(15, criticalOpen * 5 + highOpen * 2)
  const score   = Math.max(0, Math.min(100, podPts + nodePts + slaPts + velPts - penalty))
  return { score, breakdown: { podPts, nodePts, slaPts, velPts, penalty } }
}

function HealthRing({ score, breakdown, podHealth, nodeHealth, sla, velocity, criticalOpen, highOpen }:
  { score: number; breakdown: { podPts: number; nodePts: number; slaPts: number; velPts: number; penalty: number }; podHealth: number; nodeHealth: number; sla: number; velocity: number; criticalOpen: number; highOpen: number }) {
  const size = 72
  const r = size * 0.38; const circ = 2 * Math.PI * r
  const color = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444'
  const label = score >= 80 ? 'Healthy' : score >= 60 ? 'Degraded' : 'Critical'
  const { podPts, nodePts, slaPts, velPts, penalty } = breakdown
  const [hovered, setHovered] = useState(false)
  return (
    <div className="relative rounded-2xl bg-surface-900 border border-surface-800 p-4 flex items-center gap-4 cursor-default"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1e293b" strokeWidth={size * 0.1} />
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={size * 0.1}
            strokeDasharray={`${(score / 100) * circ} ${circ}`} strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 1s ease' }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-sm font-black tabular-nums" style={{ color }}>{score}</p>
          <p className="text-2xs text-surface-500 leading-none">/100</p>
        </div>
      </div>
      <div>
        <p className="text-2xs text-surface-500 uppercase tracking-wider">Platform Health</p>
        <p className="text-sm font-bold text-white mt-0.5">{label}</p>
        <p className="text-2xs text-surface-500 mt-1 leading-relaxed">Pods · Nodes · SLA · Velocity</p>
      </div>
      {/* Hover tooltip */}
      {hovered && (
        <div className="absolute left-0 top-full mt-2 z-50 w-68 rounded-xl bg-surface-900 border border-surface-700 shadow-2xl p-3 text-xs pointer-events-none">
          <p className="text-surface-300 font-semibold mb-2">Score breakdown</p>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-surface-400">Pod Health (×0.35)</span>
              <span className="tabular-nums">
                <span className={podHealth >= 95 ? 'text-success' : podHealth >= 80 ? 'text-warning' : 'text-danger'}>{podHealth}%</span>
                <span className="text-surface-500 ml-1">= +{podPts} pts</span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-surface-400">Node Health (×0.25)</span>
              <span className="tabular-nums">
                <span className={nodeHealth >= 95 ? 'text-success' : nodeHealth >= 80 ? 'text-warning' : 'text-danger'}>{nodeHealth}%</span>
                <span className="text-surface-500 ml-1">= +{nodePts} pts</span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-surface-400">SLA Compliance (×0.20)</span>
              <span className="tabular-nums">
                <span className={sla >= 99 ? 'text-success' : sla >= 90 ? 'text-warning' : 'text-danger'}>{sla}%</span>
                <span className="text-surface-500 ml-1">= +{slaPts} pts</span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-surface-400">Deploy Success (×0.20)</span>
              <span className="tabular-nums">
                <span className={velocity >= 99 ? 'text-success' : velocity >= 90 ? 'text-warning' : 'text-danger'}>{velocity}%</span>
                <span className="text-surface-500 ml-1">= +{velPts} pts</span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-surface-400">Incident Penalty</span>
              <span className="tabular-nums">
                <span className={penalty === 0 ? 'text-success' : 'text-danger'}>
                  {criticalOpen > 0 && `${criticalOpen} crit`}{criticalOpen > 0 && highOpen > 0 && ', '}{highOpen > 0 && `${highOpen} high`}{criticalOpen === 0 && highOpen === 0 && 'none'}
                </span>
                <span className="text-surface-500 ml-1">= −{penalty} pts</span>
              </span>
            </div>
          </div>
          <div className="border-t border-surface-700 mt-2 pt-2 flex items-center justify-between">
            <span className="text-surface-400">Final Score</span>
            <span className="font-bold tabular-nums" style={{ color }}>{score} / 100</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── On-Call Badge ────────────────────────────────────────────

function initials(name: string) {
  return name.split(' ').map(p => p[0] ?? '').join('').slice(0, 2).toUpperCase()
}

function OnCallBadge({ member, nextRotation }: { member: OnCallMember; nextRotation?: string }) {
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = () => { if (timer.current) clearTimeout(timer.current); setVisible(true) }
  const hide = () => { timer.current = setTimeout(() => setVisible(false), 120) }

  const rotatesIn = nextRotation ? (() => {
    const ms = new Date(nextRotation).getTime() - Date.now()
    if (ms <= 0) return null
    const h = Math.floor(ms / 3_600_000)
    if (h < 24) return `${h}h`
    return `${Math.floor(h / 24)}d`
  })() : null
  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <Link href="/settings?tab=oncall"
        className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-sm transition-all">
        <Phone className="w-3.5 h-3.5 text-success flex-shrink-0" />
        <span className="w-6 h-6 rounded-full bg-brand-500/20 border border-brand-500/40 flex items-center justify-center text-2xs font-bold text-brand-300 flex-shrink-0">
          {initials(member.name)}
        </span>
        <span className="text-surface-300 font-medium hidden sm:inline max-w-[100px] truncate">{member.name}</span>
      </Link>
      {visible && (
        <div className="absolute right-0 top-full pt-1 z-50" onMouseEnter={show} onMouseLeave={hide}>
          <div className="w-56 rounded-xl bg-surface-900 border border-surface-700 shadow-2xl p-3 text-xs">
            <p className="text-surface-500 uppercase tracking-wider mb-1.5">On Call Now</p>
            <p className="text-white font-semibold">{member.name}</p>
            <p className="text-surface-400 mt-0.5 truncate">{member.email}</p>
            {member.slack && <p className="text-brand-400 mt-0.5">{'@'}{member.slack}</p>}
            {rotatesIn && (
              <p className="text-surface-500 mt-2 border-t border-surface-700 pt-2">Rotates in {rotatesIn}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────

export default function ExecutiveDashboard() {
  const { healthScore: storeHealth, setHealthScore, timeRange } = useDashboardStore()

  // Convert global timeRange (e.g. '1h', '6h', '7d') to minutes for metrics APIs
  function toMinutes(tr: string): number {
    if (tr.endsWith('m')) return parseInt(tr)
    if (tr.endsWith('h')) return parseInt(tr) * 60
    if (tr.endsWith('d')) return parseInt(tr) * 1440
    return 60
  }
  const winMin = toMinutes(timeRange)

  // Live health score (refreshed into store for TopHeader badge)
  const { data: liveHealth, isLive: healthLive } = useLiveData<GlobalHealthScore>(
    '/api/k8s/health',
    storeHealth,
    (r) => ({ ...storeHealth, ...r }),
    60_000,
  )
  useEffect(() => { if (healthLive) setHealthScore(liveHealth) }, [liveHealth, healthLive, setHealthScore])
  const health = healthLive ? liveHealth : storeHealth

  // Real incidents
  const { data: incData, isLive: incLive, refresh: refreshInc, error: incErr } = useLiveData<IncidentResp>(
    '/api/incidents', EMPTY_INC, undefined, 30_000,
  )

  // Cluster metrics + service list (for sparklines)
  const { data: metData, isLive: metLive, error: metErr } = useLiveData<MetricsResp>(
    `/api/observability/metrics?window=${winMin}`, EMPTY_MET, undefined, 30_000,
  )

  // Summary: cluster, cost, DORA, insights
  const { data: sum, isLive: sumLive, loading: sumLoading, error: sumErr } = useLiveData<SummaryResp>(
    `/api/dashboard/summary?window=${winMin}`, EMPTY_SUM, undefined, 60_000,
  )

  // On-call schedule
  const { data: oncallData } = useLiveData<OnCallResp>('/api/settings/oncall', EMPTY_ONCALL, undefined, 120_000)
  const primarySchedule = oncallData.schedules.find(s => s.id === 'primary') ?? oncallData.schedules[0] ?? null
  const onCallNow = primarySchedule?.currentOnCall ?? null

  const isAnyLive = healthLive || incLive || metLive || sumLive
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  useEffect(() => { if (isAnyLive) setLastRefreshAt(Date.now()) }, [isAnyLive, sum, incData, metData])
  const cm = metData.clusterMetrics
  const services = metData.serviceMetrics

  const openInc      = incData.incidents.filter(i => i.state !== 'resolved')
  const criticalInc  = openInc.find(i => i.severity === 'critical')
  const firingAlerts = incData.metrics.totalAlerts
  const criticalOpen = openInc.filter(i => i.severity === 'critical').length
  const highOpen     = openInc.filter(i => i.severity === 'high').length

  const podHealth  = sum.cluster.podCount  > 0 ? Math.round((sum.cluster.runningPods  / sum.cluster.podCount)  * 100) : 100
  const nodeHealth = sum.cluster.nodeCount > 0 ? Math.round((sum.cluster.healthyNodes / sum.cluster.nodeCount) * 100) : 100
  const { score: platScore, breakdown: platBreakdown } = platformScore({
    podHealth,
    nodeHealth,
    slaCompliance: incData.metrics.slaCompliancePct ?? 100,
    successRate:   sum.dora.recentDeploys > 0 ? sum.dora.successRate : 100,
    criticalOpen,
    highOpen,
  })

  return (
    <div className="p-3 sm:p-6 space-y-5 min-h-full">

      {/* ── Header ── */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Operations Overview</h1>
          <p className="text-sm text-surface-500 mt-0.5">
            {sum.cluster.name}{'\u00B7'}{sum.cluster.version}{'\u00B7'}{sum.cluster.nodeCount} nodes{'\u00B7'}{sum.cluster.podCount} pods
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn(
            'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-xl border transition-all',
            isAnyLive ? 'bg-success/10 text-success border-success/30' : 'bg-surface-800 text-surface-500 border-surface-700',
          )}>
            <Radio className={cn('w-3 h-3', isAnyLive && 'animate-pulse')} />
            {isAnyLive ? 'Live' : 'Demo'}
          </span>
          {isAnyLive && lastRefreshAt && (
            <span className="text-2xs text-surface-500 hidden sm:inline" suppressHydrationWarning>
              Updated {timeAgo(lastRefreshAt)}
            </span>
          )}
          {onCallNow && (
            <OnCallBadge member={onCallNow} nextRotation={primarySchedule?.nextRotationAt} />
          )}
          <Link href="/ai-copilot"
            className="flex items-center gap-2 px-3 py-1.5 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 rounded-xl text-sm text-brand-400 font-medium transition-all">
            <Bot className="w-4 h-4" /> Ask AI
          </Link>
          {(sumErr || incErr || metErr) && (
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-warning/5 border border-warning/20 rounded-xl text-xs text-warning/80">
              <AlertTriangle className="w-3 h-3" /> {sumErr ?? incErr ?? metErr}
            </span>
          )}
          <Link href="/incidents"
            className="flex items-center gap-2 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-sm text-surface-300 transition-all">
            <Siren className="w-4 h-4" /> Incidents
            {incData.metrics.open > 0 && (
              <span className="text-2xs bg-danger/20 text-danger px-1 rounded-full">{incData.metrics.open}</span>
            )}
          </Link>
        </div>
      </motion.div>

      {/* ── Critical incident banner ── */}
      {criticalInc && (
        <motion.div initial={{ opacity: 0, scaleY: 0.9 }} animate={{ opacity: 1, scaleY: 1 }}
          className="rounded-2xl bg-danger/8 border border-danger/30 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-danger/20 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-danger" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-danger">ACTIVE INCIDENT</span>
              <span className="text-2xs bg-danger/20 text-danger px-1.5 py-0.5 rounded-full border border-danger/30 font-medium">CRITICAL</span>
              {criticalInc.slaBreached && (
                <span className="text-2xs bg-danger text-white px-1.5 py-0.5 rounded-full font-semibold">SLA BREACHED</span>
              )}
            </div>
            <p className="text-sm text-white mt-0.5 truncate">{criticalInc.title}</p>
            <p className="text-xs text-surface-400 mt-0.5 flex items-center gap-2">
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" /><span suppressHydrationWarning>{fmtDur(criticalInc.durationMinutes)} ago</span></span>
              <span>{criticalInc.alertCount} alerts correlated</span>
              <span>{criticalInc.source}</span>
            </p>
          </div>
          <Link href={criticalInc ? `/incidents/${criticalInc.id}` : '/incidents'}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-danger/20 hover:bg-danger/30 border border-danger/40 rounded-xl text-sm text-danger font-medium flex-shrink-0 transition-all">
            Investigate <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </motion.div>
      )}

      {/* ── No cluster connected ── */}
      {sumLive && sum.cluster.name === '\u2014' && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl bg-brand-500/5 border border-brand-500/20 p-4 flex items-center gap-4">
          <div className="w-9 h-9 rounded-xl bg-brand-500/10 flex items-center justify-center flex-shrink-0">
            <Server className="w-4 h-4 text-brand-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">No cluster connected</p>
            <p className="text-xs text-surface-400 mt-0.5">Connect a Kubernetes cluster to see live metrics, incidents, and AI-driven insights.</p>
          </div>
          <Link href="/settings?tab=clusters"
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-brand-500/20 hover:bg-brand-500/30 border border-brand-500/30 rounded-xl text-sm text-brand-400 font-medium transition-all">
            Connect <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </motion.div>
      )}

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <motion.div key="sys-health" custom={0} initial="hidden" animate="visible" variants={fadeUp}>
          <KPICard
            label="System Health"
            value={health.score}
            unit="%"
            status={health.score >= 90 ? 'healthy' : health.score >= 70 ? 'degraded' : 'critical'}
            icon={<Activity className="w-4 h-4" />}
            pulse={health.score < 90}
            trend={0}
            trendLabel="real-time"
            tooltip={[
              { label: 'Nodes Ready',      value: `${health._debug?.nodes.ready ?? '?'} / ${health._debug?.nodes.total ?? '?'}`,   color: (health._debug?.nodes.ready === health._debug?.nodes.total ? 'success' : 'danger') as never },
              { label: 'Pods Running',     value: `${health._debug?.pods.running ?? '?'} / ${health._debug?.pods.workload ?? '?'}`, color: ((health._debug?.pods.running ?? 0) === (health._debug?.pods.workload ?? 0) ? 'success' : 'warning') as never },
              { label: 'CPU Usage',        value: health._debug?.cpuPct != null ? `${health._debug.cpuPct}%` : '—',            color: ((health._debug?.cpuPct ?? 0) > 80 ? 'danger' : (health._debug?.cpuPct ?? 0) > 60 ? 'warning' : 'success') as never },
              { label: 'Memory Usage',     value: health._debug?.memPct != null ? `${health._debug.memPct}%` : '—',            color: ((health._debug?.memPct ?? 0) > 80 ? 'danger' : (health._debug?.memPct ?? 0) > 60 ? 'warning' : 'success') as never },
              { label: 'Change Fail Rate', value: `${health.changeFailureRate}%`,                                                   color: (health.changeFailureRate === 0 ? 'success' : 'danger') as never },
            ]}
          />
        </motion.div>
        <motion.div custom={1} initial="hidden" animate="visible" variants={fadeUp} className="lg:col-span-2">
          <HealthRing score={platScore} breakdown={platBreakdown} podHealth={podHealth} nodeHealth={nodeHealth} sla={incData.metrics.slaCompliancePct ?? 100} velocity={sum.dora.recentDeploys > 0 ? sum.dora.successRate : 100} criticalOpen={criticalOpen} highOpen={highOpen} />
        </motion.div>
        {[
          {
            label: 'Active Incidents',
            value: incData.metrics.open,
            status: incData.metrics.open === 0 ? 'healthy' : 'critical',
            icon: <Siren className="w-4 h-4" />,
            pulse: incData.metrics.open > 0,
            tooltip: [
              { label: 'Critical',     value: `${incData.metrics.critical}`,                                              color: (incData.metrics.critical > 0 ? 'danger' : 'success') as never },
              { label: 'SLA Breached', value: `${incData.metrics.slaBreached}`,                                           color: (incData.metrics.slaBreached > 0 ? 'danger' : 'success') as never },
              { label: 'SLA At Risk',  value: `${incData.metrics.slaBreaching}`,                                          color: (incData.metrics.slaBreaching > 0 ? 'warning' : 'success') as never },
              { label: 'Avg MTTR',     value: incData.metrics.avgMttrMinutes != null ? `${incData.metrics.avgMttrMinutes} min` : '\u2014', color: 'neutral' as never },
              { label: 'SLA Compliance', value: `${incData.metrics.slaCompliancePct ?? 100}%`,                            color: ((incData.metrics.slaCompliancePct ?? 100) >= 90 ? 'success' : 'danger') as never },
            ],
          },
          {
            label: 'Firing Alerts',
            value: firingAlerts,
            status: firingAlerts === 0 ? 'healthy' : firingAlerts <= 2 ? 'degraded' : 'critical',
            icon: <AlertTriangle className="w-4 h-4" />,
          },
          {
            label: 'Uptime',
            value: health.uptime.toFixed(2), unit: '%',
            status: health.uptime >= 99.9 ? 'healthy' : 'degraded',
            icon: <CheckCircle2 className="w-4 h-4" />,
          },
          {
            label: 'P99 Latency',
            value: cm.p99Latency > 0 ? formatLatency(cm.p99Latency) : '\u2014',
            status: cm.p99Latency > 2000 ? 'critical' : cm.p99Latency > 500 ? 'degraded' : 'healthy',
            icon: <Zap className="w-4 h-4" />,
          },
          {
            label: 'Est. Cost / mo',
            value: sum.cost.totalPerMo > 0 ? `$${sum.cost.totalPerMo.toFixed(0)}` : '\u2014',
            status: 'neutral',
            icon: <DollarSign className="w-4 h-4" />,
            trend: sum.cost.wastedPerMo > 0 ? -(sum.cost.wastedPerMo / Math.max(sum.cost.totalPerMo, 1) * 100) : undefined,
            trendLabel: sum.cost.wastedPerMo > 0 ? `$${sum.cost.wastedPerMo.toFixed(0)}/mo wasted` : 'no waste detected',
            tooltip: sum.cost.totalPerMo > 0 ? [
              { label: 'Total / mo',   value: `$${sum.cost.totalPerMo.toFixed(0)}`,                        color: 'neutral' as never },
              { label: 'Used',         value: `$${(sum.cost.totalPerMo - sum.cost.wastedPerMo).toFixed(0)}`, color: 'success' as never },
              { label: 'Wasted',       value: `$${sum.cost.wastedPerMo.toFixed(0)}`,                        color: (sum.cost.wastedPerMo > 0 ? 'danger' : 'success') as never, sub: `(${Math.round(sum.cost.wastedPerMo / Math.max(sum.cost.totalPerMo, 1) * 100)}% of total)` },
              { label: 'Projected',    value: sum.cost.projected > 0 ? `$${sum.cost.projected.toFixed(0)}/mo` : '\u2014', color: 'neutral' as never },
            ] : undefined,
          },
        ].map((kpi, i) => (
          <motion.div key={kpi.label} custom={i + 2} initial="hidden" animate="visible" variants={fadeUp}>
            <KPICard
              label={kpi.label}
              value={kpi.value}
              unit={kpi.unit}
              status={kpi.status as never}
              icon={kpi.icon}
              pulse={kpi.pulse}
              trend={kpi.trend}
              trendLabel={kpi.trendLabel}
              tooltip={kpi.tooltip}
            />
          </motion.div>
        ))}
      </div>

      {/* ── Live Metrics ── */}

      {/* Two large featured charts */}
      <div className="grid lg:grid-cols-2 gap-4">

        {/* CPU Usage */}
        <motion.div custom={9} initial="hidden" animate="visible" variants={fadeUp}
          className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-brand-400" />
              <span className="text-sm font-semibold text-white">CPU Usage</span>
              <span className={cn('text-xl font-bold tabular-nums ml-1',
                cm.cpuUsage > 80 ? 'text-danger' : cm.cpuUsage > 60 ? 'text-warning' : 'text-success')}>
                {cm.cpuUsage > 0 ? `${cm.cpuUsage.toFixed(1)}%` : '\u2014'}
              </span>
            </div>
            <Link href="/observability?tab=Metrics&metric=cpu" className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1 flex-shrink-0">
              Detail <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {cm.history.cpu.length > 0
            ? <MetricChart
                data={cm.history.cpu} label="" unit="%" height={200}
                color="#06b6d4" threshold={80}
                status={cm.cpuUsage > 80 ? 'critical' : cm.cpuUsage > 60 ? 'degraded' : 'healthy'}
              />
            : <div className="h-[200px] flex items-center justify-center text-surface-600 text-sm gap-2">
                <RefreshCw className="w-4 h-4 opacity-30" /> No history yet - waiting for data
              </div>
          }
          <div className="flex items-center justify-between mt-2 text-2xs text-surface-600">
            <span suppressHydrationWarning>{timeRange} ago</span>
            <span className="text-surface-700">{'\u00B7 \u00B7 \u00B7 80% threshold \u00B7 \u00B7 \u00B7'}</span>
            <span>now</span>
          </div>
        </motion.div>

        {/* Memory Usage */}
        <motion.div custom={10} initial="hidden" animate="visible" variants={fadeUp}
          className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MemoryStick className="w-4 h-4 text-brand-400" />
              <span className="text-sm font-semibold text-white">Memory Usage</span>
              <span className={cn('text-xl font-bold tabular-nums ml-1',
                cm.memoryUsage > 80 ? 'text-danger' : cm.memoryUsage > 60 ? 'text-warning' : 'text-success')}>
                {cm.memoryUsage > 0 ? `${cm.memoryUsage.toFixed(1)}%` : '\u2014'}
              </span>
            </div>
            <Link href="/observability?tab=Metrics&metric=memory" className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1 flex-shrink-0">
              Detail <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {cm.history.memory.length > 0
            ? <MetricChart
                data={cm.history.memory} label="" unit="%" height={200}
                color="#8b5cf6" threshold={80}
                status={cm.memoryUsage > 80 ? 'critical' : cm.memoryUsage > 60 ? 'degraded' : 'healthy'}
              />
            : <div className="h-[200px] flex items-center justify-center text-surface-600 text-sm gap-2">
                <RefreshCw className="w-4 h-4 opacity-30" /> No history yet - waiting for data
              </div>
          }
          <div className="flex items-center justify-between mt-2 text-2xs text-surface-600">
            <span suppressHydrationWarning>{timeRange} ago</span>
            <span className="text-surface-700">{'\u00B7 \u00B7 \u00B7 80% threshold \u00B7 \u00B7 \u00B7'}</span>
            <span>now</span>
          </div>
        </motion.div>
      </div>

      {/* Four secondary sparklines: Error Rate, Requests, p50, p99 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Error Rate',   metric: 'errors',   data: cm.history.errors,               cur: cm.errorRate,   unit: '%',    color: '#ef4444', warn: 1 },
          { label: 'Request Rate', metric: 'requests', data: cm.history.requests,             cur: cm.requestRate, unit: ' rps', color: '#22c55e', warn: -1 },
          { label: 'p50 Latency',  metric: 'latency',  data: (cm.history as any).latency ?? [], cur: cm.p50Latency,  unit: 'ms',  color: '#14b8a6', warn: 200 },
          { label: 'p99 Latency',  metric: 'latency',  data: (cm.history as any).latency ?? [], cur: cm.p99Latency,  unit: 'ms',  color: '#f97316', warn: 500 },
        ].map((m, i) => (
          <Link key={m.label} href={`/observability?tab=Metrics&metric=${m.metric}`} className="block group">
            <motion.div custom={11 + i} initial="hidden" animate="visible" variants={fadeUp}
              className="rounded-2xl bg-surface-900 border border-surface-800 p-3 group-hover:border-brand-500/50 group-hover:bg-surface-800 transition-colors cursor-pointer">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-surface-400 group-hover:text-brand-300 transition-colors truncate pr-1">{m.label}</span>
                <span className={cn('text-sm font-bold tabular-nums flex-shrink-0',
                  m.warn > 0 && m.cur > m.warn ? 'text-danger' :
                  m.warn > 0 && m.cur > m.warn * 0.75 ? 'text-warning' : 'text-success'
                )} suppressHydrationWarning>
                  {m.cur > 0 ? `${m.cur.toFixed(1)}${m.unit}` : '\u2014'}
                </span>
              </div>
              {m.data.length > 0
                ? <Sparkline data={m.data} height={52} color={m.color}
                    status={m.warn > 0 && m.cur > m.warn ? 'critical' : 'healthy'} unit={m.unit} />
                : <div className="h-[52px]" />
              }
            </motion.div>
          </Link>
        ))}
      </div>

      {/* ── DORA metrics row ── */}
      <motion.div custom={6} initial="hidden" animate="visible" variants={fadeUp}
        className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-brand-400" />
            <span className="text-sm font-semibold text-white">DORA Metrics</span>
            <span className="text-2xs text-surface-500 bg-surface-800 px-2 py-0.5 rounded-full" suppressHydrationWarning>last {timeRange}</span>
          </div>
            <Link href="/deployments" className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1">
            Deployments <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-surface-800">
          {[
            {
              label: 'Deploy Frequency',
              value: fmtFreq(sum.dora.deployFrequency7d),
              band: sum.dora.frequencyBand,
              sub: `${sum.dora.recentDeploys} deploys in ${timeRange}`,
              icon: <GitBranch className="w-4 h-4" />,
            },
            {
              label: 'Success Rate',
              value: `${sum.dora.successRate}%`,
              band: sum.dora.successRate >= 95 ? 'elite' : sum.dora.successRate >= 85 ? 'high' : 'medium',
              sub: `${sum.dora.recentDeploys} total deployments`,
              icon: <CheckCircle2 className="w-4 h-4" />,
            },
            {
              label: 'Change Failure Rate',
              value: `${sum.dora.changeFailureRate}%`,
              band: sum.dora.cfrBand,
              sub: 'deployments with unavailable pods',
              icon: <AlertTriangle className="w-4 h-4" />,
            },
            {
              label: 'MTTR',
              value: health.mttr > 0 ? `${health.mttr}m` : '\u2014',
              band: health.mttr > 0 && health.mttr < 60 ? 'elite' : 'medium',
              sub: 'mean time to recover',
              icon: <Clock className="w-4 h-4" />,
            },
          ].map(d => (
            <div key={d.label} className="px-5 py-3">
              <p className="text-2xs text-surface-500 font-medium uppercase tracking-wide mb-2">{d.label}</p>
              <p className={cn('text-lg font-bold tabular-nums', BAND_CLR[d.band] ?? 'text-white')}>{d.value}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={cn('text-2xs font-semibold capitalize px-1.5 py-0.5 rounded-full',
                  d.band === 'elite' ? 'bg-success/10 text-success' :
                  d.band === 'high'  ? 'bg-brand-500/10 text-brand-400' :
                  d.band === 'medium'? 'bg-warning/10 text-warning' :
                  'bg-danger/10 text-danger')}>
                  {d.band}
                </span>
                <span className="text-2xs text-surface-600" suppressHydrationWarning>{d.sub}</span>
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* ── Service health + Cluster panel ── */}
      <div className="grid lg:grid-cols-3 gap-4">

        {/* Service health at-a-glance grid */}
        <motion.div custom={7} initial="hidden" animate="visible" variants={fadeUp}
          className="lg:col-span-2 rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
            <div className="flex items-center gap-2 flex-wrap">
              <Server className="w-4 h-4 text-brand-400" />
              <span className="text-sm font-semibold text-white">Service Health</span>
              {services.length > 0 && (() => {
                const ok   = services.filter(s => s.status === 'healthy').length
                const warn = services.filter(s => s.status === 'degraded').length
                const crit = services.filter(s => s.status === 'critical').length
                return (
                  <div className="flex items-center gap-1">
                    {ok   > 0 && <span className="text-2xs px-1.5 py-0.5 rounded-full bg-success/10 text-success border border-success/20 font-medium">{ok} healthy</span>}
                    {warn > 0 && <span className="text-2xs px-1.5 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/20 font-medium">{warn} warn</span>}
                    {crit > 0 && <span className="text-2xs px-1.5 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/20 font-medium animate-pulse">{crit} critical</span>}
                  </div>
                )
              })()}
            </div>
            <Link href="/observability" className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1 flex-shrink-0">
              Full metrics <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {services.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-surface-500 text-sm gap-2">
              {sumLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Server className="w-4 h-4 opacity-30" />}
              {sumLoading ? 'Loading services…' : 'No service metrics available'}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3">
              {services.slice(0, 9).map(svc => {
                const isCrit = svc.status === 'critical'
                const isWarn = svc.status === 'degraded'
                // Surface the single most important signal for this service
                const signal =
                  svc.errorRate > 1   ? { label: `${svc.errorRate.toFixed(1)}% errors`,  color: 'text-danger' } :
                  svc.errorRate > 0   ? { label: `${svc.errorRate.toFixed(2)}% errors`,  color: 'text-warning' } :
                  svc.availability < 99.9 ? { label: `${svc.availability.toFixed(1)}% uptime`, color: 'text-warning' } :
                  svc.requestRate > 0 ? { label: `${svc.requestRate.toFixed(0)} rps`,     color: 'text-surface-400' } :
                  { label: 'No traffic', color: 'text-surface-600' }
                return (
                  <Link key={`${svc.namespace}/${svc.name}`}
                    href={`/observability?tab=Metrics&service=${encodeURIComponent(svc.name)}`}
                    className={cn(
                      'group rounded-xl border p-3 flex flex-col gap-1 transition-all hover:shadow-md',
                      isCrit ? 'border-danger/40 bg-danger/5 hover:bg-danger/10' :
                      isWarn ? 'border-warning/30 bg-warning/5 hover:bg-warning/10' :
                      'border-surface-800 bg-surface-800/40 hover:bg-surface-800',
                    )}>
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-xs font-semibold text-white leading-tight truncate group-hover:text-brand-300 transition-colors">{svc.name}</span>
                      <span className={cn('w-2 h-2 rounded-full flex-shrink-0 mt-0.5',
                        isCrit ? 'bg-danger animate-pulse' : isWarn ? 'bg-warning' : 'bg-success')} />
                    </div>
                    <span className="text-2xs text-surface-600 truncate">{svc.namespace}</span>
                    <span className={cn('text-xs font-medium tabular-nums mt-0.5', signal.color)}>{signal.label}</span>
                    <span className={cn(
                      'self-start text-2xs font-semibold px-1.5 py-0.5 rounded-full border mt-0.5',
                      isCrit ? 'text-danger bg-danger/10 border-danger/20' :
                      isWarn ? 'text-warning bg-warning/10 border-warning/20' :
                      'text-success bg-success/10 border-success/20',
                    )}>
                      {isCrit ? 'Critical' : isWarn ? 'Degraded' : 'Healthy'}
                    </span>
                  </Link>
                )
              })}
            </div>
          )}
        </motion.div>

        {/* Real cluster card */}
        <motion.div custom={8} initial="hidden" animate="visible" variants={fadeUp}
          className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
            <span className="text-sm font-semibold text-white">Cluster</span>
            <Link href="/kubernetes" className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1">
              Detail <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="p-4 space-y-4">
            {/* Cluster identity */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-bold text-white">{sum.cluster.name}</span>
                <span className={cn('text-2xs px-1.5 py-0.5 rounded-full font-medium border',
                  sum.cluster.healthyNodes === sum.cluster.nodeCount
                    ? 'text-success bg-success/10 border-success/20'
                    : 'text-warning bg-warning/10 border-warning/20')}>
                  {sum.cluster.healthyNodes}/{sum.cluster.nodeCount} nodes ready
                </span>
              </div>
              <p className="text-2xs text-surface-500">k8s {sum.cluster.version}</p>
            </div>

            {/* Pod counts */}
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: 'Pods',    value: sum.cluster.podCount,       color: 'text-white' },
                { label: 'Running', value: sum.cluster.runningPods,    color: 'text-success' },
                { label: 'Deploys', value: sum.cluster.deploymentCount, color: 'text-brand-400' },
              ].map(s => (
                <div key={s.label} className="bg-surface-800 rounded-xl py-2">
                  <p className={cn('text-base font-bold tabular-nums', s.color)}>{s.value}</p>
                  <p className="text-2xs text-surface-500 mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>

            {/* CPU bar */}
            <div className="space-y-2">
              {[
                { label: 'CPU', pct: sum.cost.cpuPct ?? 0 },
                { label: 'Memory', pct: sum.cost.memPct ?? 0 },
              ].map(r => (
                <div key={r.label}>
                  <div className="flex items-center justify-between text-2xs mb-1">
                    <span className="text-surface-500">{r.label}</span>
                    <span className={r.pct > 80 ? 'text-danger' : r.pct > 60 ? 'text-warning' : 'text-success'}>
                      {r.pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-800">
                    <div
                      className={cn('h-full rounded-full transition-all',
                        r.pct > 80 ? 'bg-danger' : r.pct > 60 ? 'bg-warning' : 'bg-brand-500')}
                      style={{ width: `${Math.min(100, r.pct)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Crash pods warning */}
            {sum.cluster.crashPods > 0 && (
              <div className="flex items-center gap-2 p-2.5 bg-danger/8 border border-danger/20 rounded-xl">
                <Flame className="w-3.5 h-3.5 text-danger flex-shrink-0" />
                <span className="text-xs text-danger">{sum.cluster.crashPods} pod{sum.cluster.crashPods !== 1 ? 's' : ''} CrashLoopBackOff</span>
              </div>
            )}

            {/* Cost KPI */}
            {sum.cost.totalPerMo > 0 && (
              <div className="flex items-center justify-between p-2.5 bg-surface-800/60 rounded-xl">
                <span className="text-xs text-surface-400">Est. compute cost</span>
                <span className="text-sm font-bold text-white">${sum.cost.totalPerMo.toFixed(0)}/mo</span>
              </div>
            )}
          </div>
        </motion.div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">

        {/* Active incidents (real) */}
        <motion.div custom={13} initial="hidden" animate="visible" variants={fadeUp}
          className="lg:col-span-2 rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
            <div className="flex items-center gap-2">
              <Siren className="w-4 h-4 text-danger" />
              <span className="text-sm font-semibold text-white">Active Incidents</span>
              {openInc.length > 0 && (
                <span className="bg-danger/20 text-danger text-2xs px-1.5 py-0.5 rounded-full border border-danger/30 font-bold">
                  {openInc.length}
                </span>
              )}
              {incLive && (
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              )}
            </div>
            <Link href="/incidents" className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1">
              All incidents <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-surface-800/50">
            {openInc.length === 0 ? (
              <div className="py-12 text-center">
                <CheckCircle2 className="w-8 h-8 text-success mx-auto mb-2 opacity-70" />
                <p className="text-sm text-surface-400">No active incidents</p>
                <p className="text-xs text-surface-600 mt-1">All systems nominal</p>
              </div>
            ) : (
              openInc.slice(0, 5).map(inc => (
                <Link key={inc.id} href={`/incidents/${inc.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-surface-800/60 cursor-pointer transition-colors group">
                  <span className={cn('w-1 self-stretch rounded-full flex-shrink-0',
                    inc.severity === 'critical' ? 'bg-danger' : inc.severity === 'high' ? 'bg-warning' : 'bg-blue-400')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-mono text-surface-500">{inc.id}</span>
                      <span className={cn('text-2xs px-1.5 py-0.5 rounded border capitalize font-medium', SEV_BADGE[inc.severity])}>{inc.severity}</span>
                      <span className={cn('text-2xs px-1.5 py-0.5 rounded border capitalize font-medium', STATE_CLR[inc.state])}>{inc.state}</span>
                    </div>
                    <p className="text-sm font-medium text-white mt-0.5 truncate">{inc.title}</p>
                    <div className="flex items-center gap-2 mt-0.5 text-2xs text-surface-500">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /><span suppressHydrationWarning>{fmtDur(inc.durationMinutes)}</span></span>
                      <span>{inc.service}</span>
                      {inc.alertCount > 0 && <span className="text-warning">{inc.alertCount} alerts</span>}
                    </div>
                  </div>
                  {inc.slaBreached && (
                    <span className="text-2xs px-1.5 py-0.5 rounded font-semibold text-white bg-danger flex-shrink-0">SLA BREACHED</span>
                  )}
                  <ChevronRight className="w-4 h-4 text-surface-600 group-hover:text-surface-400 flex-shrink-0 transition-colors" />
                </Link>
              ))
            )}
          </div>
        </motion.div>

        {/* System insights (real, computed) */}
        <motion.div custom={14} initial="hidden" animate="visible" variants={fadeUp}
          className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-brand-400" />
              <span className="text-sm font-semibold text-white">System Insights</span>
            </div>
            <span className="text-2xs px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-400 border border-brand-500/20 font-medium">auto-computed</span>
          </div>
          <div className="divide-y divide-surface-800/50">
            {sum.insights.length === 0 ? (
              <div className="py-8 text-center text-surface-500 text-sm">Loading insights…</div>
            ) : (
              sum.insights.map(ins => {
                const inner = (
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex-shrink-0">{INS_ICON[ins.type] ?? <Sparkles className="w-3.5 h-3.5 text-brand-400" />}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-white leading-snug">{ins.title}</p>
                      <p className="text-2xs text-surface-500 mt-0.5 leading-relaxed line-clamp-2">{ins.description}</p>
                    </div>
                    {ins.action && (
                      <ChevronRight className="w-3.5 h-3.5 text-surface-600 group-hover:text-surface-400 flex-shrink-0 mt-0.5 transition-colors" />
                    )}
                  </div>
                )
                return ins.action ? (
                  <Link key={ins.id} href={ins.action}
                    className="block px-4 py-3 hover:bg-surface-800/40 transition-colors group">
                    {inner}
                  </Link>
                ) : (
                  <div key={ins.id} className="px-4 py-3">
                    {inner}
                  </div>
                )
              })
            )}
          </div>
        </motion.div>
      </div>
    </div>
  )
}
