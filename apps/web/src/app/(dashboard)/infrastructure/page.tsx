'use client'

import React, { Fragment, useState, useMemo, useCallback, useEffect, useRef, Suspense } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Server, Cpu, MemoryStick, HardDrive, MapPin, Network,
  Activity, AlertTriangle, CheckCircle2, Database, ChevronDown,
  ChevronRight, Info, Wifi, Zap, Clock, Shield, RefreshCw, Plus, X, Siren, Box, Download,
  Lock, Unlock, FileCode2, FileSearch, Trash2, Tag, Layers, BarChart2, Globe, Bell, BellOff, Camera,
  RotateCcw, TrendingUp, Sliders, Play, Link2, Undo2, Package, Users, Loader2, ScrollText, ExternalLink, Maximize2, FileText,
} from 'lucide-react'
import type { Incident } from '@/types'
import { StatusDot } from '@/components/widgets/IncidentRow'
import { cn, formatNumber, exportCSV, timeAgo } from '@/lib/utils'
import type { K8sNode, NodeStorageDisk, PersistentVolume, PersistentVolumeClaim, StorageClass, K8sEvent, K8sPod } from '@/types'
import { useClusterNodes } from '@/hooks/useClusterNodes'
import { useLiveData } from '@/hooks/useLiveData'
import { useDashboardStore } from '@/store'
import { YamlViewer } from '@/components/k8s/YamlViewer'
import { DescribeViewer } from '@/components/k8s/DescribeViewer'

import { Sparkline, MiniBar } from '@/components/charts/Sparkline'
import { MetricChart, DualSeriesChart } from '@/components/charts/MetricChart'
import type { TimeSeriesPoint } from '@/types'

type InfraTab = 'Cluster Nodes' | 'Storage' | 'Network'
function LiveDot({ live }: { live: boolean }) {
  if (!live) return null
  return <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-success" /></span>
}


// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function pct(used: number, cap: number) {
  return cap > 0 ? Math.round((used / cap) * 100) : 0
}

function ageStr(ts?: string | null) {
  if (!ts) return '—'
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`
  return `${Math.floor(s / (86400 * 365))}y`
}

function UtilBar({ value, warn = 75, crit = 90, label, raw }: {
  value: number; warn?: number; crit?: number; label: string; raw?: string
}) {
  const color = value >= crit ? 'bg-danger' : value >= warn ? 'bg-warning' : 'bg-brand-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-2xs">
        <span className="text-surface-500">{label}</span>
        <span className={cn('font-semibold tabular-nums', value >= crit ? 'text-danger' : value >= warn ? 'text-warning' : 'text-surface-300')}>
          {raw ?? `${value}%`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-800">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  )
}

function ConditionBadge({ type, status }: { type: string; status: string }) {
  const active = status === 'True'
  const isReady = type === 'Ready'
  const isGood = isReady ? active : !active
  const isPressure = ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'].includes(type)
  const isAlert = isPressure && active
  return (
    <span className={cn(
      'text-2xs px-1.5 py-0.5 rounded-full border font-medium',
      isAlert
        ? 'bg-danger/20 text-danger border-danger/60 font-bold animate-pulse'
        : isGood
        ? 'bg-success/10 text-success border-success/20'
        : 'bg-danger/10 text-danger border-danger/30 font-bold',
    )}>
      {isAlert ? '! ' : ''}{type}
    </span>
  )
}

// â”€â”€ Node detail expand â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function NodeDetail({ node, pods, nm }: { node: K8sNode; pods: K8sPod[]; nm?: any }) {
  return (
    <tr>
      <td colSpan={11} className="px-6 py-4 bg-surface-950 border-b border-surface-800">
        <div className="grid grid-cols-3 gap-6">
          {/* Disk */}
          <div>
            <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5" /> Disk
            </p>
            <div className="space-y-3">
              {node.disks.map((d: NodeStorageDisk) => (
                <div key={`${d.device}:${d.mountPath}`} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono text-surface-300">{d.device}</span>
                    <span className="text-surface-500">{d.mountPath}</span>
                  </div>
                  <UtilBar
                    value={pct(d.usedGiB, d.capacityGiB)}
                    warn={75} crit={90}
                    label={`${d.usedGiB} / ${d.capacityGiB} GiB`}
                    raw={`${d.usedGiB} / ${d.capacityGiB} GiB`}
                  />
                  <div className="flex gap-4 text-2xs text-surface-500">
                    <span>R: {formatNumber(d.iopsRead)} IOPS</span>
                    <span>W: {formatNumber(d.iopsWrite)} IOPS</span>
                    <span className={(d.latencyMs ?? 0) > 5 ? 'text-danger font-semibold' : ''}>Lat: {(d.latencyMs ?? 0).toFixed(1)}ms</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Network */}
          <div>
            <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Network className="w-3.5 h-3.5" /> Network
            </p>
            <div className="space-y-2">
              <UtilBar
                value={pct((node.networkInMbps ?? 0) + (node.networkOutMbps ?? 0), node.networkBandwidthMbps ?? 1)}
                warn={70} crit={90}
                label="Bandwidth utilization"
                raw={`${Math.round(((node.networkInMbps ?? 0) + (node.networkOutMbps ?? 0)) / (node.networkBandwidthMbps ?? 1) * 100)}%`}
              />
              <div className="grid grid-cols-2 gap-2 pt-1">
                {[
                  { label: 'In', value: `${formatNumber(node.networkInMbps ?? 0)} Mbps` },
                  { label: 'Out', value: `${formatNumber(node.networkOutMbps ?? 0)} Mbps` },
                  { label: 'Capacity', value: `${formatNumber(node.networkBandwidthMbps ?? 0)} Mbps` },
                  { label: 'Pkt Drop', value: `${((node.packetDropRate ?? 0) * 100).toFixed(3)}%`, crit: (node.packetDropRate ?? 0) > 0.01 },
                ].map(s => (
                  <div key={s.label} className="text-2xs">
                    <span className="text-surface-500">{s.label}: </span>
                    <span className={cn('font-semibold', s.crit ? 'text-danger' : 'text-surface-300')}>{s.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* OS / Runtime / Taints */}
          <div className="space-y-4">
            <div>
              <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5" /> System
              </p>
              <div className="space-y-1.5 text-xs">
                {[
                  ['Instance', node.instanceType],
                  ['Kubelet', node.kubeletVersion],
                  ['OS', node.osImage],
                  ['Kernel', node.kernelVersion],
                  ['Runtime', node.containerRuntime],
                  ['Uptime', `${node.uptime}h`],
                  ['Pods', `${node.podCount} / ${node.podCapacity}`],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <span className="text-surface-500 flex-shrink-0">{k}</span>
                    <span className="text-surface-300 font-mono text-right truncate">{v}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* Conditions with transition time */}
            <div>
              <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Conditions
              </p>
              <div className="space-y-1">
                {node.conditions.map(c => {
                  const isReady = c.type === 'Ready'
                  const isGood = isReady ? c.status === 'True' : c.status === 'False'
                  const ago = Math.round((Date.now() - new Date(c.lastTransitionTime).getTime()) / 60000)
                  const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago/60)}h ago` : `${Math.round(ago/1440)}d ago`
                  return (
                    <div key={c.type} className="flex items-center justify-between text-2xs">
                      <span className={cn('font-medium', isGood ? 'text-success' : 'text-danger')}>{c.type}</span>
                      <span className="text-surface-600">{agoStr}</span>
                    </div>
                  )
                })}
              </div>
            </div>
            {/* Taints */}
            {node.taints.length > 0 && (
              <div>
                <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2">Taints</p>
                <div className="space-y-1">
                  {node.taints.map(t => (
                    <div key={t.key} className="text-2xs">
                      <span className="font-mono text-warning">{t.key}</span>
                      <span className="text-surface-600 ml-1">:{t.effect}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* GPU */}
            {nm?.gpuUtilPct != null && (
              <div>
                <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2">GPU</p>
                <UtilBar value={nm.gpuUtilPct} warn={75} crit={90} label="GPU Utilization" raw={`${nm.gpuUtilPct}%`} />
              </div>
            )}
          </div>
        </div>

        {/* Top Consumers */}
        {(nm?.topCpu?.length > 0 || nm?.topMem?.length > 0) && (
          <div className="mt-4 grid grid-cols-2 gap-6">
            {nm?.topCpu?.length > 0 && (
              <div>
                <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2">Top CPU Consumers</p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800">
                      <th className="px-2 py-1 text-left text-2xs font-semibold text-surface-600 uppercase">Pod</th>
                      <th className="px-2 py-1 text-left text-2xs font-semibold text-surface-600 uppercase">NS</th>
                      <th className="px-2 py-1 text-right text-2xs font-semibold text-surface-600 uppercase">CPU</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nm.topCpu.map((p: any, i: number) => (
                      <tr key={i} className="border-b border-surface-800/30">
                        <td className="px-2 py-1 font-mono text-2xs text-surface-200 truncate max-w-[160px]">{p.pod}</td>
                        <td className="px-2 py-1 text-2xs text-surface-500">{p.namespace}</td>
                        <td className="px-2 py-1 text-right text-2xs font-semibold text-warning tabular-nums">{p.valueFmt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {nm?.topMem?.length > 0 && (
              <div>
                <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2">Top Memory Consumers</p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800">
                      <th className="px-2 py-1 text-left text-2xs font-semibold text-surface-600 uppercase">Pod</th>
                      <th className="px-2 py-1 text-left text-2xs font-semibold text-surface-600 uppercase">NS</th>
                      <th className="px-2 py-1 text-right text-2xs font-semibold text-surface-600 uppercase">Mem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nm.topMem.map((p: any, i: number) => (
                      <tr key={i} className="border-b border-surface-800/30">
                        <td className="px-2 py-1 font-mono text-2xs text-surface-200 truncate max-w-[160px]">{p.pod}</td>
                        <td className="px-2 py-1 text-2xs text-surface-500">{p.namespace}</td>
                        <td className="px-2 py-1 text-right text-2xs font-semibold text-purple-400 tabular-nums">{p.valueFmt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Recent Evictions */}
        {nm?.recentEvictions?.length > 0 && (
          <div className="mt-4">
            <p className="text-2xs font-semibold text-danger uppercase tracking-wider mb-2">Evictions (last 1h)</p>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-800">
                  {['Pod', 'Namespace', 'Time', 'Reason'].map(h => (
                    <th key={h} className="px-2 py-1 text-left text-2xs font-semibold text-surface-600 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {nm.recentEvictions.map((ev: any, i: number) => {
                  const ago = Math.round((Date.now() - new Date(ev.time).getTime()) / 60000)
                  const agoStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`
                  return (
                    <tr key={i} className="border-b border-surface-800/30">
                      <td className="px-2 py-1 font-mono text-2xs text-danger">{ev.pod}</td>
                      <td className="px-2 py-1 text-2xs text-surface-500">{ev.namespace}</td>
                      <td className="px-2 py-1 text-2xs text-surface-500">{agoStr}</td>
                      <td className="px-2 py-1 text-2xs text-surface-400 truncate max-w-[300px]">{ev.message}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pods on this node */}
        <div className="mt-4">
          <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Box className="w-3.5 h-3.5" /> Pods
            <span className="font-normal text-surface-600">({pods.length})</span>
          </p>
          {pods.length === 0 ? (
            <p className="text-2xs text-surface-600">No pods scheduled on this node</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-800">
                  {['Name', 'Namespace', 'Status', 'Ready', 'Restarts', 'Age'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left text-2xs font-semibold text-surface-600 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pods.map(pod => {
                  const isRunning = pod.status === 'Running'
                  const isFailing = ['Failed', 'CrashLoopBackOff', 'Error', 'OOMKilled', 'Degraded'].includes(pod.status)
                  const isPending = pod.status === 'Pending'
                  const statusColor = isRunning ? 'text-success' : isFailing ? 'text-danger' : isPending ? 'text-warning' : 'text-surface-400'
                  const ago = Math.round((Date.now() - new Date(pod.age).getTime()) / 60000)
                  const ageStr = ago < 60 ? `${ago}m` : ago < 1440 ? `${Math.round(ago/60)}h` : `${Math.round(ago/1440)}d`
                  return (
                    <tr key={`${pod.namespace}/${pod.name}`} className="border-b border-surface-800/30 hover:bg-surface-800/20">
                      <td className="px-2 py-1.5 font-mono text-surface-200 text-2xs">{pod.name}</td>
                      <td className="px-2 py-1.5 text-surface-500 text-2xs">{pod.namespace}</td>
                      <td className="px-2 py-1.5">
                        <span className={cn('text-2xs font-semibold', statusColor)}>{pod.status}</span>
                      </td>
                      <td className="px-2 py-1.5 text-surface-400 text-2xs tabular-nums">{pod.ready}</td>
                      <td className="px-2 py-1.5 text-2xs tabular-nums">
                        <span className={pod.restarts > 5 ? 'text-warning font-semibold' : pod.restarts > 0 ? 'text-surface-400' : 'text-surface-600'}>{pod.restarts}</span>
                      </td>
                      <td className="px-2 py-1.5 text-surface-500 text-2xs">{ageStr}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </td>
    </tr>
  )
}

// â”€â”€ PV status badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function PVStatusBadge({ status }: { status: PersistentVolume['status'] }) {
  const map = {
    Bound:     'bg-success/10 text-success border-success/20',
    Available: 'bg-brand-500/10 text-brand-400 border-brand-500/20',
    Released:  'bg-warning/10 text-warning border-warning/30',
    Failed:    'bg-danger/10 text-danger border-danger/30',
  }
  return (
    <span className={cn('text-2xs px-2 py-0.5 rounded-full border font-semibold', map[status])}>
      {status}
    </span>
  )
}

// â”€â”€ Main page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function InfrastructurePage() {
  return (
    <Suspense fallback={null}>
      <InfrastructureInner />
    </Suspense>
  )
}

function InfrastructureInner() {
  const router = useRouter()
  const pathname = usePathname()
  const activeCluster = useDashboardStore(s => s.activeCluster)
  const timeRange = useDashboardStore(s => s.timeRange)

  // Convert global timeRange to minutes for APIs that accept ?window=
  const winMin = (() => {
    if (timeRange.endsWith('m')) return parseInt(timeRange)
    if (timeRange.endsWith('h')) return parseInt(timeRange) * 60
    if (timeRange.endsWith('d')) return parseInt(timeRange) * 1440
    return 60
  })()

  // Build cluster headers for all action fetch calls so they target the correct cluster
  const clusterHeaders = useCallback((): Record<string, string> => {
    if (!activeCluster) return {}
    return {
      'X-K8s-Url':          activeCluster.k8sUrl          || 'none',
      'X-Prom-Url':         activeCluster.promUrl         || 'none',
      'X-Alertmanager-Url': activeCluster.alertmanagerUrl || 'none',
      'X-Loki-Url':         activeCluster.lokiUrl         || 'none',
      'X-Jaeger-Url':       activeCluster.jaegerUrl       || 'none',
      'X-Grafana-Url':      activeCluster.grafanaUrl      || 'none',
    }
  }, [activeCluster])
  const searchParams = useSearchParams()
  const [activeTab, setActiveTab] = useState<InfraTab>(() => {
    const t = searchParams.get('tab')
    return (['Cluster Nodes','Storage','Network'] as string[]).includes(t ?? '') ? t as InfraTab : 'Cluster Nodes'
  })
  const [expandedNode, setExpandedNode] = useState<string | null>(null)

  // Node metric popup state
  type NodePopup = {
    nodeName: string
    metric: 'cpu' | 'memory'
    chartData: TimeSeriesPoint[]
    color: string
    unit: string
    drill: { ts: number; rows: { name: string; value: number; unit: string }[] | null; loading: boolean } | null
    drillWin: number
  }
  const [nodePopup, setNodePopup] = useState<NodePopup | null>(null)
  const pendingDrillFetch = useRef(false)

  // ── Per-Node Network popup ─────────────────────────────────────────────────
  type NetNodePopup = {
    nodeName: string
    chartData: { ts: number; a: number; b: number }[]
    drillWin: number
    drill: { ts: number; metric: 'network_rx' | 'network_tx'; rows: { name: string; value: number; unit: string }[] | null; loading: boolean } | null
  }
  const [netNodePopup, setNetNodePopup] = useState<NetNodePopup | null>(null)
  const [bwDrill, setBwDrill] = useState<{ ts: number; rows: { name: string; value: number; unit: string }[] | null; loading: boolean } | null>(null)
  // ── Database sparkline drill-down ─────────────────────────────────────────

  const [expandedDiskNodes, setExpandedDiskNodes] = useState<Set<string>>(new Set())
  const [pvFilter, setPvFilter] = useState<string>('all')
  const [createModal, setCreateModal] = useState<{ eventId: string; reason: string; namespace: string; message: string } | null>(null)
  const [createForm, setCreateForm] = useState({ title: '', severity: 'high' as 'critical' | 'high' | 'medium', owner: 'on-call@vynops.io' })
  const [createSuccess, setCreateSuccess] = useState<string | null>(null)
  const [yamlTarget, setYamlTarget] = useState<{ kind: string; namespace: string; name: string } | null>(null)
  const [describeTarget, setDescribeTarget] = useState<{ kind: string; namespace: string; name: string } | null>(null)
  const [cordoningNode, setCordoningNode] = useState<string | null>(null)
  const [drainingNode, setDrainingNode] = useState<string | null>(null)
  const [confirmDrainNode, setConfirmDrainNode] = useState<K8sNode | null>(null)
  const [drainResult, setDrainResult] = useState<{ evicted: number; failed: number } | null>(null)
  const [deletingPVC, setDeletingPVC] = useState<string | null>(null)
  const [confirmDeletePVC, setConfirmDeletePVC] = useState<{ namespace: string; name: string } | null>(null)
  const [resizePVC, setResizePVC] = useState<{ namespace: string; name: string; currentGi: number } | null>(null)
  const [resizeSizeInput, setResizeSizeInput] = useState<string>('')
  const [resizingPVC, setResizingPVC] = useState(false)
  const [eventTypeFilter, setEventTypeFilter] = useState<'all' | 'Warning' | 'Normal'>('all')
  const [eventNsFilter, setEventNsFilter] = useState<string>('all')
  const [eventSearch, setEventSearch] = useState<string>('')
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)

  // ── Network L5 ────────────────────────────────────────────────────────────
  const [netThresholds, setNetThresholds] = useState<{ bwSatPct: number; packetDropPct: number }>(() => {
    try { return JSON.parse(typeof window !== 'undefined' ? (localStorage.getItem('vynops-net-thresholds') ?? 'null') : 'null') ?? { bwSatPct: 70, packetDropPct: 0.5 } } catch { return { bwSatPct: 70, packetDropPct: 0.5 } }
  })
  const [showNetThresholds, setShowNetThresholds] = useState(false)
  const [netThresholdDraft, setNetThresholdDraft] = useState(netThresholds)

  // ── Cluster Nodes L5 ──────────────────────────────────────────────────────
  const [taintModal, setTaintModal] = useState<K8sNode | null>(null)
  const [editTaints, setEditTaints] = useState<{ key: string; value: string; effect: string }[]>([])
  const [savingTaints, setSavingTaints] = useState(false)
  const [labelModal, setLabelModal] = useState<K8sNode | null>(null)
  const [editLabels, setEditLabels] = useState<Record<string, string>>({})
  const [savingLabels, setSavingLabels] = useState(false)
  const [rollingRestartNode, setRollingRestartNode] = useState<string | null>(null)
  const [restartResult, setRestartResult] = useState<{ node: string; restarted: number; failed: number } | null>(null)
  const [confirmCordonNode, setConfirmCordonNode] = useState<K8sNode | null>(null)

  // ── Storage L5 ────────────────────────────────────────────────────────────
  const [createSCModal, setCreateSCModal] = useState(false)
  const [scForm, setScForm] = useState({ name: '', provisioner: '', reclaimPolicy: 'Delete', bindingMode: 'Immediate', allowExpansion: true, parameters: '', isDefault: false })
  const [creatingSC, setCreatingSC] = useState(false)
  const [createSnapshotPVC, setCreateSnapshotPVC] = useState<{ namespace: string; name: string } | null>(null)
  const [snapshotName, setSnapshotName] = useState('')
  const [creatingSnapshot, setCreatingSnapshot] = useState(false)
  const [deletingSnapshot, setDeletingSnapshot] = useState<string | null>(null)
  const [restoreSnapshotModal, setRestoreSnapshotModal] = useState<any | null>(null)
  const [restoreNewPvcName, setRestoreNewPvcName] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null)

  // ── Database L5 ───────────────────────────────────────────────────────────
  const [expandedIopsPod, setExpandedIopsPod] = useState<string | null>(null)

  // ── Storage I/O popup ─────────────────────────────────────────────────────
  type IoPopup = {
    pod: string
    namespace: string
    ioWin: number
    sparkRead: number[]; sparkWrite: number[]
    sparkReadMBs: number[]; sparkWriteMBs: number[]
    readIops: number; writeIops: number
    readMBs: number; writeMBs: number
  }
  const [ioPopup, setIoPopup] = useState<IoPopup | null>(null)
  const [ioDrill, setIoDrill] = useState<{ ts: number } | null>(null)

  // ── Events L5 ─────────────────────────────────────────────────────────────
  const [suppressionRules, setSuppressionRules] = useState<{ id: string; reason: string; namespace: string; durationMin: number; expiresAt: number }[]>(() => {
    try { return JSON.parse(typeof window !== 'undefined' ? (localStorage.getItem('vynops-event-suppressions') ?? '[]') : '[]') } catch { return [] }
  })
  const [showSuppressionModal, setShowSuppressionModal] = useState(false)
  const [newSupRule, setNewSupRule] = useState({ reason: '', namespace: 'all', durationMin: 60 })
  const [webhookUrl, setWebhookUrl] = useState<string>(() => typeof window !== 'undefined' ? (localStorage.getItem('vynops-webhook-url') ?? '') : '')
  const [showWebhookModal, setShowWebhookModal] = useState(false)
  const [webhookInput, setWebhookInput] = useState('')
  const [autoEscRules, setAutoEscRules] = useState<{ reason: string; minCount: number; severity: 'critical' | 'high' | 'medium' }[]>(() => {
    try { return JSON.parse(typeof window !== 'undefined' ? (localStorage.getItem('vynops-auto-esc') ?? '[]') : '[]') } catch { return [] }
  })
  const [showAutoEsc, setShowAutoEsc] = useState(false)
  const [newEscRule, setNewEscRule] = useState({ reason: '', minCount: 5, severity: 'high' as 'critical' | 'high' | 'medium' })
  const [eventSortCol, setEventSortCol] = useState<'count' | 'lastTime' | 'firstTime'>('count')
  const [eventSortDir, setEventSortDir] = useState<'asc' | 'desc'>('desc')

  const { nodes, loading: nodesLoading, isLive, refresh: refreshNodes, error: nodesError } = useClusterNodes([])

  const handleCordonNode = useCallback(async (node: K8sNode) => {
    setCordoningNode(node.name)
    await fetch(`/api/k8s/nodes/${encodeURIComponent(node.name)}/cordon`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...clusterHeaders() },
      body: JSON.stringify({ action: node.unschedulable ? 'uncordon' : 'cordon' }),
    }).catch(() => null)
    setCordoningNode(null)
    setTimeout(() => refreshNodes(), 1500)
  }, [refreshNodes, clusterHeaders])

  const handleDrainNode = useCallback(async (node: K8sNode) => {
    setDrainingNode(node.name)
    setConfirmDrainNode(null)
    try {
      const res = await fetch(`/api/k8s/nodes/${encodeURIComponent(node.name)}/drain`, { method: 'POST', headers: clusterHeaders() })
      const data = await res.json()
      if (data.ok) setDrainResult({ evicted: data.evicted ?? 0, failed: data.failed ?? 0 })
      setTimeout(() => { setDrainResult(null); refreshNodes() }, 3000)
    } catch { /* ignore */ }
    setDrainingNode(null)
  }, [refreshNodes, clusterHeaders])

  const handleDeletePVC = useCallback(async () => {
    if (!confirmDeletePVC) return
    setDeletingPVC(`${confirmDeletePVC.namespace}/${confirmDeletePVC.name}`)
    await fetch(`/api/k8s/storage/pvc/${encodeURIComponent(confirmDeletePVC.namespace)}/${encodeURIComponent(confirmDeletePVC.name)}/delete`, { method: 'DELETE', headers: clusterHeaders() }).catch(() => null)
    setDeletingPVC(null)
    setConfirmDeletePVC(null)
    // Refresh storage data
    window.dispatchEvent(new Event('vynops:refresh-storage'))
  }, [confirmDeletePVC, clusterHeaders])

  const handleResizePVC = useCallback(async () => {
    if (!resizePVC) return
    const newGi = parseFloat(resizeSizeInput)
    if (!newGi || newGi <= resizePVC.currentGi) return
    setResizingPVC(true)
    await fetch(
      `/api/k8s/storage/pvc/${encodeURIComponent(resizePVC.namespace)}/${encodeURIComponent(resizePVC.name)}/resize`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...clusterHeaders() }, body: JSON.stringify({ newSizeGi: newGi }) },
    ).catch(() => null)
    setResizingPVC(false)
    setResizePVC(null)
    window.dispatchEvent(new Event('vynops:refresh-storage'))
  }, [resizePVC, resizeSizeInput, clusterHeaders])

  // \u2500\u2500 L5 node callbacks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const handleRollingRestartNode = useCallback(async (node: K8sNode) => {
    setRollingRestartNode(node.name)
    try {
      const res = await fetch(`/api/k8s/nodes/${encodeURIComponent(node.name)}/rolling-restart`, { method: 'POST', headers: clusterHeaders() })
      const data = await res.json()
      if (data.ok) setRestartResult({ node: node.name, restarted: data.restarted ?? 0, failed: data.failed ?? 0 })
      setTimeout(() => { setRestartResult(null); refreshNodes() }, 4000)
    } catch { /* ignore */ }
    setRollingRestartNode(null)
  }, [refreshNodes, clusterHeaders])

  const handleSaveTaints = useCallback(async () => {
    if (!taintModal) return
    setSavingTaints(true)
    await fetch(`/api/k8s/nodes/${encodeURIComponent(taintModal.name)}/taints`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...clusterHeaders() },
      body: JSON.stringify({ taints: editTaints.filter(t => t.key.trim()) }),
    }).catch(() => null)
    setSavingTaints(false)
    setTaintModal(null)
    setTimeout(() => refreshNodes(), 1500)
  }, [taintModal, editTaints, refreshNodes, clusterHeaders])

  const handleSaveLabels = useCallback(async () => {
    if (!labelModal) return
    setSavingLabels(true)
    const labels: Record<string, string> = {}
    Object.entries(editLabels).forEach(([k, v]) => { if (k.trim()) labels[k.trim()] = v })
    await fetch(`/api/k8s/nodes/${encodeURIComponent(labelModal.name)}/labels`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...clusterHeaders() },
      body: JSON.stringify({ labels }),
    }).catch(() => null)
    setSavingLabels(false)
    setLabelModal(null)
    setTimeout(() => refreshNodes(), 1500)
  }, [labelModal, editLabels, refreshNodes, clusterHeaders])

  // \u2500\u2500 L5 storage callbacks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const handleCreateSC = useCallback(async () => {
    if (!scForm.name.trim() || !scForm.provisioner.trim()) return
    setCreatingSC(true)
    await fetch('/api/k8s/storage/classes', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...clusterHeaders() },
      body: JSON.stringify(scForm),
    }).catch(() => null)
    setCreatingSC(false)
    setCreateSCModal(false)
    window.dispatchEvent(new Event('vynops:refresh-storage'))
  }, [scForm, clusterHeaders])

  const handleCreateSnapshot = useCallback(async () => {
    if (!createSnapshotPVC || !snapshotName.trim()) return
    setCreatingSnapshot(true)
    await fetch('/api/k8s/storage/snapshots', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...clusterHeaders() },
      body: JSON.stringify({ name: snapshotName.trim(), namespace: createSnapshotPVC.namespace, pvcName: createSnapshotPVC.name }),
    }).catch(() => null)
    setCreatingSnapshot(false)
    setCreateSnapshotPVC(null)
    setSnapshotName('')
  }, [createSnapshotPVC, snapshotName, clusterHeaders])

  const handleRestoreSnapshot = useCallback(async () => {
    if (!restoreSnapshotModal || !restoreNewPvcName.trim()) return
    setRestoring(true)
    try {
      const res = await fetch('/api/k8s/storage/snapshots/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...clusterHeaders() },
        body: JSON.stringify({
          snapshotName: restoreSnapshotModal.name,
          namespace: restoreSnapshotModal.namespace,
          newPvcName: restoreNewPvcName.trim(),
          sizeGi: restoreSnapshotModal.restoreSize
            ? parseFloat(String(restoreSnapshotModal.restoreSize).replace(/[^0-9.]/g, '')) || 1
            : 1,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setRestoreSuccess(data.name)
        setTimeout(() => { setRestoreSnapshotModal(null); setRestoreSuccess(null); setRestoreNewPvcName('') }, 2000)
      }
    } catch { /* ignore */ }
    setRestoring(false)
  }, [restoreSnapshotModal, restoreNewPvcName, clusterHeaders])

  // \u2500\u2500 L5 database callbacks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // \u2500\u2500 L5 events callbacks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const handleAddSuppressionRule = useCallback(() => {
    if (!newSupRule.reason.trim()) return
    const rule = { id: Math.random().toString(36).slice(2), ...newSupRule, expiresAt: Date.now() + newSupRule.durationMin * 60000 }
    const updated = [...suppressionRules, rule]
    setSuppressionRules(updated)
    if (typeof window !== 'undefined') localStorage.setItem('vynops-event-suppressions', JSON.stringify(updated))
    setNewSupRule({ reason: '', namespace: 'all', durationMin: 60 })
  }, [newSupRule, suppressionRules])

  const handleRemoveSuppressionRule = useCallback((id: string) => {
    const updated = suppressionRules.filter(r => r.id !== id)
    setSuppressionRules(updated)
    if (typeof window !== 'undefined') localStorage.setItem('vynops-event-suppressions', JSON.stringify(updated))
  }, [suppressionRules])

  const handleSaveWebhook = useCallback(() => {
    setWebhookUrl(webhookInput)
    if (typeof window !== 'undefined') localStorage.setItem('vynops-webhook-url', webhookInput)
    setShowWebhookModal(false)
  }, [webhookInput])

  const handleSaveNetThresholds = useCallback(() => {
    setNetThresholds(netThresholdDraft)
    if (typeof window !== 'undefined') localStorage.setItem('vynops-net-thresholds', JSON.stringify(netThresholdDraft))
    setShowNetThresholds(false)
  }, [netThresholdDraft])

  const handleAddAutoEscRule = useCallback(() => {
    if (!newEscRule.reason.trim()) return
    const updated = [...autoEscRules, { ...newEscRule }]
    setAutoEscRules(updated)
    if (typeof window !== 'undefined') localStorage.setItem('vynops-auto-esc', JSON.stringify(updated))
    setNewEscRule({ reason: '', minCount: 5, severity: 'high' })
  }, [newEscRule, autoEscRules])

  const handleTriggerWebhook = useCallback(async (evt: K8sEvent) => {
    if (!webhookUrl) return
    fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: evt.reason, message: evt.message, namespace: evt.involvedObject.namespace, count: evt.count, lastTime: evt.lastTime, source: (evt as any).sourceComponent }),
    }).catch(() => null)
  }, [webhookUrl])

  const { data: storageData, isLive: storageLive, loading: storageFetching } = useLiveData(
    '/api/k8s/storage',
    { pvs: [] as PersistentVolume[], storageclasses: [] as StorageClass[], pvcs: [] as PersistentVolumeClaim[], orphanedPVs: [] as any[], orphanedConfigMaps: [] as any[], orphanedSecrets: [] as any[], summary: null as any },
    (r) => ({ pvs: r.pvs ?? [], storageclasses: r.storageclasses ?? [], pvcs: r.pvcs ?? [], orphanedPVs: r.orphanedPVs ?? [], orphanedConfigMaps: r.orphanedConfigMaps ?? [], orphanedSecrets: r.orphanedSecrets ?? [], summary: r.summary ?? null }),
  )
  const pvs: PersistentVolume[] = storageData.pvs
  const storageclasses: StorageClass[] = storageData.storageclasses
  const pvcs: PersistentVolumeClaim[] = storageData.pvcs
  const orphanedPVs: any[] = storageData.orphanedPVs
  const orphanedConfigMaps: any[] = storageData.orphanedConfigMaps
  const orphanedSecrets: any[] = storageData.orphanedSecrets
  const storageSummary = storageData.summary

  // Node sparklines + predictive headroom (Prometheus data, capped at 1h for readability)
  const sparkWin = Math.min(winMin, 60)
  const sparkWinLabel = sparkWin >= 60 ? '1h' : `${sparkWin}m`
  const { data: nodeMetrics } = useLiveData(
    `/api/k8s/nodes/metrics?window=${sparkWin}`,
    { nodes: [] as any[] },
    (r) => ({ nodes: r.nodes ?? [] }),
  )
  const nodeMetricsMap: Record<string, any> = Object.fromEntries(
    (nodeMetrics.nodes ?? []).map((n: any) => [n.name, n])
  )

  const { data: eventsData, isLive: eventsLive } = useLiveData(
    '/api/k8s/events',
    { events: [] as K8sEvent[], anomalies: [] as any[], correlatedGroups: [] as any[], summary: null as any },
    (r) => ({ events: r.events ?? [], anomalies: r.anomalies ?? [], correlatedGroups: r.correlatedGroups ?? [], summary: r.summary ?? null }),
  )
  const k8sEvents: K8sEvent[] = eventsData.events
  const eventAnomalies: any[] = eventsData.anomalies
  const correlatedGroups: any[] = eventsData.correlatedGroups
  const eventSummary = eventsData.summary

  const { data: networkData, isLive: networkLive } = useLiveData(
    `/api/k8s/network?window=${winMin}`,
    { nodes: [] as any[], coreDNS: null as any, services: [] as any[], dnsByType: {} as Record<string, number>, tcpStates: null as any, ingressMetrics: [] as any[], nsBandwidth: [] as any[], bwHistory: null as any, retinaMetrics: null as any },
    (r) => ({ nodes: r.nodes ?? [], coreDNS: r.coreDNS ?? null, services: r.services ?? [], dnsByType: r.dnsByType ?? {}, tcpStates: r.tcpStates ?? null, ingressMetrics: r.ingressMetrics ?? [], nsBandwidth: r.nsBandwidth ?? [], bwHistory: r.bwHistory ?? null, retinaMetrics: r.retinaMetrics ?? null }),
  )
  const { data: latencyData } = useLiveData(
    '/api/k8s/network/latency',
    { available: false as boolean, nodes: [] as string[], matrix: [] as (number | null)[][], okMatrix: [] as boolean[][], stats: { maxLatency: 0, avgLatency: 0, failCount: 0, nodeCount: 0 } },
    (r) => ({ available: r.available ?? false, nodes: r.nodes ?? [], matrix: r.matrix ?? [], okMatrix: r.okMatrix ?? [], stats: r.stats ?? { maxLatency: 0, avgLatency: 0, failCount: 0, nodeCount: 0 } }),
    10000,
  )
  const { data: endpointHealthData } = useLiveData(
    '/api/k8s/network/endpoints',
    { services: [] as any[], stats: { total: 0, healthy: 0, degraded: 0, down: 0 } },
    (r) => ({ services: r.services ?? [], stats: r.stats ?? { total: 0, healthy: 0, degraded: 0, down: 0 } }),
  )
  const { data: netPolData } = useLiveData(
    '/api/k8s/networkpolicies',
    { networkPolicies: [] as any[] },
    (r) => ({ networkPolicies: r.networkPolicies ?? [] }),
  )
  const { data: netSecData } = useLiveData(
    '/api/k8s/network/security',
    { networkPolicyGaps: [] as any[], tlsCerts: [] as any[], serviceMesh: { istio: false, linkerd: false, cilium: false, hubble: false, none: true }, egressByPod: [] as any[], egressByNs: [] as any[] },
    (r) => ({
      networkPolicyGaps: r.networkPolicyGaps ?? [],
      tlsCerts: r.tlsCerts ?? [],
      serviceMesh: r.serviceMesh ?? { istio: false, linkerd: false, cilium: false, hubble: false, none: true },
      egressByPod: r.egressByPod ?? [],
      egressByNs: r.egressByNs ?? [],
    }),
  )
  // Merge network metrics into nodes
  const nodesWithNetwork = nodes.map(n => {
    const net = networkData.nodes.find((x: { name: string }) => x.name === n.name)
    return net ? { ...n, ...net } : n
  })

  const { data: podsData } = useLiveData(
    '/api/k8s/pods',
    { podsByNode: {} as Record<string, K8sPod[]> },
    (r) => ({ podsByNode: r.podsByNode ?? {} }),
  )

  // L5: VolumeSnapshots
  const { data: snapshotsData } = useLiveData(
    '/api/k8s/storage/snapshots',
    { snapshots: [] as any[], crdAvailable: false },
    (r) => ({ snapshots: r.snapshots ?? [], crdAvailable: r.crdAvailable ?? false }),
  )
  // L5: PVC usage trends from Prometheus
  const { data: pvcTrendsData } = useLiveData(
    '/api/k8s/storage/pvc-trends',
    { trends: {} as Record<string, any> },
    (r) => ({ trends: r.trends ?? {} }),
  )

  const { data: iopsData } = useLiveData(
    '/api/k8s/storage-iops',
    { pvcs: [] as any[] },
    (r) => ({ pvcs: r.pvcs ?? [] }),
  )

  const { data: clusterMeta } = useLiveData(
    '/api/k8s/cluster',
    { id: '—', name: '—', provider: '—', region: '—', version: '—', namespaceCount: 0 },
    (r) => ({ id: r.id ?? '—', name: r.name ?? '—', provider: r.provider ?? '—', region: r.region ?? '—', version: r.version ?? '—', namespaceCount: r.namespaceCount ?? 0 }),
  )

  const handleCreateIncident = useCallback(async () => {
    if (!createModal || !createForm.title.trim()) return
    try {
      const r = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:       createForm.title.trim(),
          severity:    createForm.severity,
          description: createModal.message,
          owner:       createForm.owner,
          service:     createModal.namespace || 'unknown',
          environment: 'production',
          labels:      { namespace: createModal.namespace, reason: createModal.reason },
        }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Failed to create incident')
      setCreateSuccess(data.id ?? data.incident?.id ?? 'created')
    } catch (e: any) {
      setCreateSuccess('error:' + (e.message ?? 'Unknown error'))
    }
    setTimeout(() => {
      setCreateModal(null)
      setCreateSuccess(null)
      setCreateForm({ title: '', severity: 'high', owner: 'on-call@vynops.io' })
    }, 1800)
  }, [createModal, createForm])

  const filteredPVs = useMemo(() =>
    pvFilter === 'all' ? pvs : pvs.filter(p => p.status === pvFilter),
    [pvs, pvFilter]
  )

  const eventNamespaces = useMemo(() => {
    const ns = new Set(k8sEvents.map(e => e.involvedObject?.namespace ?? '').filter(Boolean))
    return ['all', ...Array.from(ns).sort()]
  }, [k8sEvents])

  const filteredEvents = useMemo(() => {
    const now = Date.now()
    const activeSuppressions = suppressionRules.filter(r => r.expiresAt > now)
    return k8sEvents
      .filter(e => eventTypeFilter === 'all' || e.type === eventTypeFilter)
      .filter(e => eventNsFilter === 'all' || (e.involvedObject?.namespace ?? '') === eventNsFilter)
      .filter(e => !eventSearch || [e.reason, e.message, e.involvedObject?.name ?? ''].join(' ').toLowerCase().includes(eventSearch.toLowerCase()))
      .filter(e => !activeSuppressions.some(s =>
        e.reason.toLowerCase().includes(s.reason.toLowerCase()) &&
        (s.namespace === 'all' || (e.involvedObject?.namespace ?? '') === s.namespace)
      ))
      .sort((a, b) => {
        if (eventSortCol === 'count') return eventSortDir === 'desc' ? b.count - a.count : a.count - b.count
        if (eventSortCol === 'lastTime') {
          const ta = new Date(a.lastTime).getTime(); const tb = new Date(b.lastTime).getTime()
          return eventSortDir === 'desc' ? tb - ta : ta - tb
        }
        const fa = new Date((a as any).firstTime ?? a.lastTime).getTime()
        const fb = new Date((b as any).firstTime ?? b.lastTime).getTime()
        return eventSortDir === 'desc' ? fb - fa : fa - fb
      })
  }, [k8sEvents, eventTypeFilter, eventNsFilter, eventSearch, suppressionRules, eventSortCol, eventSortDir])

  // L5: Event frequency per reason (for mini-sparklines)
  const eventFreqByReason = useMemo(() => {
    const map: Record<string, number> = {}
    for (const e of k8sEvents) {
      map[e.reason] = (map[e.reason] ?? 0) + e.count
    }
    return map
  }, [k8sEvents])
  const maxEventFreq = useMemo(() => Math.max(1, ...Object.values(eventFreqByReason)), [eventFreqByReason])

  // L5: Auto-escalation — check if any rule fires
  const autoEscalations = useMemo(() =>
    autoEscRules
      .map(rule => {
        const matching = k8sEvents.filter(e =>
          e.type === 'Warning' &&
          e.reason.toLowerCase().includes(rule.reason.toLowerCase()) &&
          e.count >= rule.minCount
        )
        return matching.length > 0 ? { rule, events: matching } : null
      })
      .filter(Boolean) as { rule: typeof autoEscRules[0]; events: K8sEvent[] }[]
  , [k8sEvents, autoEscRules])

  const totalDiskGiB = nodes.reduce((a, n) => a + n.disks.reduce((b, d) => b + d.capacityGiB, 0), 0)
  const usedDiskGiB = nodes.reduce((a, n) => a + n.disks.reduce((b, d) => b + d.usedGiB, 0), 0)
  const totalNetIn = nodesWithNetwork.reduce((a, n) => a + (n.networkInMbps ?? 0), 0)
  const totalNetOut = nodesWithNetwork.reduce((a, n) => a + (n.networkOutMbps ?? 0), 0)
  const unhealthyNodes = nodes.filter(n => n.status !== 'Ready').length

  // Real cluster aggregates (nodes API returns flat cpu/memory fields)
  const anyNodes = nodes as any[]
  const totalCpuCores = Math.round(anyNodes.reduce((a: number, n: any) => a + (n.cpuCapacity ?? 0), 0))
  const usedCpuCores  = Math.round(anyNodes.reduce((a: number, n: any) => a + (n.cpuUsed ?? 0), 0) * 10) / 10
  const totalMemGi    = Math.round(anyNodes.reduce((a: number, n: any) => a + (n.memoryCapacity ?? 0), 0) * 10) / 10
  const usedMemGi     = Math.round(anyNodes.reduce((a: number, n: any) => a + (n.memoryUsed ?? 0), 0) * 10) / 10
  const totalPods     = anyNodes.reduce((a: number, n: any) => a + (n.podCount ?? n.pods?.running ?? 0), 0)
  const clusterHealthStatus = unhealthyNodes === 0 ? 'healthy' : unhealthyNodes < nodes.length ? 'degraded' : 'critical'

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Server className="w-5 h-5 text-brand-400" /> Infrastructure
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">
            {nodes.length} nodes {'\u00B7'} 1 cluster
            {unhealthyNodes > 0 && <span className="text-danger ml-2">{'\u00B7'} {unhealthyNodes} unhealthy</span>}
            {isLive && <span className="text-success ml-2">{'\u00B7'} live data</span>}
            {nodesLoading && <span className="text-surface-400 ml-2">{'\u00B7'} refreshing{'\u2026'}</span>}
          </p>
        </div>
        {isLive && (
          <button onClick={refreshNodes} className="text-xs text-surface-400 hover:text-white flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        )}
        {nodesError && (
          <span className="flex items-center gap-1.5 px-2.5 py-1 bg-warning/5 border border-warning/20 rounded-xl text-xs text-warning/80">
            <AlertTriangle className="w-3 h-3" /> {nodesError}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-6">

        {/* Cluster card — real data */}
        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl bg-surface-900 border border-surface-800 p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white truncate">{clusterMeta.name}</span>
              <StatusDot status={clusterHealthStatus as any} />
            </div>
            <div className="flex items-center justify-between text-2xs text-surface-500">
              <span>{clusterMeta.provider.toUpperCase()} · {clusterMeta.region}</span>
              <span className="text-surface-600">{clusterMeta.version}</span>
            </div>
            <div className="space-y-2">
              <UtilBar value={pct(usedCpuCores, totalCpuCores)} label="CPU" raw={`${usedCpuCores} / ${totalCpuCores} cores`} />
              <UtilBar value={pct(usedMemGi, totalMemGi)} label="Memory" raw={`${usedMemGi} / ${totalMemGi} GiB`} warn={80} crit={90} />
              <UtilBar value={pct(usedDiskGiB, totalDiskGiB)} label="Storage" raw={`${Math.round(usedDiskGiB)} / ${Math.round(totalDiskGiB)} GiB`} warn={70} crit={85} />
            </div>
            <div className="grid grid-cols-3 gap-1 pt-1 text-center border-t border-surface-800">
              {[
                { label: 'Nodes', value: nodes.length },
                { label: 'Pods',  value: totalPods },
                { label: 'NS',    value: clusterMeta.namespaceCount },
              ].map(s => (
                <div key={s.label}>
                  <div className="text-sm font-bold text-white">{s.value}</div>
                  <div className="text-2xs text-surface-500">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-2xs text-surface-500 pt-1 border-t border-surface-800">
              <span className="flex items-center gap-1"><Wifi className="w-3 h-3" />↓ {totalNetIn.toFixed(2)} Mbps</span>
              <span>↑ {totalNetOut.toFixed(2)} Mbps</span>
            </div>
          </motion.div>
        </div>

        {/* Summary KPI strip */}
        <div className="grid grid-cols-4 gap-px bg-surface-800 rounded-2xl overflow-hidden border border-surface-800">
          {[
            { icon: Cpu,         label: 'Total CPU',    value: `${usedCpuCores} / ${totalCpuCores} cores`,      pct: pct(usedCpuCores, totalCpuCores) },
            { icon: MemoryStick, label: 'Total Memory', value: `${usedMemGi} / ${totalMemGi} GiB`,              pct: pct(usedMemGi, totalMemGi) },
            { icon: HardDrive, label: 'Total Disk',   value: `${usedDiskGiB.toFixed(2)} / ${totalDiskGiB.toFixed(2)} GiB`, pct: pct(usedDiskGiB, totalDiskGiB) },
            { icon: Network,   label: 'Total Network',value: `\u2193 ${totalNetIn.toFixed(2)} \u2191 ${totalNetOut.toFixed(2)} Mbps`, pct: null },
          ].map(k => {
            const Icon = k.icon
            return (
              <div key={k.label} className="bg-surface-950 px-4 py-3 flex items-center gap-3">
                <Icon className="w-8 h-8 text-brand-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-surface-500">{k.label}</div>
                  <div className="text-sm font-bold text-white truncate">{k.value}</div>
                  {k.pct !== null && (
                    <div className="h-1 rounded-full bg-surface-800 mt-1">
                      <div
                        className={cn('h-full rounded-full', k.pct >= 90 ? 'bg-danger' : k.pct >= 75 ? 'bg-warning' : 'bg-brand-500')}
                        style={{ width: `${k.pct}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-surface-800">
          {([
            { tab: 'Cluster Nodes', live: isLive },
            { tab: 'Storage',       live: storageLive },
            { tab: 'Network',       live: networkLive },
          ] as { tab: InfraTab; live: boolean }[]).map(({ tab: t, live }) => (
            <button
              key={t}
              onClick={() => { setActiveTab(t); router.replace(`${pathname}?tab=${encodeURIComponent(t)}`, { scroll: false }) }}
              className={cn(
                'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5',
                activeTab === t
                  ? 'text-brand-400 border-brand-500'
                  : 'text-surface-400 border-transparent hover:text-surface-300',
              )}
            >
              {t}
              {live && <LiveDot live />}
            </button>
          ))}
        </div>

        {/* â”€â”€ CLUSTER NODES TAB â”€â”€ */}
        {activeTab === 'Cluster Nodes' && (
          <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-800 bg-surface-950">
                  {['', 'Node', 'Status', 'Role', 'Instance', `CPU (${sparkWinLabel})`, `Memory (${sparkWinLabel})`, 'Disk', 'Pods', 'Conditions'].map((h, i) => (
                    <th key={h || i} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {nodes.map(node => {
                  const isExpanded = expandedNode === node.name
                  const cpuPct = pct(node.cpuUsed, node.cpuCapacity)
                  const memPct = pct(node.memoryUsed, node.memoryCapacity)
                  const primaryDisk = node.disks[0]
                  const diskPct = primaryDisk ? pct(primaryDisk.usedGiB, primaryDisk.capacityGiB) : 0
                  const hasAlert = node.status !== 'Ready' || cpuPct >= 90 || memPct >= 90 || diskPct >= 90
                  const nm = nodeMetricsMap[node.name]
                  const trendIcon = (t: string) => t === 'rising' ? '↑' : t === 'falling' ? '↓' : '→'
                  const trendColor = (t: string) => t === 'rising' ? 'text-danger' : t === 'falling' ? 'text-success' : 'text-surface-500'

                  return (
                    <React.Fragment key={node.name}>
                      <tr
                        onClick={() => setExpandedNode(isExpanded ? null : node.name)}
                        className={cn(
                          'border-b border-surface-800/50 cursor-pointer transition-colors',
                          hasAlert ? 'bg-danger/5 hover:bg-danger/10' : 'hover:bg-surface-800/40',
                        )}
                      >
                        <td className="px-3 py-2.5">
                          <ChevronRight className={cn('w-3.5 h-3.5 text-surface-600 transition-transform', isExpanded && 'rotate-90')} />
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-white">
                          <div className="flex flex-col gap-0.5">
                            <span>{node.name}</span>
                            {node.unschedulable && (
                              <span className="text-2xs text-warning font-semibold">CORDONED</span>
                            )}
                            {node.conditions.some(c => ['MemoryPressure', 'DiskPressure', 'PIDPressure'].includes(c.type) && c.status === 'True') && (
                              <span className="text-2xs text-danger font-semibold animate-pulse">PRESSURE</span>
                            )}
                            {(() => {
                              const userLabels = Object.entries(node.labels ?? {})
                                .filter(([k]) => !k.includes('kubernetes.io') && !k.includes('k8s.io') && !k.includes('beta.kubernetes'))
                                .slice(0, 2)
                              return userLabels.length > 0 ? (
                                <div className="flex flex-wrap gap-0.5 mt-0.5">
                                  {userLabels.map(([k, v]) => (
                                    <span key={k} className="text-2xs bg-brand-500/10 text-brand-400 border border-brand-500/20 px-1 rounded font-sans">
                                      {k}={v}
                                    </span>
                                  ))}
                                </div>
                              ) : null
                            })()}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusDot status={node.status === 'Ready' ? 'healthy' : 'critical'} />
                        </td>
                        <td className="px-3 py-2.5 text-surface-400 text-xs capitalize">{node.role}</td>
                        <td className="px-3 py-2.5 text-surface-400 text-xs font-mono">{node.instanceType}</td>
                        <td className="px-3 py-2.5 min-w-[160px]">
                          <div className="space-y-0.5">
                            <div className="flex justify-between items-center text-2xs">
                              <span className={cn('font-semibold tabular-nums', cpuPct >= 90 ? 'text-danger' : cpuPct >= 75 ? 'text-warning' : 'text-surface-400')}>
                                {nm ? `${nm.currentCpuPct}%` : `${cpuPct}%`}
                                {nm?.cpuTrend && <span className={cn('ml-1', trendColor(nm.cpuTrend))}>{trendIcon(nm.cpuTrend)}</span>}
                              </span>
                              {nm?.cpuHoursTo90 !== null && nm?.cpuHoursTo90 !== undefined && (
                                <span className="text-warning text-2xs font-semibold">⚠ ~{nm.cpuHoursTo90}h→90%</span>
                              )}
                            </div>
                            {nm?.sparkCpu?.length > 0 ? (
                              <button
                                title="Click to expand CPU chart"
                                onClick={e => { e.stopPropagation(); const now = Date.now(); const winMs = sparkWin*60*1000; const step = winMs/(nm.sparkCpu.length-1||1); setNodePopup({ nodeName: node.name, metric: 'cpu', chartData: nm.sparkCpu.map((v: number, i: number) => ({ ts: Math.round(now - winMs + i*step), value: v })), color: cpuPct>=90?'#ef4444':cpuPct>=75?'#f59e0b':'#22c55e', unit: '%', drill: null, drillWin: sparkWin }) }}
                                className="block hover:opacity-80 transition-opacity cursor-zoom-in"
                              >
                                <Sparkline data={nm.sparkCpu} color={cpuPct >= 90 ? '#ef4444' : cpuPct >= 75 ? '#f59e0b' : '#22c55e'} width={120} height={20} />
                              </button>
                            ) : (
                              <div className="h-1 rounded-full bg-surface-800">
                                <div className={cn('h-full rounded-full', cpuPct >= 90 ? 'bg-danger' : cpuPct >= 75 ? 'bg-warning' : 'bg-brand-500')} style={{ width: `${cpuPct}%` }} />
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 min-w-[160px]">
                          <div className="space-y-0.5">
                            <div className="flex justify-between items-center text-2xs">
                              <span className={cn('font-semibold tabular-nums', memPct >= 90 ? 'text-danger' : memPct >= 80 ? 'text-warning' : 'text-surface-400')}>
                                {nm ? `${nm.currentMemPct.toFixed(0)}%` : `${memPct}%`}
                                {nm?.memTrend && <span className={cn('ml-1', trendColor(nm.memTrend))}>{trendIcon(nm.memTrend)}</span>}
                              </span>
                              {nm?.memHoursTo90 !== null && nm?.memHoursTo90 !== undefined && (
                                <span className="text-warning text-2xs font-semibold">⚠ ~{nm.memHoursTo90}h→90%</span>
                              )}
                            </div>
                            {nm?.sparkMem?.length > 0 ? (
                              <button
                                title="Click to expand Memory chart"
                                onClick={e => { e.stopPropagation(); const now = Date.now(); const winMs = sparkWin*60*1000; const step = winMs/(nm.sparkMem.length-1||1); setNodePopup({ nodeName: node.name, metric: 'memory', chartData: nm.sparkMem.map((v: number, i: number) => ({ ts: Math.round(now - winMs + i*step), value: v })), color: memPct>=90?'#ef4444':memPct>=80?'#f59e0b':'#a855f7', unit: '%', drill: null, drillWin: sparkWin }) }}
                                className="block hover:opacity-80 transition-opacity cursor-zoom-in"
                              >
                                <Sparkline data={nm.sparkMem} color={memPct >= 90 ? '#ef4444' : memPct >= 80 ? '#f59e0b' : '#a855f7'} width={120} height={20} />
                              </button>
                            ) : (
                              <div className="h-1 rounded-full bg-surface-800">
                                <div className={cn('h-full rounded-full', memPct >= 90 ? 'bg-danger' : memPct >= 80 ? 'bg-warning' : 'bg-purple-500')} style={{ width: `${memPct}%` }} />
                              </div>
                            )}
                            {nm && <div className="text-2xs text-surface-600 mt-0.5">{nm.memUsedGiB}/{nm.memTotalGiB} GiB</div>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 min-w-[100px]">
                          {primaryDisk && (
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-2xs">
                                <span className={cn('font-semibold tabular-nums', diskPct >= 90 ? 'text-danger' : diskPct >= 75 ? 'text-warning' : 'text-surface-400')}>
                                  {diskPct}%
                                </span>
                                <span className="text-surface-600">{primaryDisk.usedGiB}/{primaryDisk.capacityGiB}G</span>
                              </div>
                              <div className="h-1 rounded-full bg-surface-800">
                                <div className={cn('h-full rounded-full', diskPct >= 90 ? 'bg-danger' : diskPct >= 75 ? 'bg-warning' : 'bg-amber-500')} style={{ width: `${diskPct}%` }} />
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-surface-400 text-xs tabular-nums">{node.podCount}/{node.podCapacity}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {node.conditions.map(cond => (
                              <ConditionBadge key={cond.type} type={cond.type} status={cond.status} />
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => node.unschedulable ? handleCordonNode(node) : setConfirmCordonNode(node)} disabled={cordoningNode === node.name}
                              title={node.unschedulable ? 'Uncordon' : 'Cordon'}
                              className={cn('p-1.5 rounded-lg transition-all disabled:opacity-40 text-xs',
                                node.unschedulable ? 'text-warning bg-warning/10 hover:bg-warning/20' : 'text-surface-500 hover:text-warning hover:bg-warning/10'
                              )}>
                              {node.unschedulable ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              onClick={() => setConfirmDrainNode(node)}
                              disabled={!!drainingNode || drainingNode === node.name}
                              title="Drain node (cordon + evict all pods)"
                              className="p-1.5 rounded-lg text-surface-600 hover:text-danger hover:bg-danger/10 transition-all disabled:opacity-40">
                              <Download className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => { setRollingRestartNode(null); handleRollingRestartNode(node) }}
                              disabled={!!rollingRestartNode}
                              title="Rolling restart — delete non-DaemonSet pods; K8s reschedules them"
                              className="p-1.5 rounded-lg text-surface-600 hover:text-warning hover:bg-warning/10 transition-all disabled:opacity-40">
                              <RotateCcw className={cn('w-3.5 h-3.5', rollingRestartNode === node.name && 'animate-spin')} />
                            </button>
                            <button
                              onClick={() => { setEditTaints((node.taints ?? []).map(t => ({ key: t.key, value: t.value ?? '', effect: t.effect }))); setTaintModal(node) }}
                              title="Manage taints"
                              className="p-1.5 rounded-lg text-surface-600 hover:text-purple-400 hover:bg-purple-500/10 transition-all">
                              <Layers className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => { setEditLabels({ ...(node as any).labels ?? {} }); setLabelModal(node) }}
                              title="Edit labels"
                              className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all">
                              <Tag className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setDescribeTarget({ kind: 'Node', namespace: '', name: node.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-amber-400 hover:bg-amber-400/10 transition-all" title="Describe"><FileSearch className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setYamlTarget({ kind: 'Node', namespace: '', name: node.name })}
                              className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all" title="YAML">
                              <FileCode2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && <NodeDetail key={`${node.name}-detail`} node={node} pods={podsData.podsByNode[node.name] ?? []} nm={nm} />}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}


        {/* ── Resource Efficiency + Version Drift + Zone Balance ── */}
        {activeTab === 'Cluster Nodes' && nodes.length > 0 && (() => {
          const kernels  = new Set((nodes as any[]).map((n: any) => (n.kernelVersion  ?? '')).filter(Boolean))
          const oses     = new Set((nodes as any[]).map((n: any) => (n.osImage        ?? '')).filter(Boolean))
          const kubelets = new Set((nodes as any[]).map((n: any) => (n.kubeletVersion ?? '')).filter(Boolean))
          const hasDrift = kernels.size > 1 || oses.size > 1 || kubelets.size > 1
          const zones: Record<string, { nodes: number; pods: number }> = {}
          for (const node of nodes as any[]) {
            const z = (node.zone ?? node.nodeZone ?? 'unknown') as string
            if (!zones[z]) zones[z] = { nodes: 0, pods: 0 }
            zones[z].nodes++
            zones[z].pods += (podsData.podsByNode[node.name] ?? []).length
          }
          const zoneEntries = Object.entries(zones)
          const maxPods = Math.max(...zoneEntries.map(([, v]) => v.pods), 1)
          const totalZonePods = zoneEntries.reduce((a, [, v]) => a + v.pods, 0)
          const imbalanced = zoneEntries.length > 1 && zoneEntries.some(([, v]) => totalZonePods > 0 && Math.abs(v.pods / totalZonePods - 1 / zoneEntries.length) > 0.2)
          return (
            <div className="space-y-4 mt-4">
              <div className={cn('rounded-2xl bg-surface-900 border p-4', hasDrift ? 'border-warning/40' : 'border-surface-800')}>
                <div className="flex items-center gap-2 mb-3">
                  <Layers className="w-4 h-4 text-amber-400" />
                  <span className="text-sm font-semibold text-white">Version Distribution</span>
                  {hasDrift
                    ? <span className="text-2xs px-2 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/30 font-semibold animate-pulse">DRIFT DETECTED</span>
                    : <span className="text-2xs px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20 font-semibold">Uniform</span>}
                </div>
                <div className="grid grid-cols-3 gap-4">
                  {([
                    { label: 'Kubelet',  values: kubelets },
                    { label: 'Kernel',   values: kernels  },
                    { label: 'OS Image', values: oses     },
                  ] as { label: string; values: Set<string> }[]).map(({ label, values }) => (
                    <div key={label}>
                      <div className="text-2xs text-surface-500 font-semibold uppercase tracking-wider mb-1.5">{label}</div>
                      {values.size === 0
                        ? <span className="text-2xs text-surface-600 italic">no data</span>
                        : Array.from(values).map(v => (
                          <div key={v} className={cn('text-xs font-mono', values.size > 1 ? 'text-warning' : 'text-success')}>{v}</div>
                        ))
                      }
                      {values.size > 1 && <div className="text-2xs text-warning font-semibold mt-0.5">{values.size} distinct</div>}
                    </div>
                  ))}
                </div>
              </div>
              {zoneEntries.length >= 2 && (
                <div className={cn('rounded-2xl bg-surface-900 border p-4', imbalanced ? 'border-warning/40' : 'border-surface-800')}>
                  <div className="flex items-center gap-2 mb-3">
                    <Globe className="w-4 h-4 text-brand-400" />
                    <span className="text-sm font-semibold text-white">Multi-AZ Zone Balance</span>
                    {imbalanced
                      ? <span className="text-2xs px-2 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/30 font-semibold animate-pulse">IMBALANCED</span>
                      : <span className="text-2xs px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20 font-semibold">Balanced</span>}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {zoneEntries.map(([zone, { nodes: nc, pods: pc }]) => (
                      <div key={zone} className="bg-surface-800/50 rounded-xl px-3 py-2">
                        <div className="text-xs font-semibold text-white mb-1">{zone}</div>
                        <div className="text-2xs text-surface-500 mb-2">{nc} node{nc !== 1 ? 's' : ''} · {pc} pods</div>
                        <div className="w-full h-1.5 rounded-full bg-surface-700">
                          <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.round((pc / maxPods) * 100)}%` }} />
                        </div>
                        <div className="text-2xs text-surface-500 mt-1">{totalZonePods > 0 ? Math.round((pc / totalZonePods) * 100) : 0}%</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {totalCpuCores > 0 && (
                <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <BarChart2 className="w-4 h-4 text-cyan-400" />
                    <span className="text-sm font-semibold text-white">Resource Efficiency</span>
                    <span className="text-2xs text-surface-500 ml-1">actual usage vs capacity</span>
                  </div>
                  <div className="grid grid-cols-2 gap-6">
                    {([
                      { label: 'CPU',    total: totalCpuCores, used: usedCpuCores, unit: 'cores', color: 'bg-brand-500' },
                      { label: 'Memory', total: totalMemGi,    used: usedMemGi,    unit: 'GiB',   color: 'bg-purple-500' },
                    ] as { label: string; total: number; used: number; unit: string; color: string }[]).map(({ label, total, used, unit, color }) => {
                      const usePct = total > 0 ? Math.round((used / total) * 100) : 0
                      return (
                        <div key={label}>
                          <div className="text-2xs text-surface-500 font-semibold uppercase tracking-wider mb-2">{label}</div>
                          <div className="flex items-center gap-3 mb-1">
                            <div className="flex-1 h-2 rounded-full bg-surface-800">
                              <div className={cn('h-full rounded-full', color)} style={{ width: `${usePct}%` }} />
                            </div>
                            <span className={cn('text-sm font-bold tabular-nums', usePct > 85 ? 'text-danger' : usePct > 70 ? 'text-warning' : 'text-success')}>{usePct}%</span>
                          </div>
                          <div className="text-2xs text-surface-500">{used.toFixed(1)} / {total.toFixed(1)} {unit} used</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })()}

        {/* STORAGE TAB */}
        {activeTab === 'Storage' && (
          <div className="space-y-4">
            {/* Connecting banner — shown while initial storage fetch is in progress */}
            {storageFetching && pvs.length === 0 && (
              <div className="rounded-xl border border-surface-700 bg-surface-800/50 px-4 py-3 flex items-center gap-3">
                <RefreshCw className="w-4 h-4 text-brand-400 animate-spin flex-shrink-0" />
                <span className="text-sm text-surface-300">Connecting to K8s API — fetching storage data…</span>
              </div>
            )}
            {/* Orphaned PV alert banner */}
            {orphanedPVs.length > 0 && (
              <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 flex items-center gap-3">
                <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />
                <span className="text-sm text-warning font-semibold">
                  {orphanedPVs.length} orphaned PV{orphanedPVs.length !== 1 ? 's' : ''} detected — wasting {storageSummary?.orphanedWasteGiB?.toFixed(1) ?? '?'} GiB of storage
                </span>
                <span className="text-xs text-surface-400 ml-2">
                  ({orphanedPVs.map((p: any) => p.name).slice(0, 3).join(', ')}{orphanedPVs.length > 3 ? ` +${orphanedPVs.length - 3} more` : ''})
                </span>
              </div>
            )}
            {storageSummary?.pvcNearFull > 0 && (
              <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 flex items-center gap-3">
                <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0" />
                <span className="text-sm text-danger font-semibold">
                  {storageSummary.pvcNearFull} PVC{storageSummary.pvcNearFull !== 1 ? 's' : ''} above 80% disk usage — action required
                </span>
              </div>
            )}
            {/* PV/PVC summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: 'Total PVs', value: pvs.length, color: 'text-white' },
                { label: 'Bound', value: storageSummary?.boundCount ?? pvs.filter(p => p.status === 'Bound').length, color: 'text-success' },
                { label: 'Orphaned PVs', value: storageSummary?.orphanedCount ?? 0, color: 'text-warning' },
                { label: 'Total Capacity', value: `${(storageSummary?.totalCapacityGiB ?? pvs.reduce((a, p) => a + p.capacityGiB, 0)).toLocaleString()} GiB`, color: 'text-brand-400' },
              ].map(k => (
                <div key={k.label} className="rounded-2xl bg-surface-900 border border-surface-800 px-4 py-3">
                  <div className={cn('text-2xl font-bold', k.color)} suppressHydrationWarning>{k.value}</div>
                  <div className="text-xs text-surface-500 mt-0.5">{k.label}</div>
                </div>
              ))}
            </div>

            {/* Node disk utilization */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center justify-between">
                <span className="text-sm font-semibold text-white flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-brand-400" /> Node Disk Utilization
                </span>
                <span className="text-2xs text-surface-500">{nodes.length} node{nodes.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="divide-y divide-surface-800/40">
                {nodes.map(node => {
                  const isCollapsed = !expandedDiskNodes.has(node.name)
                  const maxPct = node.disks.length > 0 ? Math.max(...node.disks.map(d => pct(d.usedGiB, d.capacityGiB))) : 0
                  const totalUsedGiB = Math.round(node.disks.reduce((a, d) => a + d.usedGiB, 0) * 10) / 10
                  const totalCapGiB = Math.round(node.disks.reduce((a, d) => a + d.capacityGiB, 0) * 10) / 10
                  return (
                    <div key={node.name}>
                      {/* Node header — click to collapse/expand */}
                      <button
                        onClick={() => setExpandedDiskNodes(prev => {
                          const next = new Set(prev)
                          if (next.has(node.name)) next.delete(node.name); else next.add(node.name)
                          return next
                        })}
                        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-surface-800/30 transition-colors text-left"
                      >
                        <ChevronRight className={cn('w-3.5 h-3.5 text-surface-500 transition-transform flex-shrink-0', !isCollapsed && 'rotate-90')} />
                        <span className="text-xs font-mono text-white">{node.name}</span>
                        <span className={cn('text-2xs px-1.5 py-0.5 rounded-full border font-medium flex-shrink-0',
                          node.role === 'control-plane' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' : 'bg-brand-500/10 text-brand-400 border-brand-500/20'
                        )}>{node.role}</span>
                        <div className="ml-auto flex items-center gap-4">
                          {node.disks.length > 0 ? (
                            <>
                              <span className="text-2xs text-surface-500">{node.disks.length} disk{node.disks.length !== 1 ? 's' : ''}</span>
                              <span className="text-2xs text-surface-500 tabular-nums">{totalUsedGiB} / {totalCapGiB} GiB</span>
                              <span className={cn('text-2xs font-semibold tabular-nums', maxPct >= 90 ? 'text-danger' : maxPct >= 75 ? 'text-warning' : 'text-surface-400')}>
                                max {maxPct}%
                              </span>
                              <div className="w-16 h-1.5 rounded-full bg-surface-800">
                                <div className={cn('h-full rounded-full', maxPct >= 90 ? 'bg-danger' : maxPct >= 75 ? 'bg-warning' : 'bg-amber-500')} style={{ width: `${maxPct}%` }} />
                              </div>
                            </>
                          ) : (
                            <span className="text-2xs text-surface-600 italic">no disk data</span>
                          )}
                        </div>
                      </button>

                      {/* Disk rows */}
                      {!isCollapsed && (
                        <div className="border-t border-surface-800/30 bg-surface-950/30">
                          {node.disks.length === 0 ? (
                            <div className="px-4 py-2.5">
                              <span className="text-2xs text-surface-600 italic">No filesystem data from Prometheus</span>
                            </div>
                          ) : (
                            <>
                              {/* Column headers */}
                              <div className="grid grid-cols-[28px_180px_1fr_140px_160px_80px] gap-3 px-4 py-1.5 border-b border-surface-800/20 text-2xs text-surface-600 font-semibold uppercase tracking-wider">
                                <span />
                                <span>Device · Mount</span>
                                <span>Usage</span>
                                <span className="text-right">Used / Capacity</span>
                                <span className="text-right">Read / Write IOPS</span>
                                <span className="text-right">Latency</span>
                              </div>
                              {node.disks.map(disk => {
                                const dp = pct(disk.usedGiB, disk.capacityGiB)
                                return (
                                  <div key={`${disk.device}:${disk.mountPath}`} className="grid grid-cols-[28px_180px_1fr_140px_160px_80px] items-center gap-3 px-4 py-2.5 border-b border-surface-800/10 hover:bg-surface-800/20 transition-colors last:border-0">
                                    <HardDrive className={cn('w-3 h-3 flex-shrink-0', dp >= 90 ? 'text-danger' : dp >= 75 ? 'text-warning' : 'text-surface-500')} />
                                    <div className="min-w-0">
                                      <div className="font-mono text-surface-300 text-xs truncate">{disk.device}</div>
                                      <div className="text-2xs text-surface-600 truncate">{disk.mountPath}</div>
                                    </div>
                                    <div className="space-y-0.5 min-w-0">
                                      <div className="h-1.5 rounded-full bg-surface-800">
                                        <div className={cn('h-full rounded-full', dp >= 90 ? 'bg-danger' : dp >= 75 ? 'bg-warning' : 'bg-amber-500/70')} style={{ width: `${dp}%` }} />
                                      </div>
                                      <div className="text-2xs text-surface-600 tabular-nums">{dp}%</div>
                                    </div>
                                    <span className={cn('tabular-nums text-right text-xs', dp >= 90 ? 'text-danger font-bold' : dp >= 75 ? 'text-warning' : 'text-surface-400')}>
                                      {disk.usedGiB} / {disk.capacityGiB} GiB
                                    </span>
                                    <span className="text-surface-500 text-right text-2xs tabular-nums">
                                      ↑ {formatNumber(disk.iopsRead ?? 0)} / ↓ {formatNumber(disk.iopsWrite ?? 0)}
                                    </span>
                                    <span className={cn('text-right text-xs tabular-nums', (disk.latencyMs ?? 0) > 5 ? 'text-danger font-bold' : 'text-surface-500')}>
                                      {(disk.latencyMs ?? 0).toFixed(1)}ms
                                    </span>
                                  </div>
                                )
                              })}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* StorageClass table */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-brand-400" />
                <span className="text-sm font-semibold text-white">Storage Classes</span>
                <span className="text-2xs text-surface-500 ml-1">({storageclasses.length})</span>
                <button
                  onClick={() => setCreateSCModal(true)}
                  className="ml-auto flex items-center gap-1 text-2xs px-2.5 py-1 rounded-lg bg-brand-500/10 text-brand-400 border border-brand-500/20 hover:bg-brand-500/20 transition-all"
                ><Plus className="w-3 h-3" /> New StorageClass</button>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-800 bg-surface-950">
                    {['Name', 'Provisioner', 'Reclaim Policy', 'Binding Mode', 'Allow Expand', 'PVs', 'Provisioned GiB', 'Used GiB', 'Parameters', ''].map((h, i) => (
                      <th key={h || i} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {storageclasses.length === 0 && (
                    <tr><td colSpan={10} className="px-4 py-6 text-center text-surface-600 text-xs italic">
                      {storageFetching ? 'Loading storage classes…' : 'No storage classes found'}
                    </td></tr>
                  )}
                  {storageclasses.map(sc => {
                    const scPVs = pvs.filter(p => p.storageClass === sc.name)
                    const provisionedGiB = Math.round(scPVs.reduce((a, p) => a + p.capacityGiB, 0) * 10) / 10
                    const usedGiB = Math.round(scPVs.reduce((a, p) => a + (p.usedGiB ?? 0), 0) * 10) / 10
                    return (
                    <tr key={sc.name} className="border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors">
                      <td className="px-3 py-2.5 font-mono text-white">
                        <div className="flex items-center gap-2">
                          {sc.name}
                          {sc.isDefault && <span className="text-2xs px-1.5 py-0.5 rounded-full bg-brand-500/20 text-brand-400 border border-brand-500/30 font-semibold">default</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-surface-400 font-mono">{sc.provisioner}</td>
                      <td className="px-3 py-2.5">
                        <span className={cn('text-2xs px-1.5 py-0.5 rounded border font-medium',
                          sc.reclaimPolicy === 'Retain' ? 'bg-brand-500/10 text-brand-400 border-brand-500/20' : 'bg-surface-700 text-surface-400 border-surface-600'
                        )}>{sc.reclaimPolicy}</span>
                      </td>
                      <td className="px-3 py-2.5 text-surface-500">{sc.volumeBindingMode}</td>
                      <td className="px-3 py-2.5">
                        {sc.allowVolumeExpansion
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                          : <span className="text-surface-600 text-xs">{'\u2013'}</span>}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-surface-400">
                        {scPVs.length || <span className="text-surface-600">{'\u2013'}</span>}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {provisionedGiB > 0
                          ? <span className="text-surface-300 font-semibold">{provisionedGiB} <span className="text-surface-600 font-normal">GiB</span></span>
                          : <span className="text-surface-600">{'\u2013'}</span>}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {usedGiB > 0
                          ? <span className={cn('font-semibold', provisionedGiB > 0 && usedGiB / provisionedGiB > 0.85 ? 'text-warning' : 'text-surface-400')}>
                              {usedGiB} GiB{provisionedGiB > 0 && <span className="text-surface-600 font-normal ml-1">({Math.round(usedGiB / provisionedGiB * 100)}%)</span>}
                            </span>
                          : <span className="text-surface-600">{'\u2013'}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-surface-500 font-mono max-w-xs truncate">
                        {sc.parameters ? Object.entries(sc.parameters).map(([k, v]) => `${k}=${v}`).join(', ') : <span className="text-surface-600">{'\u2013'}</span>}
                      </td>
                      <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setDescribeTarget({ kind: 'StorageClass', namespace: '', name: sc.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-amber-400 hover:bg-amber-400/10 transition-all" title="Describe"><FileSearch className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setYamlTarget({ kind: 'StorageClass', namespace: '', name: sc.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all" title="YAML"><FileCode2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
              </div>
            </div>

            {/* PV table */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center justify-between">
                <span className="text-sm font-semibold text-white flex items-center gap-2">
                  <Database className="w-4 h-4 text-brand-400" /> Persistent Volumes
                  {storageLive && <LiveDot live />}
                  <span className="text-2xs text-surface-500 font-normal ml-1">live from K8s API</span>
                </span>
                <div className="flex gap-1">
                  {(['all', 'Bound', 'Released', 'Available'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setPvFilter(f)}
                      className={cn(
                        'text-2xs px-2.5 py-1 rounded-lg font-medium transition-all',
                        pvFilter === f ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30' : 'text-surface-400 hover:bg-surface-800',
                      )}
                    >{f} {f === 'all' ? `(${pvs.length})` : `(${pvs.filter(p => p.status === f).length})`}</button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-800 bg-surface-950">
                    {['Name', 'Status', 'Capacity', 'Used', 'Storage Class', 'Access Mode', 'Reclaim', 'Mode', 'Provisioner', 'Claim', 'Age', ''].map((h, i) => (
                      <th key={h || i} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredPVs.length === 0 && (
                    <tr><td colSpan={12} className="px-4 py-6 text-center text-surface-600 text-xs italic">
                      {storageFetching ? 'Loading persistent volumes…' : 'No persistent volumes found'}
                    </td></tr>
                  )}
                  {filteredPVs.map(pv => {
                    const up = pct(pv.usedGiB, pv.capacityGiB)
                    return (
                      <tr key={pv.name} className={cn('border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors', up >= 90 ? 'bg-danger/5' : up >= 80 ? 'bg-warning/5' : '')}>
                        <td className="px-3 py-2.5 font-mono text-white">{pv.name}</td>
                        <td className="px-3 py-2.5"><PVStatusBadge status={pv.status} /></td>
                        <td className="px-3 py-2.5 tabular-nums text-surface-400">{pv.capacityGiB} GiB</td>
                        <td className="px-3 py-2.5">
                          {pv.usedGiB > 0 ? (
                            <span className={cn('tabular-nums font-semibold', up >= 90 ? 'text-danger' : up >= 80 ? 'text-warning' : 'text-surface-400')}>
                              {pv.usedGiB} GiB ({up}%)
                            </span>
                          ) : <span className="text-surface-600">–</span>}
                        </td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono">{pv.storageClass}</td>
                        <td className="px-3 py-2.5 text-surface-500">{pv.accessMode}</td>
                        <td className="px-3 py-2.5">
                          <span className={cn('text-2xs px-1.5 py-0.5 rounded border font-medium',
                            pv.reclaimPolicy === 'Retain' ? 'bg-brand-500/10 text-brand-400 border-brand-500/20' : 'bg-surface-700 text-surface-400 border-surface-600'
                          )}>{pv.reclaimPolicy}</span>
                        </td>
                        <td className="px-3 py-2.5 text-surface-500 text-xs">{pv.volumeMode}</td>
                        <td className="px-3 py-2.5 text-surface-500 font-mono">{pv.provisioner}</td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono">{(pv as any).claimRef ?? <span className="text-surface-600">–</span>}</td>
                        <td className="px-3 py-2.5 tabular-nums text-surface-600" suppressHydrationWarning>{ageStr((pv as any).createdAt)}</td>
                        <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setDescribeTarget({ kind: 'PersistentVolume', namespace: '', name: pv.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-amber-400 hover:bg-amber-400/10 transition-all" title="Describe"><FileSearch className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setYamlTarget({ kind: 'PersistentVolume', namespace: '', name: pv.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all" title="YAML"><FileCode2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>

            {/* PVC table */}
            {pvcs.length > 0 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-brand-400" />
                  <span className="text-sm font-semibold text-white">Persistent Volume Claims</span>
                  <span className="text-2xs text-surface-500 ml-1">({pvcs.length})</span>
                  <span className="ml-auto text-2xs text-surface-500">
                    {pvcs.filter(p => p.status === 'Bound').length} Bound {'\u00B7'} {pvcs.filter(p => p.status === 'Pending').length} Pending {'\u00B7'} {pvcs.filter(p => p.status === 'Lost').length} Lost
                  </span>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800 bg-surface-950">
                      {['Name', 'Namespace', 'Status', 'Volume', 'Capacity', 'Used / Trend', 'Inodes', 'Pods', 'Storage Class', 'Access Mode', 'Mode', 'Forecast', 'Age', ''].map((h, i, arr) => (
                        <th key={h || i} className={cn('px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider', i === arr.length - 1 && 'sticky right-0 bg-surface-950 z-10')}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pvcs.map(pvc => {
                      const usedPct = (pvc as any).usedPct as number | undefined
                      const usedGiB = (pvc as any).usedGiB as number | undefined
                      const hasLive = (pvc as any).hasLiveMetrics as boolean | undefined
                      const nearFull = usedPct !== undefined && usedPct >= 80
                      const pvcKey = `${pvc.namespace}/${pvc.name}`
                      const trend = pvcTrendsData.trends[pvcKey]
                      const daysToFull = trend?.daysToFull
                      return (
                        <tr key={pvcKey} className={cn('border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors', nearFull && 'bg-danger/5')}>
                          <td className="px-3 py-2.5 font-mono text-white">{pvc.name}</td>
                          <td className="px-3 py-2.5 text-surface-400 font-mono">{pvc.namespace}</td>
                          <td className="px-3 py-2.5"><PVStatusBadge status={pvc.status as any} /></td>
                          <td className="px-3 py-2.5 text-surface-400 font-mono">{pvc.volumeName ?? <span className="text-surface-600">–</span>}</td>
                          <td className="px-3 py-2.5 tabular-nums text-surface-400">{pvc.capacityGiB > 0 ? `${pvc.capacityGiB} GiB` : <span className="text-surface-600">–</span>}</td>
                          <td className="px-3 py-2.5 min-w-[140px]">
                            {(trend?.points?.length ?? 0) > 1 ? (
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                  <Sparkline data={trend.points} color={trend.usedPct >= 90 ? '#ef4444' : trend.usedPct >= 80 ? '#f59e0b' : '#22c55e'} width={80} height={18} />
                                  <span className={cn('text-2xs font-semibold tabular-nums', trend.usedPct >= 90 ? 'text-danger' : trend.usedPct >= 80 ? 'text-warning' : 'text-surface-400')}>{trend.usedPct}%</span>
                                </div>
                              </div>
                            ) : hasLive && usedPct !== undefined ? (
                              <div className="space-y-0.5">
                                <div className="flex justify-between text-2xs">
                                  <span className={cn('font-semibold tabular-nums', usedPct >= 90 ? 'text-danger' : usedPct >= 80 ? 'text-warning' : 'text-surface-400')}>{usedPct}%</span>
                                  <span className="text-surface-600">{usedGiB} GiB</span>
                                </div>
                                <div className="h-1 rounded-full bg-surface-800">
                                  <div className={cn('h-full rounded-full', usedPct >= 90 ? 'bg-danger' : usedPct >= 80 ? 'bg-warning' : 'bg-brand-500')} style={{ width: `${usedPct}%` }} />
                                </div>
                              </div>
                            ) : (
                              <span className="text-surface-600 text-2xs">req: {pvc.requestedGiB} GiB</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 tabular-nums">
                            {(pvc as any).inodesUsedPct != null ? (
                              <div className="space-y-0.5 min-w-[60px]">
                                <div className="flex justify-between text-2xs">
                                  <span className={cn('font-semibold tabular-nums',
                                    (pvc as any).inodesUsedPct >= 90 ? 'text-danger' :
                                    (pvc as any).inodesUsedPct >= 75 ? 'text-warning' : 'text-surface-400'
                                  )}>{(pvc as any).inodesUsedPct}%</span>
                                </div>
                                <div className="h-1 rounded-full bg-surface-800">
                                  <div className={cn('h-full rounded-full',
                                    (pvc as any).inodesUsedPct >= 90 ? 'bg-danger' :
                                    (pvc as any).inodesUsedPct >= 75 ? 'bg-warning' : 'bg-brand-500/60'
                                  )} style={{ width: `${Math.min((pvc as any).inodesUsedPct, 100)}%` }} />
                                </div>
                              </div>
                            ) : <span className="text-surface-600 text-2xs">{'\u2013'}</span>}
                          </td>
                          <td className="px-3 py-2.5">
                            {(pvc as any).mountedByPods?.length > 0 ? (
                              <div className="flex flex-col gap-0.5 max-w-[120px]">
                                {(pvc as any).mountedByPods.slice(0, 2).map((p: any) => (
                                  <span key={p.name} className="text-2xs font-mono text-surface-400 truncate" title={`${p.namespace}/${p.name}`}>{p.name}</span>
                                ))}
                                {(pvc as any).mountedByPods.length > 2 && (
                                  <span className="text-2xs text-surface-600">+{(pvc as any).mountedByPods.length - 2} more</span>
                                )}
                              </div>
                            ) : <span className="text-surface-600 text-2xs">{'\u2013'}</span>}
                          </td>
                          <td className="px-3 py-2.5 text-surface-400 font-mono">{pvc.storageClass}</td>
                          <td className="px-3 py-2.5 text-surface-500">{pvc.accessMode}</td>
                          <td className="px-3 py-2.5 text-surface-500">{pvc.volumeMode}</td>
                          <td className="px-3 py-2.5">
                            {daysToFull !== null && daysToFull !== undefined ? (
                              <span className={cn('text-2xs font-semibold flex items-center gap-1', daysToFull < 7 ? 'text-danger' : daysToFull < 30 ? 'text-warning' : 'text-success')}>
                                <TrendingUp className="w-3 h-3" />{daysToFull < 1 ? '<1d' : `${daysToFull}d`}
                              </span>
                            ) : <span className="text-surface-600 text-2xs">—</span>}
                          </td>
                          <td className="px-3 py-2.5 tabular-nums text-surface-600">{ageStr((pvc as any).createdAt)}</td>
                          <td className="px-2 py-2.5 whitespace-nowrap sticky right-0 bg-surface-900 hover:bg-surface-800/40 z-10" style={{ minWidth: '116px' }} onClick={e => e.stopPropagation()}>
                            <div className="flex items-center gap-0.5">
                              <button onClick={() => setDescribeTarget({ kind: 'PersistentVolumeClaim', namespace: pvc.namespace, name: pvc.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-amber-400 hover:bg-amber-400/10 transition-all" title="Describe"><FileSearch className="w-3.5 h-3.5" /></button>
                              <button onClick={() => setYamlTarget({ kind: 'PersistentVolumeClaim', namespace: pvc.namespace, name: pvc.name })}
                                className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all" title="YAML">
                                <FileCode2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => { setSnapshotName(`snap-${pvc.name}-${Date.now().toString(36)}`); setCreateSnapshotPVC({ namespace: pvc.namespace, name: pvc.name }) }}
                                title="Create VolumeSnapshot"
                                className="p-1.5 rounded-lg text-surface-600 hover:text-purple-400 hover:bg-purple-500/10 transition-all"
                              >
                                <Camera className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => { setResizePVC({ namespace: pvc.namespace, name: pvc.name, currentGi: pvc.capacityGiB }); setResizeSizeInput(String((pvc.capacityGiB ?? 1) + 1)) }}
                                title="Resize PVC"
                                className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all"
                              >
                                <Zap className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setConfirmDeletePVC({ namespace: pvc.namespace, name: pvc.name })}
                              disabled={deletingPVC === pvcKey}
                              title="Delete PVC"
                              className="p-1.5 rounded-lg text-surface-600 hover:text-danger hover:bg-danger/10 transition-all disabled:opacity-40"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {/* VolumeSnapshots */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-2">
                <Camera className="w-4 h-4 text-purple-400" />
                <span className="text-sm font-semibold text-white">Volume Snapshots</span>
                <span className="text-2xs text-surface-500 ml-1">
                  {snapshotsData.crdAvailable ? `(${snapshotsData.snapshots.length})` : '— CRD not installed'}
                </span>
              </div>
              {!snapshotsData.crdAvailable ? (
                <div className="px-4 py-5 text-center text-xs text-surface-600 italic">
                  VolumeSnapshot CRD not available. Install the external-snapshotter to enable.
                </div>
              ) : snapshotsData.snapshots.length === 0 ? (
                <div className="px-4 py-5 text-center text-xs text-surface-600 italic">No snapshots found</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800 bg-surface-950">
                      {['Name', 'Namespace', 'Source PVC', 'Class', 'Size', 'Ready', 'Age', ''].map((h, i) => (
                        <th key={h || i} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {snapshotsData.snapshots.map((s: any) => (
                      <tr key={`${s.namespace}/${s.name}`} className="border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors">
                        <td className="px-3 py-2.5 font-mono text-white">{s.name}</td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono">{s.namespace}</td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono">{s.sourcePVC || <span className="text-surface-600">—</span>}</td>
                        <td className="px-3 py-2.5 text-surface-500">{s.snapshotClass || <span className="text-surface-600">—</span>}</td>
                        <td className="px-3 py-2.5 text-surface-400">{s.restoreSize || <span className="text-surface-600">—</span>}</td>
                        <td className="px-3 py-2.5">
                          {s.readyToUse
                            ? <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                            : s.error
                              ? <span className="text-2xs text-danger font-semibold" title={s.error}>Error</span>
                              : <RefreshCw className="w-3.5 h-3.5 text-brand-400 animate-spin" />
                          }
                        </td>
                        <td className="px-3 py-2.5 text-surface-600" suppressHydrationWarning>{ageStr(s.createdAt)}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1">
                            {s.readyToUse && (
                              <button
                                onClick={() => { setRestoreNewPvcName(`restore-${s.name}`); setRestoreSnapshotModal(s) }}
                                className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all"
                                title="Restore snapshot to new PVC"
                              >
                                <Undo2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => { setDeletingSnapshot(`${s.namespace}/${s.name}`); fetch(`/api/k8s/storage/snapshots?name=${s.name}&namespace=${s.namespace}`, { method: 'DELETE', headers: clusterHeaders() }).then(() => setDeletingSnapshot(null)) }}
                              disabled={deletingSnapshot === `${s.namespace}/${s.name}`}
                              className="p-1.5 rounded-lg text-surface-600 hover:text-danger hover:bg-danger/10 transition-all disabled:opacity-40"
                              title="Delete snapshot"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Orphaned ConfigMaps & Secrets */}
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-2">
                  <Package className="w-4 h-4 text-warning" />
                  <span className="text-sm font-semibold text-white">Orphaned ConfigMaps &amp; Secrets</span>
                  <span className="text-2xs text-surface-500 ml-1">not referenced by any pod</span>
                  {orphanedConfigMaps.length + orphanedSecrets.length > 0 ? (
                    <span className="ml-auto text-2xs px-2 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/20 font-semibold">
                      {orphanedConfigMaps.length + orphanedSecrets.length} orphaned
                    </span>
                  ) : (
                    <span className="ml-auto text-2xs px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20 font-semibold">
                      {'\u2713'} None detected
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 divide-x divide-surface-800">
                  {/* ConfigMaps column */}
                  <div>
                    <div className="px-4 py-2 bg-surface-950 border-b border-surface-800">
                      <span className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">ConfigMaps ({orphanedConfigMaps.length})</span>
                    </div>
                    {orphanedConfigMaps.length === 0
                      ? <p className="px-4 py-5 text-xs text-surface-600 italic flex items-center gap-1.5">{'✓'} All ConfigMaps are referenced</p>
                      : <table className="w-full text-xs">
                          <tbody>
                            {orphanedConfigMaps.map((cm: any) => (
                              <tr key={`${cm.namespace}/${cm.name}`} className="border-b border-surface-800/40 hover:bg-surface-800/30 transition-colors">
                                <td className="px-3 py-2.5 font-mono text-white">{cm.name}</td>
                                <td className="px-3 py-2.5 text-surface-500">{cm.namespace}</td>
                                <td className="px-3 py-2.5 text-surface-600 tabular-nums">{cm.keys} keys</td>
                                <td className="px-3 py-2.5 text-surface-600 tabular-nums" suppressHydrationWarning>{ageStr(cm.createdAt)}</td>
                                <td className="px-3 py-2.5">
                                  <button
                                    onClick={() => fetch(`/api/k8s/storage/orphaned?kind=ConfigMap&name=${cm.name}&namespace=${cm.namespace}`, { method: 'DELETE', headers: clusterHeaders() })}
                                    className="p-1.5 rounded-lg text-surface-600 hover:text-danger hover:bg-danger/10 transition-all"
                                    title="Delete orphaned ConfigMap"
                                  ><Trash2 className="w-3 h-3" /></button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                    }
                  </div>
                  {/* Secrets column */}
                  <div>
                    <div className="px-4 py-2 bg-surface-950 border-b border-surface-800">
                      <span className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Secrets ({orphanedSecrets.length})</span>
                    </div>
                    {orphanedSecrets.length === 0
                      ? <p className="px-4 py-5 text-xs text-surface-600 italic flex items-center gap-1.5">{'✓'} All Secrets are referenced</p>
                      : <table className="w-full text-xs">
                          <tbody>
                            {orphanedSecrets.map((s: any) => (
                              <tr key={`${s.namespace}/${s.name}`} className="border-b border-surface-800/40 hover:bg-surface-800/30 transition-colors">
                                <td className="px-3 py-2.5 font-mono text-white">{s.name}</td>
                                <td className="px-3 py-2.5 text-surface-500">{s.namespace}</td>
                                <td className="px-3 py-2.5 text-surface-600">{s.type}</td>
                                <td className="px-3 py-2.5 text-surface-600 tabular-nums">{s.keys} keys</td>
                                <td className="px-3 py-2.5 text-surface-600 tabular-nums" suppressHydrationWarning>{ageStr(s.createdAt)}</td>
                                <td className="px-3 py-2.5">
                                  <button
                                    onClick={() => fetch(`/api/k8s/storage/orphaned?kind=Secret&name=${s.name}&namespace=${s.namespace}`, { method: 'DELETE', headers: clusterHeaders() })}
                                    className="p-1.5 rounded-lg text-surface-600 hover:text-danger hover:bg-danger/10 transition-all"
                                    title="Delete orphaned Secret"
                                  ><Trash2 className="w-3 h-3" /></button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                    }
                  </div>
                </div>
              </div>
            {/* Storage I/O per Pod */}
            {iopsData.pvcs.length > 0 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-brand-400" />
                  <span className="text-sm font-semibold text-white">Storage I/O by Pod</span>
                  <span className="text-2xs text-surface-500 ml-1">top 20 by IOPS · 5m avg</span>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800 bg-surface-950">
                      {['', 'Pod', 'Namespace', 'Read IOPS', 'Write IOPS', 'Read MB/s', 'Write MB/s', 'Write Trend (1h)', ''].map((h, i) => (
                        <th key={h || i} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {iopsData.pvcs.map((row: any) => {
                        const podKey = `${row.namespace}/${row.pod}`
                        const isExpanded = expandedIopsPod === podKey
                        return (
                          <Fragment key={podKey}>
                            <tr
                              key={podKey}
                              onClick={() => setExpandedIopsPod(isExpanded ? null : podKey)}
                              className="border-b border-surface-800/50 hover:bg-surface-800/30 cursor-pointer transition-colors"
                            >
                              <td className="px-2 py-2.5 w-6">
                                {isExpanded
                                  ? <ChevronDown className="w-3 h-3 text-brand-400" />
                                  : <ChevronRight className="w-3 h-3 text-surface-500" />}
                              </td>
                              <td className="px-3 py-2.5 font-mono text-surface-300 max-w-[180px] truncate">{row.pod}</td>
                              <td className="px-3 py-2.5 text-surface-500">{row.namespace}</td>
                              <td className="px-3 py-2.5 tabular-nums">
                                <span className={cn('font-semibold', (row.readIops ?? 0) > 1000 ? 'text-warning' : 'text-brand-400')}>{(row.readIops ?? 0).toFixed(1)}</span>
                              </td>
                              <td className="px-3 py-2.5 tabular-nums">
                                <span className={cn('font-semibold', (row.writeIops ?? 0) > 1000 ? 'text-warning' : 'text-purple-400')}>{(row.writeIops ?? 0).toFixed(1)}</span>
                              </td>
                              <td className="px-3 py-2.5 tabular-nums text-surface-300">{(row.readMBs ?? 0).toFixed(3)}</td>
                              <td className="px-3 py-2.5 tabular-nums text-surface-300">{(row.writeMBs ?? 0).toFixed(3)}</td>
                              <td className="px-3 py-2.5">
                                {(row.sparkWrite?.length ?? 0) > 1
                                  ? <Sparkline data={row.sparkWrite} color="#a855f7" width={80} height={20} />
                                  : <span className="text-surface-700 text-2xs">—</span>}
                              </td>
                              <td className="px-2 py-2.5" onClick={e => e.stopPropagation()}>
                                <button
                                  onClick={() => setIoPopup({ pod: row.pod, namespace: row.namespace, ioWin: 60, sparkRead: row.sparkRead ?? [], sparkWrite: row.sparkWrite ?? [], sparkReadMBs: row.sparkReadMBs ?? [], sparkWriteMBs: row.sparkWriteMBs ?? [], readIops: row.readIops ?? 0, writeIops: row.writeIops ?? 0, readMBs: row.readMBs ?? 0, writeMBs: row.writeMBs ?? 0 })}
                                  className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all"
                                  title="Expand I/O charts"
                                >
                                  <Maximize2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr key={podKey + '-expand'} className="bg-surface-950/60 border-b border-surface-800">
                                <td colSpan={8} className="px-6 py-4">
                                  <div className="grid grid-cols-4 gap-6">
                                    {[
                                      { label: 'Read IOPS', unit: '/s',  data: row.sparkRead  ?? [], color: '#38bdf8' },
                                      { label: 'Write IOPS', unit: '/s', data: row.sparkWrite ?? [], color: '#a855f7' },
                                      { label: 'Read MB/s',  unit: 'MB/s', data: row.sparkReadMBs  ?? [], color: '#34d399' },
                                      { label: 'Write MB/s', unit: 'MB/s', data: row.sparkWriteMBs ?? [], color: '#f97316' },
                                    ].map(({ label, unit, data, color }) => {
                                      const hasData = data.length > 1
                                      const peak = hasData ? Math.max(...data) : 0
                                      const last = hasData ? (data[data.length - 1] ?? 0) : 0
                                      return (
                                        <div key={label} className="bg-surface-900 rounded-xl p-3 border border-surface-800">
                                          <div className="flex items-center justify-between mb-2">
                                            <span className="text-2xs font-semibold text-surface-400 uppercase tracking-wider">{label}</span>
                                            <span className="text-xs font-bold tabular-nums" style={{ color }}>
                                              {last.toFixed(unit === 'MB/s' ? 3 : 1)} {unit}
                                            </span>
                                          </div>
                                          {hasData
                                            ? <Sparkline data={data} color={color} width={160} height={40} />
                                            : <div className="h-10 flex items-center justify-center text-2xs text-surface-700">no data</div>}
                                          <div className="mt-1 text-2xs text-surface-600 text-right">peak {peak.toFixed(unit === 'MB/s' ? 3 : 1)} · 30m</div>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </div>
        )}
        {activeTab === 'Network' && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              {[
                { label: 'Total Ingress', value: `${totalNetIn.toFixed(2)} Mbps`, icon: Activity, color: 'text-brand-400' },
                { label: 'Total Egress', value: `${totalNetOut.toFixed(2)} Mbps`, icon: Activity, color: 'text-purple-400' },
                { label: `Nodes w/ Drop >${netThresholds.packetDropPct}%`, value: nodesWithNetwork.filter(n => (n.packetDropRate ?? 0) * 100 > netThresholds.packetDropPct).length, icon: AlertTriangle, color: 'text-warning' },
              ].map(k => {
                const Icon = k.icon
                return (
                  <div key={k.label} className="rounded-2xl bg-surface-900 border border-surface-800 px-4 py-3 flex items-center gap-3">
                    <Icon className={cn('w-8 h-8 flex-shrink-0', k.color)} />
                    <div>
                      <div className={cn('text-xl font-bold', k.color)}>{k.value}</div>
                      <div className="text-xs text-surface-500">{k.label}</div>
                    </div>
                  </div>
                )
              })}
              {/* Cluster identity card */}
              <div className="rounded-2xl bg-surface-900 border border-surface-800 px-4 py-3 flex items-center gap-3">
                <Server className="w-8 h-8 flex-shrink-0 text-surface-400" />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-white truncate" title={clusterMeta.name}>{clusterMeta.name}</div>
                  <div className="text-xs text-surface-500 truncate">{clusterMeta.provider}{clusterMeta.region && clusterMeta.region !== '—' ? ` · ${clusterMeta.region}` : ''}</div>
                </div>
              </div>
              {/* Alert threshold config button */}
              <button
                onClick={() => { setNetThresholdDraft(netThresholds); setShowNetThresholds(v => !v) }}
                className={cn('rounded-2xl border px-4 py-3 flex items-center gap-2 text-xs font-semibold transition-all',
                  showNetThresholds ? 'bg-brand-500/10 border-brand-500/30 text-brand-400' : 'bg-surface-900 border-surface-800 text-surface-500 hover:text-white hover:border-surface-600')}
              >
                <Sliders className="w-4 h-4" /> Thresholds
              </button>
            </div>

            {/* Alert threshold config panel */}
            {showNetThresholds && (
              <div className="rounded-2xl bg-surface-900 border border-brand-500/20 p-4 space-y-3">
                <p className="text-sm font-semibold text-white flex items-center gap-2"><Sliders className="w-4 h-4 text-brand-400" /> Alert Thresholds</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1">
                      Bandwidth Saturation Alert (%)</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min={10} max={100} step={5} value={netThresholdDraft.bwSatPct}
                        onChange={e => setNetThresholdDraft(p => ({ ...p, bwSatPct: parseInt(e.target.value) }))}
                        className="flex-1 accent-brand-400" />
                      <span className="text-sm font-bold text-brand-400 w-10 text-right">{netThresholdDraft.bwSatPct}%</span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1">
                      Packet Drop Alert (%)</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min={0.1} max={5} step={0.1} value={netThresholdDraft.packetDropPct}
                        onChange={e => setNetThresholdDraft(p => ({ ...p, packetDropPct: parseFloat(e.target.value) }))}
                        className="flex-1 accent-warning" />
                      <span className="text-sm font-bold text-warning w-12 text-right">{netThresholdDraft.packetDropPct}%</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setShowNetThresholds(false)} className="px-3 py-1.5 text-xs rounded-lg text-surface-400 hover:text-white transition-colors">Cancel</button>
                  <button onClick={handleSaveNetThresholds} className="px-4 py-1.5 text-xs rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 transition-all">Save</button>
                </div>
              </div>
            )}

            {/* DNS metrics */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
              <p className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <Activity className="w-4 h-4 text-brand-400" /> CoreDNS Health
                {networkData.coreDNS?.errorSpike && (
                  <span className="text-2xs px-2 py-0.5 rounded-full bg-danger/10 border border-danger/30 text-danger font-bold animate-pulse ml-2">⚠ Error Spike (30m)</span>
                )}
              </p>
              {networkData.coreDNS ? (
                <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {[
                      { label: 'QPS',           value: formatNumber(networkData.coreDNS.qps),         color: 'text-brand-400' },
                      { label: 'Error Rate',     value: `${(networkData.coreDNS.errorRatePct ?? 0).toFixed(2)}%`,     color: (networkData.coreDNS.errorRatePct ?? 0) > 5 ? 'text-danger' : (networkData.coreDNS.errorRatePct ?? 0) > 1 ? 'text-warning' : 'text-success' },
                      { label: 'P99 Latency',   value: `${(networkData.coreDNS.p99LatencyMs ?? 0).toFixed(1)}ms`,    color: (networkData.coreDNS.p99LatencyMs ?? 0) > 100 ? 'text-danger' : (networkData.coreDNS.p99LatencyMs ?? 0) > 20 ? 'text-warning' : 'text-success' },
                      { label: 'Cache Hit Rate', value: `${(networkData.coreDNS.cacheHitRatePct ?? 0).toFixed(1)}%`,  color: (networkData.coreDNS.cacheHitRatePct ?? 0) > 80 ? 'text-brand-400' : 'text-warning' },
                    ].map(m => (
                      <div key={m.label} className="text-center">
                        <div className={cn('text-xl font-bold', m.color)}>{m.value}</div>
                        <div className="text-2xs text-surface-500 mt-0.5">{m.label}</div>
                      </div>
                    ))}
                  </div>
                  {/* DNS query type breakdown */}
                  {Object.keys(networkData.dnsByType).length > 0 && (
                    <div>
                      <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider mb-2">Query Type Breakdown (QPS)</p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {Object.entries(networkData.dnsByType as Record<string, number>)
                          .sort(([, a], [, b]) => (b as number) - (a as number))
                          .filter(([, qps]) => (qps as number) > 0)
                          .slice(0, 8)
                          .map(([type, qps]) => {
                            const allVals = Object.values(networkData.dnsByType as Record<string, number>) as number[]
                            const total = allVals.reduce((a, b) => a + b, 0)
                            const qpsNum = qps as number
                            const pctVal = total > 0 ? Math.round((qpsNum / total) * 100) : 0
                            return (
                              <div key={type} className="bg-surface-800/40 rounded-xl px-3 py-2">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs font-mono text-white font-semibold">{type}</span>
                                  <span className="text-2xs text-brand-400">{(qpsNum as number).toFixed(1)}/s</span>
                                </div>
                                <div className="h-1 rounded-full bg-surface-700">
                                  <div className="h-full rounded-full bg-brand-500/70" style={{ width: `${pctVal}%` }} />
                                </div>
                                <div className="text-2xs text-surface-600 mt-0.5">{pctVal}%</div>
                              </div>
                            )
                          })}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center text-xs text-surface-500 py-2">CoreDNS metrics not available from Prometheus</div>
              )}
            </div>

            {/* Bandwidth history chart */}
            {networkData.bwHistory && (networkData.bwHistory.rx?.length ?? 0) > 1 && (() => {
              const rx: { ts: number; v: number }[] = networkData.bwHistory.rx
              const tx: { ts: number; v: number }[] = networkData.bwHistory.tx
              // Merge rx+tx by timestamp into DualSeriesChart format
              const tsSet = new Map<number, { a: number; b: number }>()
              for (const p of rx) tsSet.set(p.ts, { a: p.v, b: 0 })
              for (const p of tx) { const e = tsSet.get(p.ts); if (e) e.b = p.v; else tsSet.set(p.ts, { a: 0, b: p.v }) }
              const chartData = Array.from(tsSet.entries()).sort((x, y) => x[0] - y[0]).map(([ts, { a, b }]) => ({ ts, a, b }))
              return (
                <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                  <p className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
                    <Activity className="w-4 h-4 text-brand-400" /> Cluster Bandwidth — {timeRange} History
                  </p>
                  <DualSeriesChart
                    data={chartData}
                    series={[
                      { key: 'a', label: 'Ingress', color: '#38bdf8' },
                      { key: 'b', label: 'Egress',  color: '#a855f7' },
                    ]}
                    unit=" Mbps"
                    height={220}
                    onPointClick={async (ts) => {
                      const tsS = Math.floor(ts / 1000)
                      setBwDrill({ ts: tsS, rows: null, loading: true })
                      try {
                        const headers: Record<string, string> = activeCluster ? { 'X-Prom-Url': activeCluster.promUrl || 'none', 'X-K8s-Url': activeCluster.k8sUrl || 'none' } : {}
                        const [rxRes, txRes] = await Promise.all([
                          fetch(`/api/observability/breakdown?metric=network_rx&at=${tsS}`, { headers }).then(r => r.json()),
                          fetch(`/api/observability/breakdown?metric=network_tx&at=${tsS}`, { headers }).then(r => r.json()),
                        ])
                        const combined = new Map<string, { name: string; rx: number; tx: number; unit: string }>()
                        for (const row of (rxRes.rows ?? [])) combined.set(row.name, { name: row.name, rx: row.value, tx: 0, unit: row.unit })
                        for (const row of (txRes.rows ?? [])) { const e = combined.get(row.name); if (e) e.tx = row.value; else combined.set(row.name, { name: row.name, rx: 0, tx: row.value, unit: row.unit }) }
                        const rows = Array.from(combined.values()).map(r => ({ name: r.name, value: parseFloat((r.rx + r.tx).toFixed(2)), unit: r.unit })).sort((a, b) => b.value - a.value).slice(0, 10)
                        setBwDrill({ ts: tsS, rows, loading: false })
                      } catch { setBwDrill(d => d ? { ...d, loading: false } : null) }
                    }}
                  />
                  <p className="text-2xs text-surface-600 mt-2 text-center">scroll to zoom · drag to pan · double-click to reset · click a point to see top contributors</p>

                  {/* Bandwidth drill-down panel */}
                  {bwDrill && (
                    <div className="rounded-xl bg-surface-950 border border-surface-800 overflow-hidden mt-3">
                      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-800">
                        <Activity className="w-3.5 h-3.5 text-sky-400" />
                        <span className="text-xs font-semibold text-white">
                          Top network contributors at {new Date(bwDrill.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                        </span>
                        {bwDrill.loading && <Loader2 className="w-3 h-3 text-sky-400 animate-spin ml-1" />}
                        <button onClick={() => setBwDrill(null)} className="ml-auto text-surface-600 hover:text-white transition-colors"><X className="w-3 h-3" /></button>
                      </div>
                      <div className="p-3 space-y-1.5" style={{ opacity: bwDrill.loading ? 0.4 : 1, transition: 'opacity 0.15s' }}>
                        {!bwDrill.loading && bwDrill.rows !== null && bwDrill.rows.length === 0 && (
                          <p className="text-xs text-surface-500 text-center py-3">No contributor data at this timestamp</p>
                        )}
                        {(bwDrill.rows ?? []).map((row) => {
                          const max = bwDrill.rows![0]?.value ?? 1
                          const isPodRow = row.name.includes('/')
                          const [nsName, podName] = isPodRow ? row.name.split('/') : ['', row.name]
                          return (
                            <div key={row.name} className="flex items-center gap-3">
                              <span className="text-xs font-mono text-surface-300 w-56 truncate flex-shrink-0" title={row.name}>{row.name}</span>
                              <div className="flex-1 h-2.5 bg-surface-800 rounded-full overflow-hidden">
                                <div className="h-full rounded-full bg-sky-500/70 transition-all" style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }} />
                              </div>
                              <span className="text-xs font-mono tabular-nums text-white w-20 text-right flex-shrink-0">{row.value.toFixed(2)} {row.unit}</span>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {isPodRow && (
                                  <>
                                    <a href={`/kubernetes?tab=Pods&pod=${encodeURIComponent(podName)}&ns=${encodeURIComponent(nsName)}`}
                                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-brand-400 transition-colors" title="Open in Kubernetes">
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                    <a href={`/observability?tab=Logs`}
                                      onClick={() => { if (typeof window !== 'undefined') { sessionStorage.setItem('vynops-loki-jump', JSON.stringify({ query: `{namespace="${nsName}"} |= "${podName.split('-').slice(0, -2).join('-') || podName}"`, start: bwDrill.ts - 15 * 60, end: bwDrill.ts + 15 * 60 })) } }}
                                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-amber-400 transition-colors" title="View logs around this spike">
                                      <ScrollText className="w-3 h-3" />
                                    </a>
                                  </>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Per-node network table */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800">
                <span className="text-sm font-semibold text-white flex items-center gap-2">
                  <Network className="w-4 h-4 text-brand-400" /> Per-Node Network
                </span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-800 bg-surface-950">
                    {['Node', 'Role', 'Ingress (1h)', 'Egress (1h)', 'Packet Drop', 'Zone'].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                    {nodesWithNetwork.map(node => {
                    const hasDrops = (node.packetDropRate ?? 0) * 100 > netThresholds.packetDropPct
                    const openNetPopup = (w: number) => {
                      const sparkIn: number[] = node.sparkIn ?? []
                      const sparkOut: number[] = node.sparkOut ?? []
                      const n = Math.max(sparkIn.length, sparkOut.length, 2)
                      const now2 = Date.now(); const winMs2 = w * 60 * 1000; const step = winMs2 / (n - 1)
                      const chartData = Array.from({ length: n }, (_, i) => ({
                        ts: Math.round(now2 - winMs2 + i * step),
                        a: sparkIn[i] ?? 0,
                        b: sparkOut[i] ?? 0,
                      }))
                      setNetNodePopup({ nodeName: node.name, chartData, drillWin: w, drill: null })
                    }
                    return (
                      <tr key={node.name} className={cn('border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors', hasDrops && 'bg-warning/5')}>
                        <td className="px-3 py-2.5 font-mono text-xs text-white">{node.name}</td>
                        <td className="px-3 py-2.5 text-surface-400 text-xs capitalize">{node.role}</td>
                        <td className="px-3 py-2.5 min-w-[130px]">
                          <div className="flex flex-col gap-0.5">
                            {(node.sparkIn?.length ?? 0) > 1
                              ? <button title="Click to expand network chart" onClick={() => openNetPopup(60)} className="block hover:opacity-80 transition-opacity cursor-zoom-in"><Sparkline data={node.sparkIn} color="#22c55e" width={90} height={16} /></button>
                              : null}
                            <span className="text-brand-400 text-xs tabular-nums font-semibold">↓ {formatNumber(node.networkInMbps ?? 0)} Mbps</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 min-w-[130px]">
                          <div className="flex flex-col gap-0.5">
                            {(node.sparkOut?.length ?? 0) > 1
                              ? <button title="Click to expand network chart" onClick={() => openNetPopup(60)} className="block hover:opacity-80 transition-opacity cursor-zoom-in"><Sparkline data={node.sparkOut} color="#a855f7" width={90} height={16} /></button>
                              : null}
                            <span className="text-purple-400 text-xs tabular-nums font-semibold">↑ {formatNumber(node.networkOutMbps ?? 0)} Mbps</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-xs tabular-nums">
                          <span className={cn('font-semibold', hasDrops ? 'text-warning' : 'text-success')}>
                            {((node.packetDropRate ?? 0) * 100).toFixed(3)}%
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-surface-500 text-xs">{node.zone}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>

            {/* ── Pod-to-Pod Latency Matrix (Goldpinger) ── */}
            {latencyData.available && latencyData.nodes.length > 0 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-3">
                  <Activity className="w-4 h-4 text-brand-400" />
                  <span className="text-sm font-semibold text-white">Node-to-Node Latency Matrix</span>
                  <span className="text-2xs text-surface-500 ml-1">via Goldpinger · avg round-trip</span>
                  {latencyData.stats.failCount > 0 && (
                    <span className="text-2xs px-2 py-0.5 rounded-full bg-danger/10 border border-danger/30 text-danger font-bold animate-pulse ml-1">
                      {latencyData.stats.failCount} path{latencyData.stats.failCount > 1 ? 's' : ''} failing
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-4 text-2xs text-surface-500">
                    <span>avg <span className="text-brand-400 font-semibold">{latencyData.stats.avgLatency.toFixed(2)}ms</span></span>
                    <span>max <span className={cn('font-semibold', latencyData.stats.maxLatency > 10 ? 'text-danger' : latencyData.stats.maxLatency > 2 ? 'text-warning' : 'text-success')}>{latencyData.stats.maxLatency.toFixed(2)}ms</span></span>
                  </div>
                </div>
                <div className="p-4">
                  {/* Header row */}
                  <div className="flex gap-1 mb-1 ml-28">
                    {latencyData.nodes.map((n: string) => (
                      <div key={n} className="w-24 text-center text-2xs text-surface-500 truncate px-1" title={n}>
                        {activeCluster?.name ? n.replace(`${activeCluster.name}-`, '') : n}
                      </div>
                    ))}
                  </div>
                  {/* Matrix rows */}
                  {latencyData.nodes.map((srcNode: string, i: number) => (
                    <div key={srcNode} className="flex gap-1 mb-1 items-center">
                      <div className="w-28 text-2xs text-surface-400 font-mono truncate pr-2 text-right" title={srcNode}>
                        {activeCluster?.name ? srcNode.replace(`${activeCluster.name}-`, '') : srcNode}
                      </div>
                      {latencyData.nodes.map((tgtNode: string, j: number) => {
                        const latMs = latencyData.matrix[i]?.[j]
                        const ok    = latencyData.okMatrix[i]?.[j]
                        const isSelf = i === j
                        const bgColor = isSelf ? 'bg-surface-800'
                          : !ok         ? 'bg-danger/30'
                          : latMs === null ? 'bg-surface-800'
                          : latMs > 20  ? 'bg-danger/20'
                          : latMs > 5   ? 'bg-warning/20'
                          : latMs > 1   ? 'bg-yellow-500/15'
                          : 'bg-success/20'
                        const textColor = isSelf ? 'text-surface-600'
                          : !ok ? 'text-danger font-bold'
                          : latMs === null ? 'text-surface-600'
                          : latMs > 20 ? 'text-danger'
                          : latMs > 5  ? 'text-warning'
                          : latMs > 1  ? 'text-yellow-400'
                          : 'text-success'
                        return (
                          <div
                            key={tgtNode}
                            className={cn('w-24 h-10 rounded-lg flex items-center justify-center text-2xs font-mono transition-all border', bgColor, isSelf ? 'border-surface-700' : ok ? 'border-transparent' : 'border-danger/40')}
                            title={isSelf ? 'self' : `${srcNode} → ${tgtNode}: ${latMs?.toFixed(2) ?? '?'}ms`}
                          >
                            <span className={textColor}>
                              {isSelf ? '—' : !ok ? 'FAIL' : latMs !== null ? `${latMs.toFixed(2)}ms` : '…'}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                  {/* Legend */}
                  <div className="flex items-center gap-4 mt-3 text-2xs text-surface-600">
                    <span>Latency:</span>
                    {[
                      { label: '<1ms', color: 'bg-success/20 border-transparent text-success' },
                      { label: '1–5ms', color: 'bg-yellow-500/15 border-transparent text-yellow-400' },
                      { label: '5–20ms', color: 'bg-warning/20 border-transparent text-warning' },
                      { label: '>20ms', color: 'bg-danger/20 border-transparent text-danger' },
                      { label: 'FAIL', color: 'bg-danger/30 border-danger/40 text-danger' },
                    ].map(l => (
                      <span key={l.label} className={cn('px-2 py-0.5 rounded-lg border text-2xs font-mono', l.color)}>{l.label}</span>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {!latencyData.available && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4 flex items-center gap-3 text-xs text-surface-500">
                <Activity className="w-4 h-4 text-surface-600 flex-shrink-0" />
                <span>Latency matrix unavailable — Goldpinger not installed.</span>
                <code className="ml-auto text-2xs bg-surface-800 px-2 py-1 rounded text-surface-400">helm install goldpinger goldpinger/goldpinger -n monitoring</code>
              </div>
            )}

            {/* Services */}
            {/* Per-namespace bandwidth */}
            {networkData.nsBandwidth.length > 0 && (() => {
              const top = networkData.nsBandwidth.slice(0, 20)
              const maxTotal = top[0]?.totalMbps ?? 0.01
              return (
                <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                  <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-2">
                    <Network className="w-4 h-4 text-brand-400" />
                    <span className="text-sm font-semibold text-white">Bandwidth by Namespace</span>
                    <span className="text-2xs text-surface-500 ml-1">top {top.length} · 5m avg</span>
                  </div>
                  <div className="divide-y divide-surface-800/50">
                    {top.map((ns: any) => {
                      const rxPct = maxTotal > 0 ? (ns.rxMbps / maxTotal) * 100 : 0
                      const txPct = maxTotal > 0 ? (ns.txMbps / maxTotal) * 100 : 0
                      return (
                        <div key={ns.namespace} className="px-4 py-2.5 hover:bg-surface-800/30 transition-colors">
                          <div className="flex items-center gap-3 mb-1.5">
                            <span className="font-mono text-xs text-white w-40 truncate" title={ns.namespace}>{ns.namespace}</span>
                            <span className="text-2xs text-brand-400 tabular-nums w-20">↓ {ns.rxMbps.toFixed(2)} Mbps</span>
                            <span className="text-2xs text-purple-400 tabular-nums w-20">↑ {ns.txMbps.toFixed(2)} Mbps</span>
                            <span className="text-2xs text-surface-500 tabular-nums ml-auto">{ns.totalMbps.toFixed(2)} Mbps total</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-surface-800 overflow-hidden">
                            <div className="h-full flex">
                              <div className="h-full bg-brand-500/60 rounded-l-full" style={{ width: `${rxPct}%` }} />
                              <div className="h-full bg-purple-500/60" style={{ width: `${txPct}%` }} />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}

            {/* Retina eBPF Flow Metrics */}
            {networkData.retinaMetrics?.available && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                <p className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-400" /> Retina eBPF Flow Metrics
                  <span className="text-2xs px-2 py-0.5 rounded-full bg-emerald-400/10 border border-emerald-400/20 text-emerald-400 ml-1">eBPF</span>
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: 'Forward Ingress', value: `${networkData.retinaMetrics.forwardIngressMbps.toFixed(2)} Mbps`, color: 'text-brand-400' },
                    { label: 'Forward Egress',  value: `${networkData.retinaMetrics.forwardEgressMbps.toFixed(2)} Mbps`,  color: 'text-purple-400' },
                    { label: 'TCP Retransmit/s', value: networkData.retinaMetrics.tcpRetransmitRate.toFixed(3), color: networkData.retinaMetrics.tcpRetransmitRate > 1 ? 'text-warning' : 'text-success' },
                    { label: 'DNS Rate (eBPF)',  value: `${networkData.retinaMetrics.dnsRate.toFixed(1)}/s`,             color: 'text-emerald-400' },
                  ].map(m => (
                    <div key={m.label} className="bg-surface-800/40 rounded-xl px-4 py-3 text-center">
                      <div className={cn('text-xl font-bold tabular-nums', m.color)}>{m.value}</div>
                      <div className="text-2xs text-surface-500 mt-0.5">{m.label}</div>
                    </div>
                  ))}
                </div>
                {Object.keys(networkData.retinaMetrics.tcpStats ?? {}).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-surface-800">
                    <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider mb-2">TCP Stats (eBPF)</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(networkData.retinaMetrics.tcpStats as Record<string, number>)
                        .sort(([, a], [, b]) => (b as number) - (a as number))
                        .map(([stat, val]) => (
                          <div key={stat} className="bg-surface-800/60 rounded-lg px-3 py-1.5 flex items-center gap-2">
                            <span className="text-2xs font-mono text-surface-300">{stat}</span>
                            <span className={cn('text-2xs font-bold tabular-nums', (val as number) > 0.1 ? 'text-warning' : 'text-success')}>{(val as number).toFixed(3)}/s</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {networkData.services.length > 0 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800">
                  <span className="text-sm font-semibold text-white flex items-center gap-2">
                    <Network className="w-4 h-4 text-brand-400" /> Services
                    <span className="text-2xs text-surface-500 ml-1">({networkData.services.length})</span>
                  </span>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800 bg-surface-950">
                      {['Name', 'Namespace', 'Type', 'Cluster IP', 'External IP', 'Ports', 'Endpoints', 'Age', ''].map((h, i) => (
                        <th key={h || i} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {networkData.services.map((svc: any) => (
                      <tr key={`${svc.namespace}/${svc.name}`} className="border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors">
                        <td className="px-3 py-2.5 font-mono text-white">{svc.name}</td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono">{svc.namespace}</td>
                        <td className="px-3 py-2.5">
                          <span className={cn('text-2xs px-1.5 py-0.5 rounded border font-medium',
                            svc.type === 'LoadBalancer' ? 'bg-brand-500/10 text-brand-400 border-brand-500/20' :
                            svc.type === 'NodePort' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' :
                            'bg-surface-700 text-surface-400 border-surface-600'
                          )}>{svc.type}</span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-surface-400">{svc.clusterIP}</td>
                        <td className="px-3 py-2.5 font-mono text-brand-400">{svc.externalIP ?? <span className="text-surface-600">—</span>}</td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono text-2xs max-w-[180px] truncate">{svc.ports || <span className="text-surface-600">—</span>}</td>
                        <td className="px-3 py-2.5 tabular-nums text-surface-400">{svc.readyEndpoints}</td>
                        <td className="px-3 py-2.5 tabular-nums text-surface-600" suppressHydrationWarning>{ageStr(svc.createdAt)}</td>
                        <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setDescribeTarget({ kind: 'Service', namespace: svc.namespace, name: svc.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-amber-400 hover:bg-amber-400/10 transition-all" title="Describe"><FileSearch className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setYamlTarget({ kind: 'Service', namespace: svc.namespace, name: svc.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all" title="YAML"><FileCode2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {/* Network Policies */}
            {netPolData.networkPolicies.length > 0 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800">
                  <span className="text-sm font-semibold text-white flex items-center gap-2">
                    <Shield className="w-4 h-4 text-brand-400" /> Network Policies
                    <span className="text-2xs text-surface-500 ml-1">({netPolData.networkPolicies.length})</span>
                  </span>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800 bg-surface-950">
                      {['Name', 'Namespace', 'Pod Selector', 'Types', 'Ingress Rules', 'Egress Rules', 'Age', ''].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {netPolData.networkPolicies.map((np: any) => (
                      <tr key={`${np.namespace}/${np.name}`} className="border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors">
                        <td className="px-3 py-2.5 font-mono text-white">{np.name}</td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono">{np.namespace}</td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono text-2xs">
                          {Object.keys(np.podSelector ?? {}).length > 0
                            ? Object.entries(np.podSelector).map(([k, v]) => `${k}=${v}`).join(', ')
                            : <span className="text-surface-600">all pods</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex gap-1">
                            {(np.policyTypes ?? []).map((t: string) => (
                              <span key={t} className={cn('text-2xs px-1.5 py-0.5 rounded border font-medium',
                                t === 'Ingress' ? 'bg-brand-500/10 text-brand-400 border-brand-500/20' : 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                              )}>{t}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-surface-400">{np.ingressRules}</td>
                        <td className="px-3 py-2.5 tabular-nums text-surface-400">{np.egressRules}</td>
                        <td className="px-3 py-2.5 tabular-nums text-surface-600" suppressHydrationWarning>{ageStr(np.createdAt)}</td>
                        <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setDescribeTarget({ kind: 'NetworkPolicy', namespace: np.namespace, name: np.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-amber-400 hover:bg-amber-400/10 transition-all" title="Describe"><FileSearch className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setYamlTarget({ kind: 'NetworkPolicy', namespace: np.namespace, name: np.name })} className="p-1.5 rounded-lg text-surface-600 hover:text-brand-400 hover:bg-brand-500/10 transition-all" title="YAML"><FileCode2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {/* TCP connection states */}
            {networkData.tcpStates && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
                <p className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <Network className="w-4 h-4 text-brand-400" /> TCP Connection States
                </p>
                <div className="grid grid-cols-3 gap-4">
                  {[
                    { label: 'Established (inuse)', value: networkData.tcpStates.inuse, color: 'text-success' },
                    { label: 'Time Wait', value: networkData.tcpStates.timeWait, color: networkData.tcpStates.timeWait > 1000 ? 'text-warning' : 'text-surface-400' },
                    { label: 'Allocated (alloc)', value: networkData.tcpStates.alloc, color: 'text-brand-400' },
                  ].map(s => (
                    <div key={s.label} className="bg-surface-800/40 rounded-xl px-4 py-3 text-center">
                      <div className={cn('text-2xl font-bold tabular-nums', s.color)}>{formatNumber(s.value)}</div>
                      <div className="text-2xs text-surface-500 mt-0.5">{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* NGINX Ingress metrics */}
            {networkData.ingressMetrics.length > 0 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800">
                  <span className="text-sm font-semibold text-white flex items-center gap-2">
                    <Globe className="w-4 h-4 text-brand-400" /> Ingress Controller RPS
                    <span className="text-2xs text-surface-500 ml-1">(NGINX)</span>
                  </span>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800 bg-surface-950">
                      {['Ingress', 'Namespace', 'Req/s'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {networkData.ingressMetrics.map((m: any, i: number) => (
                      <tr key={i} className="border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors">
                        <td className="px-3 py-2.5 font-mono text-white">{m.ingress || '—'}</td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono">{m.namespace || '—'}</td>
                        <td className="px-3 py-2.5 text-brand-400 font-semibold tabular-nums">{m.rps.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── Service Endpoint Health ── */}
            {endpointHealthData.services.length > 0 && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-3">
                  <CheckCircle2 className="w-4 h-4 text-brand-400" />
                  <span className="text-sm font-semibold text-white">Service Endpoint Health</span>
                  <span className="text-2xs text-surface-500 ml-1">({endpointHealthData.stats.total} services)</span>
                  <div className="ml-auto flex items-center gap-3 text-2xs">
                    <span className="text-success font-semibold">{endpointHealthData.stats.healthy} healthy</span>
                    {endpointHealthData.stats.degraded > 0 && <span className="text-warning font-semibold">{endpointHealthData.stats.degraded} degraded</span>}
                    {endpointHealthData.stats.down > 0 && <span className="text-danger font-bold animate-pulse">{endpointHealthData.stats.down} down</span>}
                    {endpointHealthData.services.filter((s: any) => s.status === 'headless').length > 0 && <span className="text-surface-500">{endpointHealthData.services.filter((s: any) => s.status === 'headless').length} no-selector</span>}
                  </div>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800 bg-surface-950">
                      {['Service', 'Namespace', 'Type', 'Ports', 'Ready', 'Not Ready', 'Status'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {endpointHealthData.services
                      .filter((s: any) => s.status !== 'healthy' || s.total > 0)
                      .slice(0, 30)
                      .map((svc: any) => (
                      <tr key={`${svc.namespace}/${svc.name}`} className={cn('border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors', svc.status === 'down' && 'bg-danger/5', svc.status === 'degraded' && 'bg-warning/5')}>
                        <td className="px-3 py-2.5 font-mono text-white">{svc.name}</td>
                        <td className="px-3 py-2.5 text-surface-400 font-mono">{svc.namespace}</td>
                        <td className="px-3 py-2.5 text-surface-500">{svc.type}</td>
                        <td className="px-3 py-2.5 text-surface-600 font-mono text-2xs">{svc.ports || '—'}</td>
                        <td className="px-3 py-2.5 text-success tabular-nums font-semibold">{svc.ready}</td>
                        <td className="px-3 py-2.5 tabular-nums">
                          {svc.notReady > 0
                            ? <span className="text-danger font-bold">{svc.notReady}</span>
                            : <span className="text-surface-600">0</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={cn('text-2xs px-2 py-0.5 rounded-full border font-semibold',
                            svc.status === 'healthy'   ? 'bg-success/10 text-success border-success/30' :
                            svc.status === 'degraded'  ? 'bg-warning/10 text-warning border-warning/30' :
                            svc.status === 'headless'  ? 'bg-surface-800 text-surface-500 border-surface-600' :
                            'bg-danger/10 text-danger border-danger/30 animate-pulse'
                          )}>
                            {svc.status === 'headless' ? 'no selector' : svc.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {/* NetworkPolicy Gap Analysis */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-3">
                <Shield className="w-4 h-4 text-warning" />
                <span className="text-sm font-semibold text-white">NetworkPolicy Gap Analysis</span>
                <span className="text-2xs text-surface-500 ml-1">namespace exposure risk</span>
                {netSecData.networkPolicyGaps.filter((g: any) => g.risk === 'critical').length > 0 && (
                  <span className="ml-auto text-2xs px-2 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/30 font-semibold animate-pulse">
                    {netSecData.networkPolicyGaps.filter((g: any) => g.risk === 'critical').length} critical
                  </span>
                )}
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-800 bg-surface-950">
                    {['Namespace','Risk','Policies','Pods Covered','Exposed Pods','Exposure %','Sample Exposed Pods'].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {netSecData.networkPolicyGaps.map((g: any) => {
                    const ep = g.totalPods > 0 ? Math.round(g.uncoveredPods / g.totalPods * 100) : 0
                    return (
                      <tr key={g.namespace} className={cn('border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors', g.risk==='critical'&&'bg-danger/5', g.risk==='high'&&'bg-warning/5')}>
                        <td className="px-3 py-2.5 font-mono text-white">{g.namespace}</td>
                        <td className="px-3 py-2.5"><span className={cn('text-2xs px-2 py-0.5 rounded-full border font-semibold',g.risk==='critical'?'bg-danger/10 text-danger border-danger/30 animate-pulse':g.risk==='high'?'bg-warning/10 text-warning border-warning/30':g.risk==='medium'?'bg-amber-500/10 text-amber-400 border-amber-500/30':'bg-success/10 text-success border-success/30')}>{g.risk}</span></td>
                        <td className="px-3 py-2.5 tabular-nums text-surface-400">{g.policies}</td>
                        <td className="px-3 py-2.5 tabular-nums text-success font-semibold">{g.coveredPods}</td>
                        <td className="px-3 py-2.5 tabular-nums">{g.uncoveredPods > 0 ? <span className="text-danger font-bold">{g.uncoveredPods}</span> : <span className="text-surface-600">0</span>}</td>
                        <td className="px-3 py-2.5 tabular-nums">{ep > 0 ? <div className="flex items-center gap-2"><div className="w-16 h-1.5 rounded-full bg-surface-800"><div className={cn('h-full rounded-full',ep>=80?'bg-danger':ep>=50?'bg-warning':'bg-amber-500')} style={{width:`${ep}%`}} /></div><span className={cn('font-semibold',ep>=80?'text-danger':'text-warning')}>{ep}%</span></div> : <span className="text-success">0%</span>}</td>
                        <td className="px-3 py-2.5 font-mono text-surface-500 text-2xs max-w-[220px]">{g.uncoveredPodNames.length>0?g.uncoveredPodNames.join(', ')+(g.uncoveredPods>g.uncoveredPodNames.length?` +${g.uncoveredPods-g.uncoveredPodNames.length}`:''):<span className="text-surface-600">–</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>

            {/* TLS Certificate Expiry */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-3">
                <Lock className="w-4 h-4 text-brand-400" />
                <span className="text-sm font-semibold text-white">TLS Certificate Expiry</span>
                <span className="text-2xs text-surface-500 ml-1">kubernetes.io/tls secrets + Ingress rules</span>
                {netSecData.tlsCerts.filter((c:any)=>c.status==='expired'||c.status==='critical').length > 0 && (<span className="ml-auto text-2xs px-2 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/30 font-semibold animate-pulse">{netSecData.tlsCerts.filter((c:any)=>c.status==='expired'||c.status==='critical').length} urgent</span>)}
              </div>
              {netSecData.tlsCerts.length === 0 ? (<div className="px-4 py-5 text-xs text-surface-600 italic flex items-center gap-2"><Lock className="w-3.5 h-3.5" /> No TLS secrets or Ingress rules found</div>) : (
                <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-surface-800 bg-surface-950">
                    {['Name','Namespace','Source','Ingress','Expires','Days Left','Status'].map(h=><th key={h} className="px-3 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wider">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {netSecData.tlsCerts.map((c:any)=>(
                      <tr key={c.namespace+'/'+c.name} className={cn('border-b border-surface-800/50 hover:bg-surface-800/40 transition-colors',(c.status==='expired'||c.status==='critical')&&'bg-danger/5')}>
                        <td className="px-3 py-2.5 font-mono text-white">{c.name}</td><td className="px-3 py-2.5 text-surface-400 font-mono">{c.namespace}</td>
                        <td className="px-3 py-2.5"><span className={cn('text-2xs px-1.5 py-0.5 rounded border font-medium',c.source==='tls-secret'?'bg-brand-500/10 text-brand-400 border-brand-500/20':'bg-danger/10 text-danger border-danger/20')}>{c.source==='tls-secret'?'TLS Secret':'No TLS'}</span></td>
                        <td className="px-3 py-2.5 font-mono text-surface-500">{c.ingressName??<span className="text-surface-600">–</span>}</td>
                        <td className="px-3 py-2.5 text-surface-400 tabular-nums" suppressHydrationWarning>{c.expiresAt?new Date(c.expiresAt).toLocaleDateString():<span className="text-surface-600">–</span>}</td>
                        <td className="px-3 py-2.5 tabular-nums">{c.daysRemaining!=null?(<span className={cn('font-bold',c.daysRemaining<0?'text-danger':c.daysRemaining<7?'text-danger':c.daysRemaining<30?'text-warning':'text-success')}>{c.daysRemaining<0?`${Math.abs(c.daysRemaining)}d ago`:`${c.daysRemaining}d`}</span>):<span className="text-surface-600">–</span>}</td>
                        <td className="px-3 py-2.5"><span className={cn('text-2xs px-2 py-0.5 rounded-full border font-semibold',c.status==='ok'?'bg-success/10 text-success border-success/30':c.status==='warning'?'bg-warning/10 text-warning border-warning/30':c.status==='critical'?'bg-danger/10 text-danger border-danger/30 animate-pulse':c.status==='expired'?'bg-danger/20 text-danger border-danger/40 animate-pulse':'bg-surface-700 text-surface-400 border-surface-600')}>{c.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>

            {/* Service Mesh Status */}
            <div className="rounded-2xl bg-surface-900 border border-surface-800 p-4">
              <p className="text-sm font-semibold text-white mb-3 flex items-center gap-2"><Network className="w-4 h-4 text-brand-400" /> Service Mesh &amp; mTLS</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {([{key:'istio',label:'Istio',desc:'mTLS, circuit breaker, traffic mgmt',installCmd:'istioctl install --set profile=demo'},{key:'linkerd',label:'Linkerd',desc:'Lightweight mTLS & observability',installCmd:'linkerd install | kubectl apply -f -'},{key:'cilium',label:'Cilium',desc:'eBPF-based networking & policy',installCmd:'helm install cilium cilium/cilium -n kube-system'},{key:'hubble',label:'Hubble',desc:'L7 flow visibility (Cilium addon)',installCmd:'cilium hubble enable'}] as const).map(m=>{
                  const active=(netSecData.serviceMesh as any)[m.key]
                  return (<div key={m.key} className={cn('rounded-xl border p-3',active?'border-success/30 bg-success/5':'border-surface-700 bg-surface-800/40')}>
                    <div className="flex items-center gap-2 mb-1.5"><div className={cn('w-2 h-2 rounded-full flex-shrink-0',active?'bg-success':'bg-surface-600')} /><span className={cn('text-xs font-semibold',active?'text-success':'text-surface-400')}>{m.label}</span><span className={cn('ml-auto text-2xs px-1.5 py-0.5 rounded border font-medium whitespace-nowrap',active?'bg-success/10 text-success border-success/20':'bg-surface-700 text-surface-500 border-surface-600')}>{active?'active':'not installed'}</span></div>
                    <p className="text-2xs text-surface-500 leading-relaxed">{m.desc}</p>
                    {!active&&(<code className="mt-2 block text-2xs bg-surface-900 text-surface-400 rounded px-2 py-1 font-mono truncate" title={m.installCmd}>{m.installCmd}</code>)}
                  </div>)
                })}
              </div>
            </div>

            {/* Egress Tracking */}
            {(netSecData.egressByNs.length > 0 || netSecData.egressByPod.length > 0) && (
              <div className="rounded-2xl bg-surface-900 border border-surface-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-3">
                  <Activity className="w-4 h-4 text-purple-400" />
                  <span className="text-sm font-semibold text-white">Egress Traffic — Top Senders</span>
                  <span className="text-2xs text-surface-500 ml-1">5m avg · Prometheus</span>
                </div>
                <div className="grid grid-cols-2 divide-x divide-surface-800">
                  <div><div className="px-4 py-2 bg-surface-950 border-b border-surface-800"><span className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">By Namespace</span></div>
                    <div className="divide-y divide-surface-800/40">{netSecData.egressByNs.slice(0,8).map((ns:any)=>{const m=netSecData.egressByNs[0]?.egressMbps??0.01;return(<div key={ns.namespace} className="px-4 py-2.5 hover:bg-surface-800/30 transition-colors"><div className="flex items-center gap-2 mb-1"><span className="font-mono text-xs text-white w-32 truncate">{ns.namespace}</span><span className="text-2xs text-purple-400 tabular-nums ml-auto">↑ {ns.egressMbps.toFixed(3)} Mbps</span></div><div className="h-1 rounded-full bg-surface-800"><div className="h-full rounded-full bg-purple-500/60" style={{width:`${(ns.egressMbps/m)*100}%`}} /></div></div>)})}</div>
                  </div>
                  <div><div className="px-4 py-2 bg-surface-950 border-b border-surface-800"><span className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">By Pod (top 8)</span></div>
                    <div className="divide-y divide-surface-800/40">{netSecData.egressByPod.slice(0,8).map((p:any)=>{const m=netSecData.egressByPod[0]?.egressMbps??0.01;return(<div key={p.namespace+'/'+p.pod} className="px-4 py-2.5 hover:bg-surface-800/30 transition-colors"><div className="flex items-center gap-2 mb-1"><span className="font-mono text-xs text-white truncate max-w-[150px]" title={p.namespace+'/'+p.pod}>{p.pod}</span><span className="text-2xs text-surface-600 truncate">{p.namespace}</span><span className="text-2xs text-purple-400 tabular-nums ml-auto">↑ {p.egressMbps.toFixed(3)} Mbps</span></div><div className="h-1 rounded-full bg-surface-800"><div className="h-full rounded-full bg-purple-500/40" style={{width:`${(p.egressMbps/m)*100}%`}} /></div></div>)})}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

     
   {/* â”€â”€ EVENTS TAB â”€â”€ */}
      </div>

      {/* â”€â”€ CREATE INCIDENT MODAL â”€â”€ */}
      <AnimatePresence>
        {createModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setCreateModal(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 16 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-lg rounded-2xl bg-surface-900 border border-surface-700 shadow-2xl"
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
                <div className="flex items-center gap-2">
                  <Siren className="w-4 h-4 text-danger" />
                  <span className="text-sm font-bold text-white">Create Incident from K8s Event</span>
                </div>
                <button onClick={() => setCreateModal(null)} className="text-surface-500 hover:text-surface-300 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {createSuccess ? (
                <div className="px-5 py-10 text-center">
                  <CheckCircle2 className="w-10 h-10 text-success mx-auto mb-3" />
                  <p className="text-white font-semibold text-sm">Incident <span className="font-mono text-brand-400">{createSuccess.toUpperCase()}</span> created</p>
                  <p className="text-surface-500 text-xs mt-1">Redirecting to Incidents{'…'}</p>
                </div>
              ) : (
                <div className="px-5 py-4 space-y-4">
                  <div className="rounded-xl bg-surface-800 border border-surface-700 p-3 space-y-1.5">
                    <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Source Event</p>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-warning font-bold">{createModal.reason}</span>
                      <span className="text-2xs text-surface-500">{'·'} {createModal.namespace || 'cluster-scope'}</span>
                    </div>
                    <p className="text-xs text-surface-400 line-clamp-2">{createModal.message}</p>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1">Incident Title *</label>
                      <input
                        value={createForm.title}
                        onChange={e => setCreateForm(f => ({ ...f, title: e.target.value }))}
                        className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500 transition-colors"
                        placeholder="Describe the incidentâ€¦"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1">Severity</label>
                        <select
                          value={createForm.severity}
                          onChange={e => setCreateForm(f => ({ ...f, severity: e.target.value as typeof f.severity }))}
                          className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-brand-500 transition-colors"
                        >
                          {(['critical', 'high', 'medium'] as const).map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1">Owner</label>
                        <input
                          value={createForm.owner}
                          onChange={e => setCreateForm(f => ({ ...f, owner: e.target.value }))}
                          className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500 transition-colors"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => setCreateModal(null)} className="flex-1 px-4 py-2 rounded-xl bg-surface-800 border border-surface-700 text-sm text-surface-300 hover:text-white transition-all">Cancel</button>
                    <button
                      onClick={handleCreateIncident}
                      disabled={!createForm.title.trim()}
                      className="flex-1 px-4 py-2 rounded-xl bg-danger hover:bg-danger/80 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold flex items-center justify-center gap-1.5 transition-all"
                    >
                      <Siren className="w-3.5 h-3.5" /> Create Incident
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* PVC Delete Confirm Modal */}
      {confirmDeletePVC && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="rounded-2xl bg-surface-900 border border-surface-800 p-6 w-[420px] shadow-2xl">
            <h3 className="text-base font-bold text-white mb-2">Delete PVC?</h3>
            <p className="text-sm text-surface-400 mb-1">Delete <span className="text-white font-mono">{confirmDeletePVC.name}</span> in <span className="font-mono">{confirmDeletePVC.namespace}</span>?</p>
            <p className="text-xs text-surface-500 mb-4">Pods using this PVC may lose data.</p>
            <div className="flex gap-3 justify-end">
            <button onClick={() => setConfirmDeletePVC(null)} className="px-4 py-2 text-sm rounded-lg text-surface-400 hover:bg-surface-800 transition-all">Cancel</button>
            <button onClick={handleDeletePVC} disabled={!!deletingPVC} className="px-4 py-2 text-sm rounded-lg bg-danger text-white font-semibold hover:bg-danger/80 disabled:opacity-50 transition-all">{deletingPVC ? 'Deleting…' : 'Delete PVC'}</button>
            </div>
          </div>
        </div>
      )}
      {/* Restore Snapshot modal */}
      {restoreSnapshotModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="rounded-2xl bg-surface-900 border border-surface-800 p-6 w-[480px] shadow-2xl">
            <h3 className="text-base font-bold text-white mb-2 flex items-center gap-2">
              <Undo2 className="w-4 h-4 text-brand-400" /> Restore Snapshot
            </h3>
            <p className="text-sm text-surface-400 mb-4">
              Create a new PVC from snapshot{' '}
              <span className="font-mono text-white">{restoreSnapshotModal.name}</span>
              {' '}in namespace{' '}
              <span className="font-mono text-white">{restoreSnapshotModal.namespace}</span>
            </p>
            <div className="space-y-3 mb-4">
              <div>
                <label className="text-2xs font-semibold text-surface-500 uppercase tracking-wider block mb-1">New PVC Name</label>
                <input
                  type="text"
                  value={restoreNewPvcName}
                  onChange={e => setRestoreNewPvcName(e.target.value)}
                  className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-brand-500"
                  placeholder="restore-snapshot-name"
                />
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs text-surface-500">
                <div><span className="text-surface-600">Size:</span> {restoreSnapshotModal.restoreSize || restoreSnapshotModal.size || 'from snapshot'}</div>
                <div><span className="text-surface-600">Storage Class:</span> {restoreSnapshotModal.storageClass || 'default'}</div>
              </div>
            </div>
            {restoreSuccess && (
              <p className={cn('text-sm mb-3', restoreSuccess.startsWith('Error') ? 'text-danger' : 'text-success')}>{restoreSuccess}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setRestoreSnapshotModal(null); setRestoreSuccess(null); setRestoreNewPvcName('') }}
                className="px-4 py-2 rounded-lg text-sm text-surface-400 hover:bg-surface-800 transition-all"
              >Cancel</button>
              <button
                onClick={handleRestoreSnapshot}
                disabled={restoring || !restoreNewPvcName.trim()}
                className="px-4 py-2 rounded-lg text-sm bg-brand-500 hover:bg-brand-600 text-white font-semibold disabled:opacity-50 flex items-center gap-2 transition-all"
              >
                {restoring ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
                Restore
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Cordon confirm modal */}
      {confirmCordonNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="rounded-2xl bg-surface-900 border border-surface-800 p-6 w-[440px] shadow-2xl">
            <h3 className="text-base font-bold text-white mb-2 flex items-center gap-2">
              <Lock className="w-4 h-4 text-warning" /> Cordon Node?
            </h3>
            <p className="text-sm text-surface-400 mb-1">
              Cordon <span className="text-white font-mono">{confirmCordonNode.name}</span>?
            </p>
            <p className="text-xs text-surface-500 mb-4">New pods will not be scheduled on this node. Existing pods are unaffected.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmCordonNode(null)} className="px-4 py-2 text-sm rounded-lg text-surface-400 hover:bg-surface-800 transition-all">Cancel</button>
              <button onClick={() => { setConfirmCordonNode(null); handleCordonNode(confirmCordonNode) }} disabled={cordoningNode === confirmCordonNode.name} className="px-4 py-2 text-sm rounded-lg bg-warning text-black font-semibold hover:bg-warning/80 disabled:opacity-50 transition-all flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5" /> Cordon Node
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Drain confirm modal */}
      {confirmDrainNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="rounded-2xl bg-surface-900 border border-surface-800 p-6 w-[460px] shadow-2xl">
            <h3 className="text-base font-bold text-white mb-2 flex items-center gap-2">
              <Download className="w-4 h-4 text-danger" /> Drain Node?
            </h3>
            <p className="text-sm text-surface-400 mb-1">
              Drain <span className="text-white font-mono">{confirmDrainNode.name}</span>?
            </p>
            <p className="text-xs text-surface-500 mb-1">This will cordon the node and evict all non-DaemonSet pods.</p>
            <p className="text-xs text-warning mb-4">Workloads will be rescheduled to other nodes — ensure capacity exists.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmDrainNode(null)} className="px-4 py-2 text-sm rounded-lg text-surface-400 hover:bg-surface-800 transition-all">Cancel</button>
              <button onClick={() => handleDrainNode(confirmDrainNode)} disabled={!!drainingNode} className="px-4 py-2 text-sm rounded-lg bg-danger text-white font-semibold hover:bg-danger/80 disabled:opacity-50 transition-all flex items-center gap-1.5">
                <Download className="w-3.5 h-3.5" />{drainingNode ? 'Draining…' : 'Drain Node'}
              </button>
            </div>
          </div>
        </div>
      )}
      {drainResult && (
        <div className="fixed bottom-6 right-6 z-50 rounded-2xl bg-surface-900 border border-success/30 p-4 shadow-2xl flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-white">Drain complete</p>
            <p className="text-xs text-surface-400">{drainResult.evicted} pods evicted{drainResult.failed > 0 ? `, ${drainResult.failed} failed` : ''}</p>
          </div>
        </div>
      )}
      {/* PVC Resize modal */}
      {resizePVC && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="rounded-2xl bg-surface-900 border border-surface-800 p-6 w-[400px] shadow-2xl">
            <h3 className="text-base font-bold text-white mb-2 flex items-center gap-2">
              <Zap className="w-4 h-4 text-brand-400" /> Resize PVC
            </h3>
            <p className="text-sm text-surface-400 mb-3">
              <span className="font-mono text-white">{resizePVC.name}</span> in <span className="font-mono">{resizePVC.namespace}</span>
            </p>
            <div className="mb-4">
              <label className="block text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-1">
                New Size (GiB) — current: {resizePVC.currentGi} GiB
              </label>
              <input
                type="number"
                min={resizePVC.currentGi + 1}
                step={1}
                value={resizeSizeInput}
                onChange={e => setResizeSizeInput(e.target.value)}
                className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-brand-500 transition-colors"
              />
              <p className="text-2xs text-surface-500 mt-1">Must be larger than the current size. Storage class must support expansion.</p>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setResizePVC(null)} className="px-4 py-2 text-sm rounded-lg text-surface-400 hover:bg-surface-800 transition-all">Cancel</button>
              <button
                onClick={handleResizePVC}
                disabled={resizingPVC || parseFloat(resizeSizeInput) <= resizePVC.currentGi}
                className="px-4 py-2 text-sm rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 transition-all"
              >{resizingPVC ? 'Resizing…' : 'Resize PVC'}</button>
            </div>
          </div>
        </div>
      )}
      {yamlTarget && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setYamlTarget(null)} />
          <YamlViewer kind={yamlTarget.kind} namespace={yamlTarget.namespace} name={yamlTarget.name} onClose={() => setYamlTarget(null)} />
        </>
      )}

      {/* ── Taint Manager Modal ── */}
      {taintModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Manage Taints — {taintModal?.name}</h3>
              <button onClick={() => setTaintModal(null)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              {editTaints.map((t, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input value={t.key} onChange={e => setEditTaints(prev => prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                    placeholder="key" className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-brand-500" />
                  <input value={t.value ?? ''} onChange={e => setEditTaints(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                    placeholder="value" className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-brand-500" />
                  <select value={t.effect} onChange={e => setEditTaints(prev => prev.map((x, j) => j === i ? { ...x, effect: e.target.value as any } : x))}
                    className="bg-surface-800 border border-surface-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-brand-500">
                    <option>NoSchedule</option><option>PreferNoSchedule</option><option>NoExecute</option>
                  </select>
                  <button onClick={() => setEditTaints(prev => prev.filter((_, j) => j !== i))} className="text-danger hover:text-danger/80"><X className="w-3.5 h-3.5" /></button>
                </div>
              ))}
              <button onClick={() => setEditTaints(prev => [...prev, { key: '', value: '', effect: 'NoSchedule' }])}
                className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1.5 mt-1">+ Add taint</button>
            </div>
            <div className="px-5 py-3 border-t border-surface-800 flex justify-end gap-3">
              <button onClick={() => setTaintModal(null)} className="px-3 py-1.5 text-sm text-surface-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={handleSaveTaints} disabled={savingTaints}
                className="px-4 py-1.5 text-sm rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 transition-all">
                {savingTaints ? 'Saving…' : 'Save Taints'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Label Editor Modal ── */}
      {labelModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Edit Labels — {labelModal?.name}</h3>
              <button onClick={() => setLabelModal(null)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              {Object.entries(editLabels).filter(([k]) => !k.startsWith('kubernetes.io/')).map(([k, v]) => (
                <div key={k} className="flex gap-2 items-center">
                  <span className="flex-1 text-xs font-mono text-surface-300 bg-surface-800 rounded-lg px-2 py-1.5 border border-surface-700">{k}</span>
                  <input value={v ?? ''} onChange={e => setEditLabels(prev => ({ ...prev, [k]: e.target.value }))}
                    className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-brand-500" />
                  <button onClick={() => setEditLabels(prev => { const n = { ...prev }; n[k] = null as any; return n })} className="text-danger hover:text-danger/80"><X className="w-3.5 h-3.5" /></button>
                </div>
              ))}
              <button onClick={() => {
                const k = prompt('Label key:')
                if (k) setEditLabels(prev => ({ ...prev, [k]: '' }))
              }} className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1.5">+ Add label</button>
            </div>
            <div className="px-5 py-3 border-t border-surface-800 flex justify-end gap-3">
              <button onClick={() => setLabelModal(null)} className="px-3 py-1.5 text-sm text-surface-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={handleSaveLabels} disabled={savingLabels}
                className="px-4 py-1.5 text-sm rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 transition-all">
                {savingLabels ? 'Saving…' : 'Save Labels'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rolling Restart Result Toast ── */}
      {restartResult && (
        <div className="fixed bottom-6 right-6 z-50 rounded-2xl bg-surface-900 border border-success/30 p-4 shadow-2xl flex items-center gap-3 animate-in slide-in-from-bottom-4">
          <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-white">Node restart complete</p>
            <p className="text-xs text-surface-400">{restartResult.restarted} pods restarted on {restartResult.node}</p>
          </div>
          <button onClick={() => setRestartResult(null)} className="ml-2 text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ── StorageClass Creation Modal ── */}
      {createSCModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Create StorageClass</h3>
              <button onClick={() => setCreateSCModal(false)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              {([
                { key: 'name', label: 'Name', placeholder: 'e.g. fast-ssd' },
                { key: 'provisioner', label: 'Provisioner', placeholder: 'e.g. driver.longhorn.io' },
                { key: 'parameters', label: 'Parameters (k=v,k=v)', placeholder: 'numberOfReplicas=2,staleReplicaTimeout=2880' },
              ] as const).map(f => (
                <div key={f.key}>
                  <label className="block text-2xs text-surface-500 mb-1">{f.label}</label>
                  <input value={scForm[f.key]} onChange={e => setScForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-brand-500" />
                </div>
              ))}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-2xs text-surface-500 mb-1">Reclaim Policy</label>
                  <select value={scForm.reclaimPolicy} onChange={e => setScForm(prev => ({ ...prev, reclaimPolicy: e.target.value as any }))}
                    className="w-full bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500">
                    <option value="Delete">Delete</option><option value="Retain">Retain</option>
                  </select>
                </div>
                <div>
                  <label className="block text-2xs text-surface-500 mb-1">Binding Mode</label>
                  <select value={scForm.bindingMode} onChange={e => setScForm(prev => ({ ...prev, bindingMode: e.target.value as any }))}
                    className="w-full bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500">
                    <option value="Immediate">Immediate</option><option value="WaitForFirstConsumer">WaitForFirstConsumer</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-xs text-surface-300 cursor-pointer">
                  <input type="checkbox" checked={scForm.allowExpansion} onChange={e => setScForm(prev => ({ ...prev, allowExpansion: e.target.checked }))} className="rounded" />
                  Allow volume expansion
                </label>
                <label className="flex items-center gap-2 text-xs text-surface-300 cursor-pointer">
                  <input type="checkbox" checked={scForm.isDefault} onChange={e => setScForm(prev => ({ ...prev, isDefault: e.target.checked }))} className="rounded" />
                  Set as default
                </label>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-surface-800 flex justify-end gap-3">
              <button onClick={() => setCreateSCModal(false)} className="px-3 py-1.5 text-sm text-surface-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={handleCreateSC} disabled={creatingSC || !scForm.name || !scForm.provisioner}
                className="px-4 py-1.5 text-sm rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 transition-all">
                {creatingSC ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Snapshot Creation Modal ── */}
      {createSnapshotPVC && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Create Snapshot</h3>
              <button onClick={() => setCreateSnapshotPVC(null)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-surface-400">Source PVC: <span className="font-mono text-white">{createSnapshotPVC.namespace}/{createSnapshotPVC.name}</span></p>
              <div>
                <label className="block text-2xs text-surface-500 mb-1">Snapshot Name</label>
                <input value={snapshotName} onChange={e => setSnapshotName(e.target.value)}
                  placeholder={`${createSnapshotPVC.name}-snap-${Date.now()}`}
                  className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-brand-500" />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-surface-800 flex justify-end gap-3">
              <button onClick={() => setCreateSnapshotPVC(null)} className="px-3 py-1.5 text-sm text-surface-400 hover:text-white transition-colors">Cancel</button>
              <button
                onClick={handleCreateSnapshot}
                disabled={creatingSnapshot || !snapshotName.trim()}
                className="px-4 py-1.5 text-sm rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 transition-all">
                {creatingSnapshot ? 'Creating…' : 'Create Snapshot'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Suppression Rules Modal ── */}
      {showSuppressionModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2"><BellOff className="w-4 h-4 text-warning" /> Event Suppression Rules</h3>
              <button onClick={() => setShowSuppressionModal(false)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-4">
              {/* Active rules */}
              {suppressionRules.filter(r => r.expiresAt > Date.now()).length > 0 && (
                <div className="space-y-2">
                  <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Active Rules</p>
                  {suppressionRules.filter(r => r.expiresAt > Date.now()).map(r => (
                    <div key={r.id} className="flex items-center gap-3 bg-surface-800/50 rounded-xl px-3 py-2">
                      <span className="flex-1 text-xs font-mono text-warning">{r.reason}</span>
                      <span className="text-2xs text-surface-500">expires {new Date(r.expiresAt).toLocaleTimeString()}</span>
                      <button onClick={() => handleRemoveSuppressionRule(r.id)} className="text-danger hover:text-danger/80"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              )}
              {/* Add new rule */}
              <div className="space-y-2">
                <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Add Rule</p>
                <div className="flex gap-2">
                  <input value={newSupRule.reason} onChange={e => setNewSupRule(prev => ({ ...prev, reason: e.target.value }))}
                    placeholder="Reason (e.g. BackOff)" className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500" />
                  <select value={newSupRule.durationMin} onChange={e => setNewSupRule(prev => ({ ...prev, durationMin: parseInt(e.target.value) }))}
                    className="bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500">
                    <option value={60}>1h</option><option value={240}>4h</option><option value={1440}>24h</option><option value={4320}>72h</option>
                  </select>
                  <button onClick={handleAddSuppressionRule} disabled={!newSupRule.reason.trim()}
                    className="px-3 py-1.5 text-xs rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 transition-all">Add</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Webhook Config Modal ── */}
      {showWebhookModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2"><Link2 className="w-4 h-4 text-brand-400" /> Webhook Configuration</h3>
              <button onClick={() => setShowWebhookModal(false)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-surface-400">Warning events will POST a JSON payload to this URL.</p>
              <input value={webhookInput} onChange={e => setWebhookInput(e.target.value)}
                placeholder="https://hooks.slack.com/…"
                className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-brand-500" />
              {webhookUrl && (
                <button onClick={() => handleTriggerWebhook({ type: 'Warning', reason: 'Test', message: 'VynOps test event', count: 1, namespace: 'test' } as any)}
                  className="text-2xs text-brand-400 hover:text-brand-300">Send test event</button>
              )}
            </div>
            <div className="px-5 py-3 border-t border-surface-800 flex justify-end gap-3">
              {webhookUrl && <button onClick={() => { setWebhookInput(''); handleSaveWebhook() }} className="px-3 py-1.5 text-sm text-danger hover:text-danger/80 transition-colors">Clear</button>}
              <button onClick={() => setShowWebhookModal(false)} className="px-3 py-1.5 text-sm text-surface-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={handleSaveWebhook}
                className="px-4 py-1.5 text-sm rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 transition-all">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Auto-Escalation Config Panel ── */}
      {showAutoEsc && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-900 border border-surface-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-5 py-4 border-b border-surface-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2"><Bell className="w-4 h-4 text-orange-400" /> Auto-Escalation Rules</h3>
              <button onClick={() => setShowAutoEsc(false)} className="text-surface-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-4">
              {autoEscRules.length > 0 && (
                <div className="space-y-2">
                  <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Active Rules</p>
                  {autoEscRules.map(r => (
                    <div key={r.reason} className="flex items-center gap-3 bg-surface-800/50 rounded-xl px-3 py-2">
                      <span className="flex-1 text-xs font-mono text-orange-300">{r.reason}</span>
                      <span className="text-2xs text-surface-500">threshold {r.minCount}×</span>
                      <span className={cn('text-2xs font-bold px-1.5 py-0.5 rounded', r.severity === 'critical' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning')}>{r.severity}</span>
                      <button onClick={() => setAutoEscRules(prev => prev.filter(x => x.reason !== r.reason))} className="text-danger hover:text-danger/80"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-2">
                <p className="text-2xs font-semibold text-surface-500 uppercase tracking-wider">Add Rule</p>
                <div className="flex gap-2">
                  <input value={newEscRule.reason} onChange={e => setNewEscRule(prev => ({ ...prev, reason: e.target.value }))}
                    placeholder="Reason (e.g. OOMKilling)"
                    className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500" />
                  <input type="number" value={newEscRule.minCount} onChange={e => setNewEscRule(prev => ({ ...prev, minCount: parseInt(e.target.value) }))}
                    className="w-16 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500" />
                  <select value={newEscRule.severity} onChange={e => setNewEscRule(prev => ({ ...prev, severity: e.target.value as any }))}
                    className="bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand-500">
                    <option value="warning">warning</option><option value="critical">critical</option>
                  </select>
                  <button onClick={handleAddAutoEscRule} disabled={!newEscRule.reason.trim()}
                    className="px-3 py-1.5 text-xs rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 transition-all">Add</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {yamlTarget && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setYamlTarget(null)} />
          <YamlViewer kind={yamlTarget.kind} namespace={yamlTarget.namespace} name={yamlTarget.name} onClose={() => setYamlTarget(null)} />
        </>
      )}
      {describeTarget && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setDescribeTarget(null)} />
          <DescribeViewer kind={describeTarget.kind} namespace={describeTarget.namespace} name={describeTarget.name} onClose={() => setDescribeTarget(null)} />
        </>
      )}

      {/* ── Per-Node Network Popup ────────────────────────────────────── */}
      {netNodePopup && (
        <>
          <div className="fixed inset-0 bg-black/60 z-50" onClick={() => setNetNodePopup(null)} />
          <div className="fixed inset-x-4 top-[5%] bottom-[5%] sm:inset-x-[10%] sm:top-[8%] sm:bottom-[8%] z-50 flex flex-col rounded-2xl bg-surface-900 border border-brand-500/30 shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-surface-800 flex-shrink-0">
              <Network className="w-4 h-4 text-brand-400 flex-shrink-0" />
              <span className="text-sm font-semibold text-white">{netNodePopup.nodeName} — Network I/O</span>
              <span className="text-2xs text-surface-500 ml-1">Ingress &amp; Egress · last {netNodePopup.drillWin}m</span>
              {/* Window selector */}
              <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                {[{l:'15m',v:15},{l:'30m',v:30},{l:'1h',v:60},{l:'3h',v:180},{l:'6h',v:360}].map(w => (
                  <button key={w.v}
                    onClick={async () => {
                      try {
                        const headers: Record<string,string> = activeCluster ? { 'X-Prom-Url': activeCluster.promUrl||'none', 'X-K8s-Url': activeCluster.k8sUrl||'none' } : {}
                        const r = await fetch(`/api/k8s/network?window=${w.v}`, { headers })
                        const j = await r.json()
                        const n = (j.nodes ?? []).find((x: any) => x.name === netNodePopup.nodeName)
                        if (!n) return
                        const sparkIn: number[] = n.sparkIn ?? []
                        const sparkOut: number[] = n.sparkOut ?? []
                        const len = Math.max(sparkIn.length, sparkOut.length, 2)
                        const now2 = Date.now(); const winMs2 = w.v*60*1000; const step2 = winMs2/(len-1)
                        const chartData = Array.from({ length: len }, (_,i) => ({ ts: Math.round(now2-winMs2+i*step2), a: sparkIn[i]??0, b: sparkOut[i]??0 }))
                        setNetNodePopup(p => p ? { ...p, chartData, drillWin: w.v } : null)
                      } catch {}
                    }}
                    className={cn('text-2xs px-2 py-0.5 rounded border transition-all',
                      netNodePopup.drillWin === w.v ? 'bg-brand-500/20 text-brand-400 border-brand-500/30' : 'bg-surface-800 text-surface-500 border-surface-700 hover:text-surface-300'
                    )}>{w.l}</button>
                ))}
              </div>
              <button onClick={() => setNetNodePopup(null)} className="text-surface-500 hover:text-white transition-colors flex-shrink-0 ml-2">
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* Chart */}
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
              <DualSeriesChart
                data={netNodePopup.chartData}
                series={[
                  { key: 'a', label: 'Ingress', color: '#38bdf8' },
                  { key: 'b', label: 'Egress',  color: '#a855f7' },
                ]}
                unit=" Mbps"
                height={280}
                onPointClick={async (ts) => {
                  const tsS = Math.floor(ts / 1000)
                  setNetNodePopup(p => p ? { ...p, drill: { ts: tsS, metric: 'network_rx', rows: null, loading: true } } : null)
                  try {
                    const headers: Record<string, string> = activeCluster ? { 'X-Prom-Url': activeCluster.promUrl || 'none', 'X-K8s-Url': activeCluster.k8sUrl || 'none' } : {}
                    const [rxRes, txRes] = await Promise.all([
                      fetch(`/api/observability/breakdown?metric=network_rx&at=${tsS}`, { headers }).then(r => r.json()),
                      fetch(`/api/observability/breakdown?metric=network_tx&at=${tsS}`, { headers }).then(r => r.json()),
                    ])
                    // Merge rx+tx rows by pod name, show combined
                    const combined = new Map<string, { name: string; rx: number; tx: number; unit: string }>()
                    for (const row of (rxRes.rows ?? [])) {
                      combined.set(row.name, { name: row.name, rx: row.value, tx: 0, unit: row.unit })
                    }
                    for (const row of (txRes.rows ?? [])) {
                      const existing = combined.get(row.name)
                      if (existing) existing.tx = row.value
                      else combined.set(row.name, { name: row.name, rx: 0, tx: row.value, unit: row.unit })
                    }
                    const rows = Array.from(combined.values())
                      .map(r => ({ name: r.name, value: parseFloat((r.rx + r.tx).toFixed(2)), unit: r.unit }))
                      .sort((a, b) => b.value - a.value)
                      .slice(0, 10)
                    setNetNodePopup(p => p ? { ...p, drill: { ts: tsS, metric: 'network_rx', rows, loading: false } } : null)
                  } catch {
                    setNetNodePopup(p => p ? { ...p, drill: p.drill ? { ...p.drill, loading: false } : null } : null)
                  }
                }}
              />
              <p className="text-2xs text-surface-600 text-center">scroll to zoom · drag to pan · double-click to reset · click a point to see top contributors</p>

              {/* Drill-down panel */}
              {netNodePopup.drill && (
                <div className="rounded-xl bg-surface-950 border border-surface-800 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-800">
                    <Activity className="w-3.5 h-3.5 text-sky-400" />
                    <span className="text-xs font-semibold text-white">
                      Top network contributors at {new Date(netNodePopup.drill.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                    </span>
                    {netNodePopup.drill.loading && <Loader2 className="w-3 h-3 text-sky-400 animate-spin ml-1" />}
                    <button onClick={() => setNetNodePopup(p => p ? { ...p, drill: null } : null)} className="ml-auto text-surface-600 hover:text-white transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="p-3 space-y-1.5" style={{ opacity: netNodePopup.drill.loading ? 0.4 : 1, transition: 'opacity 0.15s' }}>
                    {!netNodePopup.drill.loading && netNodePopup.drill.rows !== null && netNodePopup.drill.rows.length === 0 && (
                      <p className="text-xs text-surface-500 text-center py-3">No contributor data at this timestamp</p>
                    )}
                    {(netNodePopup.drill.rows ?? []).map((row) => {
                      const max = netNodePopup.drill!.rows![0]?.value ?? 1
                      const isPodRow = row.name.includes('/')
                      const [nsName, podName] = isPodRow ? row.name.split('/') : ['', row.name]
                      return (
                        <div key={row.name} className="flex items-center gap-3">
                          <span className="text-xs font-mono text-surface-300 w-56 truncate flex-shrink-0" title={row.name}>{row.name}</span>
                          <div className="flex-1 h-2.5 bg-surface-800 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-sky-500/70 transition-all" style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }} />
                          </div>
                          <span className="text-xs font-mono tabular-nums text-white w-20 text-right flex-shrink-0">{row.value.toFixed(2)} {row.unit}</span>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {isPodRow && (
                              <>
                                <a href={`/kubernetes?tab=Pods&pod=${encodeURIComponent(podName)}&ns=${encodeURIComponent(nsName)}`}
                                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-brand-400 transition-colors" title="Open in Kubernetes">
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                                <a href={`/observability?tab=Logs`}
                                  onClick={() => {
                                    if (typeof window !== 'undefined') {
                                      sessionStorage.setItem('vynops-loki-jump', JSON.stringify({
                                        query: `{namespace="${nsName}"} |= "${podName.split('-').slice(0, -2).join('-') || podName}"`,
                                        start: netNodePopup.drill!.ts - 15 * 60,
                                        end: netNodePopup.drill!.ts + 15 * 60,
                                      }))
                                    }
                                  }}
                                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-amber-400 transition-colors" title="View logs around this spike">
                                  <ScrollText className="w-3 h-3" />
                                </a>
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Node Metric Popup ──────────────────────────────────────────── */}
      {nodePopup && (
        <>
          <div className="fixed inset-0 bg-black/60 z-50" onClick={() => setNodePopup(null)} />
          <div className="fixed inset-x-4 top-[5%] bottom-[5%] sm:inset-x-[10%] sm:top-[8%] sm:bottom-[8%] z-50 flex flex-col rounded-2xl bg-surface-900 border border-brand-500/30 shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-surface-800 flex-shrink-0">
              <Zap className="w-4 h-4 text-brand-400 flex-shrink-0" />
              <span className="text-sm font-semibold text-white capitalize">{nodePopup.nodeName} — {nodePopup.metric === 'cpu' ? 'CPU Usage' : 'Memory Usage'}</span>
              <span className="text-2xs text-surface-500 ml-1">last {sparkWinLabel} · click chart to drill down</span>
              {/* Window selector */}
              <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                {[{l:'15m',v:15},{l:'30m',v:30},{l:'1h',v:60},{l:'3h',v:180},{l:'6h',v:360}].map(w => (
                  <button key={w.v}
                    onClick={async () => {
                      // Re-fetch with new window
                      try {
                        const headers: Record<string,string> = activeCluster ? { 'X-Prom-Url': activeCluster.promUrl || 'none', 'X-K8s-Url': activeCluster.k8sUrl || 'none' } : {}
                        const r = await fetch(`/api/k8s/nodes/metrics?window=${w.v}`, { headers })
                        const j = await r.json()
                        const n = (j.nodes ?? []).find((x: any) => x.name === nodePopup.nodeName)
                        if (!n) return
                        const arr: number[] = nodePopup.metric === 'cpu' ? n.sparkCpu : n.sparkMem
                        const now2 = Date.now(); const winMs2 = w.v*60*1000; const step2 = winMs2/(arr.length-1||1)
                        setNodePopup(p => p ? { ...p, chartData: arr.map((v,i) => ({ ts: Math.round(now2-winMs2+i*step2), value: v })), drill: null, drillWin: w.v } : null)
                      } catch {}
                    }}
                    className={cn('text-2xs px-2 py-0.5 rounded border transition-all',
                      nodePopup.drillWin === w.v ? 'bg-brand-500/20 text-brand-400 border-brand-500/30' : 'bg-surface-800 text-surface-500 border-surface-700 hover:text-surface-300'
                    )}>{w.l}</button>
                ))}
              </div>
              <button onClick={() => setNodePopup(null)} className="text-surface-500 hover:text-white transition-colors flex-shrink-0 ml-2">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
              {/* Full interactive chart */}
              <MetricChart
                data={nodePopup.chartData}
                label=""
                unit={nodePopup.unit}
                color={nodePopup.color}
                height={200}
                onPointClick={async (ts, value) => {
                  const tsS = Math.floor(ts / 1000)
                  setNodePopup(p => p ? { ...p, drill: { ts: tsS, rows: null, loading: true } } : null)
                  try {
                    const headers: Record<string,string> = activeCluster ? { 'X-Prom-Url': activeCluster.promUrl || 'none', 'X-K8s-Url': activeCluster.k8sUrl || 'none' } : {}
                    const metric = nodePopup.metric === 'cpu' ? 'cpu' : 'memory'
                    const r = await fetch(`/api/observability/breakdown?metric=${metric}&at=${tsS}`, { headers })
                    const j = await r.json()
                    const rows = (j.rows ?? []).slice(0, 10).map((row: any) => ({ name: row.name, value: row.value, unit: row.unit }))
                    setNodePopup(p => p ? { ...p, drill: { ts: tsS, rows, loading: false } } : null)
                  } catch {
                    setNodePopup(p => p ? { ...p, drill: p.drill ? { ...p.drill, loading: false } : null } : null)
                  }
                }}
              />

              {/* Drill-down panel */}
              {nodePopup.drill && (
                <div className="rounded-xl bg-surface-950 border border-surface-800 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-800">
                    <Zap className="w-3.5 h-3.5 text-brand-400" />
                    <span className="text-xs font-semibold text-white">
                      Top {nodePopup.metric === 'cpu' ? 'CPU' : 'Memory'} consumers at {new Date(nodePopup.drill.ts * 1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false })}
                    </span>
                    {nodePopup.drill.loading && <Loader2 className="w-3 h-3 text-brand-400 animate-spin ml-1" />}
                    <button onClick={() => setNodePopup(p => p ? { ...p, drill: null } : null)} className="ml-auto text-surface-600 hover:text-white transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="p-3 space-y-1.5" style={{ opacity: nodePopup.drill.loading ? 0.4 : 1, transition: 'opacity 0.15s' }}>
                    {!nodePopup.drill.loading && nodePopup.drill.rows !== null && nodePopup.drill.rows.length === 0 && (
                      <p className="text-xs text-surface-500 text-center py-3">No contributor data at this timestamp</p>
                    )}
                    {(nodePopup.drill.rows ?? []).map((row, i) => {
                      const max = nodePopup.drill!.rows![0]?.value ?? 1
                      const isPodRow = row.name.includes('/')
                      const [nsName, podName] = isPodRow ? row.name.split('/') : ['', row.name]
                      return (
                        <div key={row.name} className="flex items-center gap-3">
                          <span className="text-xs font-mono text-surface-300 w-56 truncate flex-shrink-0" title={row.name}>{row.name}</span>
                          <div className="flex-1 h-2.5 bg-surface-800 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-brand-500/70 transition-all" style={{ width: `${max > 0 ? (row.value/max)*100 : 0}%` }} />
                          </div>
                          <span className="text-xs font-mono tabular-nums text-white w-20 text-right flex-shrink-0">{row.value.toFixed(2)} {row.unit}</span>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {isPodRow && (
                              <>
                                <a href={`/kubernetes?tab=Pods&pod=${encodeURIComponent(podName)}&ns=${encodeURIComponent(nsName)}`}
                                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-brand-400 transition-colors" title="Open in Kubernetes">
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                                <a href={`/observability?tab=Logs`}
                                  onClick={() => {
                                    // Pre-fill Loki query via localStorage signal (simple cross-page comms)
                                    if (typeof window !== 'undefined') {
                                      sessionStorage.setItem('vynops-loki-jump', JSON.stringify({
                                        query: `{namespace="${nsName}"} |= "${podName.split('-').slice(0,-2).join('-') || podName}"`,
                                        start: nodePopup.drill!.ts - 15*60,
                                        end: nodePopup.drill!.ts + 15*60,
                                      }))
                                    }
                                  }}
                                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-amber-400 transition-colors" title="View logs around this spike">
                                  <ScrollText className="w-3 h-3" />
                                </a>
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Static top consumers (always visible) */}
              {(() => {
                const nm2 = nodeMetricsMap[nodePopup.nodeName]
                const topList = nodePopup.metric === 'cpu' ? nm2?.topCpu : nm2?.topMem
                if (!topList?.length) return null
                return (
                  <div className="rounded-xl bg-surface-950 border border-surface-800 overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-surface-800">
                      <span className="text-xs font-semibold text-surface-400">Current top {nodePopup.metric === 'cpu' ? 'CPU' : 'memory'} consumers</span>
                    </div>
                    <table className="w-full text-xs">
                      <thead><tr className="border-b border-surface-800 bg-surface-900">
                        <th className="px-3 py-1.5 text-left text-2xs text-surface-500 uppercase">Pod</th>
                        <th className="px-3 py-1.5 text-left text-2xs text-surface-500 uppercase">NS</th>
                        <th className="px-3 py-1.5 text-right text-2xs text-surface-500 uppercase">{nodePopup.metric === 'cpu' ? 'CPU' : 'Mem'}</th>
                        <th className="w-8" />
                      </tr></thead>
                      <tbody>
                        {topList.map((p: any) => (
                          <tr key={`${p.namespace}/${p.pod}`} className="border-b border-surface-800/40 hover:bg-surface-800/30 transition-colors">
                            <td className="px-3 py-2 font-mono text-white truncate max-w-[160px]">{p.pod}</td>
                            <td className="px-3 py-2 text-surface-500">{p.namespace}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-brand-400 font-semibold">{p.valueFmt}</td>
                            <td className="px-2 py-2">
                              <a href={`/kubernetes?tab=Pods&pod=${encodeURIComponent(p.pod)}&ns=${encodeURIComponent(p.namespace)}`}
                                className="text-surface-600 hover:text-brand-400 transition-colors" title="Open in Kubernetes">
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </div>
          </div>
        </>
      )}

      {/* ── Storage I/O Popup ──────────────────────────────────────────── */}
      {ioPopup && (() => {
        const now = Date.now()
        const winMs = ioPopup.ioWin * 60 * 1000
        const n = Math.max(ioPopup.sparkRead.length, ioPopup.sparkWrite.length, ioPopup.sparkReadMBs.length, ioPopup.sparkWriteMBs.length, 2)
        const stepMs = winMs / (n - 1)

        // Build merged time-series: { ts, read, write } and { ts, readMBs, writeMBs }
        const iopsData = Array.from({ length: n }, (_, i) => ({
          ts:    Math.round(now - winMs + i * stepMs),
          read:  Math.round((ioPopup.sparkRead[i]  ?? 0) * 10) / 10,
          write: Math.round((ioPopup.sparkWrite[i] ?? 0) * 10) / 10,
        }))
        const mbData = Array.from({ length: n }, (_, i) => ({
          ts:       Math.round(now - winMs + i * stepMs),
          readMBs:  Math.round((ioPopup.sparkReadMBs[i]  ?? 0) * 1000) / 1000,
          writeMBs: Math.round((ioPopup.sparkWriteMBs[i] ?? 0) * 1000) / 1000,
        }))

        const stats = [
          { label: 'Read IOPS',  value: ioPopup.readIops,  color: '#38bdf8', unit: '/s'    },
          { label: 'Write IOPS', value: ioPopup.writeIops, color: '#a855f7', unit: '/s'    },
          { label: 'Read MB/s',  value: ioPopup.readMBs,   color: '#34d399', unit: ' MB/s' },
          { label: 'Write MB/s', value: ioPopup.writeMBs,  color: '#f97316', unit: ' MB/s' },
        ]

        return (
          <>
            <div className="fixed inset-0 bg-black/60 z-50" onClick={() => { setIoPopup(null); setIoDrill(null) }} />
            <div className="fixed inset-x-4 top-[5%] bottom-[5%] sm:inset-x-[10%] sm:top-[8%] sm:bottom-[8%] z-50 flex flex-col rounded-2xl bg-surface-900 border border-brand-500/30 shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center gap-3 px-5 py-3.5 border-b border-surface-800 flex-shrink-0">
                <HardDrive className="w-4 h-4 text-brand-400 flex-shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-semibold text-white truncate">{ioPopup.pod}</span>
                  <span className="text-2xs text-surface-500">{ioPopup.namespace} · Storage I/O · last {ioPopup.ioWin >= 60 ? `${ioPopup.ioWin / 60}h` : `${ioPopup.ioWin}m`}</span>
                </div>
                {/* Window selector */}
                <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                  {[{l:'15m',v:15},{l:'30m',v:30},{l:'1h',v:60},{l:'3h',v:180},{l:'6h',v:360}].map(w => (
                    <button key={w.v}
                      onClick={async () => {
                        try {
                          const headers: Record<string,string> = activeCluster ? { 'X-Prom-Url': activeCluster.promUrl || 'none', 'X-K8s-Url': activeCluster.k8sUrl || 'none' } : {}
                          const r = await fetch(`/api/k8s/storage-iops?window=${w.v}`, { headers })
                          const j = await r.json()
                          const entry = (j.pvcs ?? []).find((p: any) => p.pod === ioPopup.pod && p.namespace === ioPopup.namespace)
                          if (!entry) { setIoPopup(p => p ? { ...p, ioWin: w.v, sparkRead: [], sparkWrite: [], sparkReadMBs: [], sparkWriteMBs: [] } : null); setIoDrill(null); return }
                          setIoPopup(p => p ? { ...p, ioWin: w.v, sparkRead: entry.sparkRead ?? [], sparkWrite: entry.sparkWrite ?? [], sparkReadMBs: entry.sparkReadMBs ?? [], sparkWriteMBs: entry.sparkWriteMBs ?? [], readIops: entry.readIops ?? 0, writeIops: entry.writeIops ?? 0, readMBs: entry.readMBs ?? 0, writeMBs: entry.writeMBs ?? 0 } : null)
                          setIoDrill(null)
                        } catch {}
                      }}
                      className={cn('text-2xs px-2 py-0.5 rounded border transition-all',
                        ioPopup.ioWin === w.v ? 'bg-brand-500/20 text-brand-400 border-brand-500/30' : 'bg-surface-800 text-surface-500 border-surface-700 hover:text-surface-300'
                      )}>{w.l}</button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-2 flex-shrink-0">
                  <a href={`/observability?tab=Logs`}
                    className="flex items-center gap-1 text-2xs px-2.5 py-1 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 transition-all"
                    onClick={() => {
                      if (typeof window !== 'undefined') {
                        const now = Math.floor(Date.now() / 1000)
                        sessionStorage.setItem('vynops-loki-jump', JSON.stringify({
                          query: `{namespace="${ioPopup.namespace}"} |= "${ioPopup.pod.split('-').slice(0, -2).join('-') || ioPopup.pod}"`,
                          start: now - ioPopup.ioWin * 60,
                          end: now,
                        }))
                      }
                      setIoPopup(null)
                    }}>
                    <FileText className="w-3 h-3" /> logs
                  </a>
                  <a href={`/kubernetes?tab=Pods&pod=${encodeURIComponent(ioPopup.pod)}&ns=${encodeURIComponent(ioPopup.namespace)}`}
                    className="flex items-center gap-1 text-2xs px-2.5 py-1 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 transition-all"
                    onClick={() => setIoPopup(null)}>
                    <ExternalLink className="w-3 h-3" /> k8s
                  </a>
                  <button onClick={() => { setIoPopup(null); setIoDrill(null) }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-800 text-surface-400 hover:text-white transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Current-value stat bar */}
              <div className="grid grid-cols-4 divide-x divide-surface-800 border-b border-surface-800 flex-shrink-0">
                {stats.map(s => (
                  <div key={s.label} className="px-4 py-2.5 flex flex-col">
                    <span className="text-2xs text-surface-500">{s.label}</span>
                    <span className="text-sm font-bold tabular-nums" style={{ color: s.color }}>
                      {(s.unit === ' MB/s' ? s.value.toFixed(3) : s.value.toFixed(1))}{s.unit}
                    </span>
                  </div>
                ))}
              </div>

              {/* Two panels */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
                {/* Panel 1: IOPS */}
                <div className="rounded-xl bg-surface-950 border border-surface-800 p-4">
                  <p className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3">IOPS (operations/s)</p>
                  {iopsData.length > 1 ? (
                    <DualSeriesChart
                      data={iopsData}
                      series={[
                        { key: 'read',  label: 'Read',  color: '#38bdf8' },
                        { key: 'write', label: 'Write', color: '#a855f7' },
                      ]}
                      unit="/s"
                      height={200}
                      onPointClick={ts => setIoDrill({ ts })}
                    />
                  ) : (
                    <div className="h-20 flex items-center justify-center text-surface-600 text-sm">No IOPS data</div>
                  )}
                </div>

                {/* Panel 2: Throughput */}
                <div className="rounded-xl bg-surface-950 border border-surface-800 p-4">
                  <p className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3">Throughput (MB/s)</p>
                  {mbData.length > 1 ? (
                    <DualSeriesChart
                      data={mbData}
                      series={[
                        { key: 'readMBs',  label: 'Read',  color: '#34d399' },
                        { key: 'writeMBs', label: 'Write', color: '#f97316' },
                      ]}
                      unit=" MB/s"
                      height={200}
                      onPointClick={ts => setIoDrill({ ts })}
                    />
                  ) : (
                    <div className="h-20 flex items-center justify-center text-surface-600 text-sm">No throughput data</div>
                  )}
                </div>

                <p className="text-2xs text-surface-700 text-center">scroll to zoom · drag to select · double-click to reset · click chart to jump to logs</p>

                {/* Log drill panel */}
                {ioDrill && (
                  <div className="rounded-xl bg-surface-950 border border-brand-500/20 overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-800">
                      <FileText className="w-3.5 h-3.5 text-brand-400" />
                      <span className="text-xs font-semibold text-white">
                        Logs near {new Date(ioDrill.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                      </span>
                      <button onClick={() => setIoDrill(null)} className="ml-auto text-surface-600 hover:text-white transition-colors">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="px-4 py-3 flex items-center justify-between gap-4">
                      <p className="text-xs text-surface-400">
                        View <span className="text-white font-medium">{ioPopup.pod}</span> logs ±15 min around this spike
                      </p>
                      <a
                        href="/observability?tab=Logs"
                        onClick={() => {
                          if (typeof window !== 'undefined') {
                            const tsS = Math.floor(ioDrill.ts / 1000)
                            sessionStorage.setItem('vynops-loki-jump', JSON.stringify({
                              query: `{namespace="${ioPopup.namespace}"} |= "${ioPopup.pod.split('-').slice(0, -2).join('-') || ioPopup.pod}"`,
                              start: tsS - 15 * 60,
                              end:   tsS + 15 * 60,
                            }))
                          }
                          setIoPopup(null); setIoDrill(null)
                        }}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-brand-500/20 hover:bg-brand-500/30 text-brand-400 border border-brand-500/30 transition-all flex-shrink-0"
                      >
                        <FileText className="w-3 h-3" /> View logs
                      </a>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}
    </div>
  )
}

