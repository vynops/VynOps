'use client'

import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Network, Search, ZoomIn, ZoomOut, Maximize2, RefreshCw,
  Wifi, WifiOff, X, Activity, AlertTriangle, CheckCircle2,
  ExternalLink, Play, Loader2,
} from 'lucide-react'
import { useLiveData } from '@/hooks/useLiveData'
import { cn } from '@/lib/utils'
import { useDashboardStore } from '@/store'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'

// ── Types ─────────────────────────────────────────────────────────────────
interface TopoNode {
  id: string; label: string; type: string
  status: 'healthy' | 'degraded' | 'critical'
  namespace: string; podCount: number; readyPods: number
  txKbps: number; rxKbps: number; restarts24h: number; cpuCores: number
  x: number; y: number
}
interface TopoEdge {
  id: string; source: string; target: string
  txKbps: number; errorRate: number; protocol: string
}
interface TopoData {
  topology: { nodes: TopoNode[]; edges: TopoEdge[]; updatedAt: string }
  summary: {
    healthy: number; degraded: number; critical: number
    totalTxKbps: number; totalRxKbps: number; namespaces: string[]
  }
}

const EMPTY: TopoData = {
  topology: { nodes: [], edges: [], updatedAt: '' },
  summary: { healthy: 0, degraded: 0, critical: 0, totalTxKbps: 0, totalRxKbps: 0, namespaces: [] },
}

// ── Visual constants ───────────────────────────────────────────────────────
const STATUS_CLR: Record<string, string> = {
  healthy: '#22c55e', degraded: '#f59e0b', critical: '#ef4444', unknown: '#6b7280',
}
const TYPE_CLR: Record<string, string> = {
  gateway: '#6366f1', service: '#06b6d4', database: '#8b5cf6', queue: '#f97316', external: '#64748b',
}
const NS_PALETTE = ['#6366f1', '#06b6d4', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#f97316']

// ── Diagnosis button (extracted to satisfy Rules of Hooks) ──────────────────
function DiagnosisButton({ node }: { node: TopoNode }) {
  const [running, setRunning] = useState(false)
  const [result,  setResult]  = useState<string | null>(null)
  async function runDiagnosis() {
    setRunning(true); setResult(null)
    try {
      const r = await fetch('/api/automation/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runbookId: 'diagnose-crash-loop', namespace: node.namespace, target: node.label }),
      })
      const d = await r.json()
      setResult(r.ok ? 'Diagnosis started — check Automation history' : (d.error ?? 'Failed'))
    } catch { setResult('Network error') }
    finally { setRunning(false) }
  }
  return (
    <div className="mb-4 space-y-2">
      <p className="text-2xs text-surface-500 uppercase tracking-wider font-semibold">Remediation</p>
      {result && (
        <p className="text-2xs px-2.5 py-1.5 rounded-lg bg-surface-800 text-surface-300">{result}</p>
      )}
      <button onClick={runDiagnosis} disabled={running}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-brand-500/15 hover:bg-brand-500/25 border border-brand-500/30 text-brand-400 text-xs font-medium transition-all disabled:opacity-50">
        {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
        Run Diagnosis
      </button>
    </div>
  )
}

// ── Type icon (SVG) ────────────────────────────────────────────────────────
function NodeTypeIcon({ type, color }: { type: string; color: string }) {
  const s = color
  switch (type) {
    case 'gateway':
      return (
        <g>
          <polygon points="0,-9 8,5 -8,5" fill="none" stroke={s} strokeWidth="1.5" strokeLinejoin="round" />
          <circle cx="0" cy="0" r="2.5" fill={s} />
        </g>
      )
    case 'database':
      return (
        <g>
          <ellipse cx="0" cy="-5" rx="8" ry="3.5" fill="none" stroke={s} strokeWidth="1.5" />
          <line x1="-8" y1="-5" x2="-8" y2="5" stroke={s} strokeWidth="1.5" />
          <line x1="8"  y1="-5" x2="8"  y2="5" stroke={s} strokeWidth="1.5" />
          <ellipse cx="0" cy="5" rx="8" ry="3.5" fill="none" stroke={s} strokeWidth="1.5" />
        </g>
      )
    case 'queue':
      return (
        <g>
          <rect x="-7" y="-8" width="14" height="4" rx="1" fill="none" stroke={s} strokeWidth="1.5" />
          <rect x="-7" y="-1" width="14" height="4" rx="1" fill="none" stroke={s} strokeWidth="1.5" />
          <rect x="-7" y="6"  width="14" height="4" rx="1" fill="none" stroke={s} strokeWidth="1.5" />
        </g>
      )
    default: // service
      return (
        <g>
          <rect x="-8" y="-8" width="16" height="16" rx="2.5" fill="none" stroke={s} strokeWidth="1.5" />
          <circle cx="0" cy="0" r="2.5" fill={s} />
        </g>
      )
  }
}

// ── Bezier path helper ─────────────────────────────────────────────────────
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const dx = (x2 - x1) * 0.45
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function TopologyPage() {
  const router = useRouter()
  const { activeCluster, incidents } = useDashboardStore()
  const { data, isLive, refresh, loading, error } = useLiveData<TopoData>(
    '/api/k8s/topology', EMPTY, undefined, 30_000,
  )
  const { topology, summary } = data
  const { nodes, edges } = topology

  // ── Local state ───────────────────────────────────────────────────────────
  const [search, setSearch]             = useState('')
  const [selectedNode, setSelectedNode] = useState<TopoNode | null>(null)
  const [nsFilter, setNsFilter]         = useState<Set<string>>(new Set())
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set())

  // ── Dynamic viewBox for zoom/pan ──────────────────────────────────────────
  const svgRef   = useRef<SVGSVGElement>(null)
  const dragRef  = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [hoveredEdge, setHoveredEdge] = useState<{ edge: TopoEdge; mx: number; my: number } | null>(null)
  const [vb, setVb] = useState({ x: -80, y: 0, w: 960, h: 620 })

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 1.12 : 0.88
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const cx = (e.clientX - rect.left) / rect.width
    const cy = (e.clientY - rect.top)  / rect.height
    setVb(v => {
      const nw = Math.max(320, Math.min(3200, v.w * factor))
      const nh = nw * (v.h / v.w)
      return { x: v.x - (nw - v.w) * cx, y: v.y - (nh - v.h) * cy, w: nw, h: nh }
    })
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as Element).closest('[data-node]')) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, vx: vb.x, vy: vb.y }
    setDragging(true)
  }, [vb])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    setVb(v => {
      const sx = v.w / rect.width
      const sy = v.h / rect.height
      return {
        ...v,
        x: drag.vx - (e.clientX - drag.sx) * sx,
        y: drag.vy - (e.clientY - drag.sy) * sy,
      }
    })
  }, [])

  const onMouseUp = useCallback(() => { dragRef.current = null; setDragging(false) }, [])

  const fitAll = useCallback(() => {
    if (!nodes.length) return setVb({ x: -80, y: 0, w: 960, h: 620 })
    const xs = nodes.map(n => n.x); const ys = nodes.map(n => n.y)
    const pad = 80
    const vx = Math.min(...xs) - pad; const vy = Math.min(...ys) - pad
    const vw = Math.max(...xs) - vx + pad * 2; const vh = Math.max(...ys) - vy + pad * 2
    setVb({ x: vx, y: vy, w: Math.max(vw, 600), h: Math.max(vh, 400) })
  }, [nodes])

  // ── Derived ───────────────────────────────────────────────────────────────
  const allNs = useMemo(() => [...new Set(nodes.map(n => n.namespace))], [nodes])

  const visibleNodes = useMemo(() =>
    nodes.filter(n =>
      (nsFilter.size === 0 || nsFilter.has(n.namespace)) &&
      (statusFilter.size === 0 || statusFilter.has(n.status))
    ), [nodes, nsFilter, statusFilter])

  const visibleIds   = useMemo(() => new Set(visibleNodes.map(n => n.id)), [visibleNodes])
  const visibleEdges = useMemo(() =>
    edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [edges, visibleIds])

  const highlightId = search.trim()
    ? (visibleNodes.find(n => n.label.toLowerCase().includes(search.toLowerCase()))?.id ?? null)
    : null

  // M1 — auto-pan canvas to matched node when search finds one
  useEffect(() => {
    if (!highlightId) return
    const node = visibleNodes.find(n => n.id === highlightId)
    if (!node) return
    const pad = 140
    setVb({ x: node.x - pad, y: node.y - pad, w: pad * 2, h: pad * 2 })
  }, [highlightId]) // eslint-disable-line react-hooks/exhaustive-deps

  const nsColorMap = useMemo(() => {
    const m: Record<string, string> = {}
    allNs.forEach((ns, i) => { m[ns] = NS_PALETTE[i % NS_PALETTE.length] })
    return m
  }, [allNs])

  const nsBBoxes = useMemo(() => {
    const m: Record<string, { minX: number; maxX: number; minY: number; maxY: number }> = {}
    for (const ns of allNs) {
      const nn = visibleNodes.filter(n => n.namespace === ns)
      if (!nn.length) continue
      m[ns] = {
        minX: Math.min(...nn.map(n => n.x)) - 55,
        maxX: Math.max(...nn.map(n => n.x)) + 55,
        minY: Math.min(...nn.map(n => n.y)) - 52,
        maxY: Math.max(...nn.map(n => n.y)) + 52,
      }
    }
    return m
  }, [visibleNodes, allNs])

  const zoomPct = Math.round(960 / vb.w * 100)

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-surface-800 flex-shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Network className="w-5 h-5 text-brand-400" /> Service Topology
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">
            {activeCluster && <><span className="text-surface-300 font-medium">{activeCluster.name ?? activeCluster.displayName}</span>{' · '}</>}{nodes.length} services · {edges.length} connections · {allNs.length} {allNs.length === 1 ? 'namespace' : 'namespaces'}
            {nodes.length > 0 && ' · real K8s data'}
            {topology.updatedAt && nodes.length > 0 && (
              <> &middot; updated {formatDistanceToNow(new Date(topology.updatedAt), { addSuffix: true })}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {summary.totalTxKbps > 0 && (
            <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-brand-500/10 border border-brand-500/20 rounded-xl text-brand-400">
              <Activity className="w-3 h-3" /> {summary.totalTxKbps} KB/s
            </span>
          )}
          <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-success/10 border border-success/20 rounded-xl text-success">
            <CheckCircle2 className="w-3 h-3" /> {summary.healthy} healthy
          </span>
          {summary.degraded > 0 && (
            <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-warning/10 border border-warning/20 rounded-xl text-warning">
              <AlertTriangle className="w-3 h-3" /> {summary.degraded} degraded
            </span>
          )}
          {summary.critical > 0 && (
            <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-danger/10 border border-danger/20 rounded-xl text-danger">
              <AlertTriangle className="w-3 h-3" /> {summary.critical} critical
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
          <button onClick={refresh} disabled={loading}
            className="w-8 h-8 flex items-center justify-center bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-surface-400 hover:text-white disabled:opacity-50 transition-all">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">

        {/* ── Left sidebar ── */}
        <div className="w-52 flex-shrink-0 border-r border-surface-800 overflow-y-auto p-4 space-y-5">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Find service…"
              className="w-full bg-surface-900 border border-surface-700 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 transition-colors"
            />
          </div>

          <div>
            <p className="text-2xs text-surface-500 uppercase tracking-wider font-semibold mb-2">Namespaces</p>
            <div className="space-y-1">
              {allNs.length === 0 && <p className="text-2xs text-surface-600 px-2">Loading…</p>}
              {allNs.map(ns => {
                const count  = nodes.filter(n => n.namespace === ns).length
                const active = nsFilter.size === 0 || nsFilter.has(ns)
                return (
                  <button key={ns} onClick={() => setNsFilter(prev => {
                    const n = new Set(prev); n.has(ns) ? n.delete(ns) : n.add(ns); return n
                  })}
                    className={cn('w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-all',
                      active ? 'bg-surface-800 text-white' : 'text-surface-500 hover:bg-surface-900 hover:text-surface-300')}>
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: nsColorMap[ns] }} />
                      <span className="truncate">{ns}</span>
                    </span>
                    <span className="text-2xs text-surface-500 ml-1">{count}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <p className="text-2xs text-surface-500 uppercase tracking-wider font-semibold mb-2">Status</p>
            <div className="space-y-1">
              {(['healthy', 'degraded', 'critical'] as const).map(s => {
                const count  = nodes.filter(n => n.status === s).length
                const active = statusFilter.size === 0 || statusFilter.has(s)
                return (
                  <button key={s} onClick={() => setStatusFilter(prev => {
                    const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n
                  })}
                    className={cn('w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-all',
                      active ? 'bg-surface-800 text-white' : 'text-surface-500 hover:bg-surface-900 hover:text-surface-300')}>
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: STATUS_CLR[s] }} />
                      <span className="capitalize">{s}</span>
                    </span>
                    <span className="text-2xs text-surface-500">{count}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <p className="text-2xs text-surface-500 uppercase tracking-wider font-semibold mb-2">Node Types</p>
            <div className="space-y-1.5">
              {Object.entries({ gateway: 'Gateway / Ingress', service: 'Service', database: 'Database', queue: 'Queue' }).map(([t, lbl]) => (
                <div key={t} className="flex items-center gap-2 text-xs text-surface-400">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: TYPE_CLR[t] ?? '#64748b' }} />
                  {lbl}
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-2xs text-surface-500 uppercase tracking-wider font-semibold mb-2">Canvas — {zoomPct}%</p>
            <div className="flex gap-1">
              <button onClick={() => setVb(v => { const nw = Math.max(320, v.w * 0.8); return { ...v, w: nw, h: nw * v.h / v.w } })}
                className="flex-1 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-lg text-surface-300 transition-all flex items-center justify-center">
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setVb(v => { const nw = Math.min(3200, v.w * 1.25); return { ...v, w: nw, h: nw * v.h / v.w } })}
                className="flex-1 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-lg text-surface-300 transition-all flex items-center justify-center">
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button onClick={fitAll}
                className="flex-1 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-lg text-surface-300 transition-all flex items-center justify-center">
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* ── Canvas ── */}
        <div className="flex-1 relative overflow-hidden bg-surface-950">
          <svg
            ref={svgRef}
            width="100%" height="100%"
            viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            onWheel={onWheel}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            style={{ cursor: dragging ? 'grabbing' : 'grab' }}
            className="select-none"
          >
            <defs>
              <style>{`
                @keyframes edgeFlow     { from { stroke-dashoffset: 20 } to { stroke-dashoffset: 0 } }
                @keyframes edgeFlowFast { from { stroke-dashoffset: 14 } to { stroke-dashoffset: 0 } }
                .ef  { animation: edgeFlow     1.4s linear infinite }
                .eff { animation: edgeFlowFast 0.7s linear infinite }
              `}</style>
              <pattern id="tgrid" width="32" height="32" patternUnits="userSpaceOnUse">
                <circle cx="16" cy="16" r="0.9" fill="#1e293b" />
              </pattern>
              <filter id="glow-c" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="5" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="glow-s" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0,8 3,0 6" fill="#334155" />
              </marker>
              <marker id="arr-a" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0,8 3,0 6" fill="#6366f1" />
              </marker>
              <marker id="arr-e" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0,8 3,0 6" fill="#ef4444" />
              </marker>
            </defs>

            <rect x="-2000" y="-2000" width="6000" height="6000" fill="url(#tgrid)" />

            {/* Namespace group boxes */}
            {Object.entries(nsBBoxes).map(([ns, bb]) => (
              <g key={`ns-${ns}`}>
                <rect
                  x={bb.minX} y={bb.minY}
                  width={bb.maxX - bb.minX} height={bb.maxY - bb.minY}
                  rx="14"
                  fill={nsColorMap[ns] + '09'}
                  stroke={nsColorMap[ns] + '30'} strokeWidth="1.5"
                  strokeDasharray="8 4"
                />
                <text x={bb.minX + 14} y={bb.minY + 20}
                  fill={nsColorMap[ns]} fontSize="11" fontWeight="600" opacity="0.7"
                  fontFamily="'JetBrains Mono', monospace">
                  {ns}
                </text>
              </g>
            ))}

            {/* Edges */}
            {visibleEdges.map(edge => {
              const src = visibleNodes.find(n => n.id === edge.source)
              const tgt = visibleNodes.find(n => n.id === edge.target)
              if (!src || !tgt) return null
              const isErr = edge.errorRate > 5
              const isAct = edge.txKbps > 0.5
              const col   = isErr ? '#ef4444' : isAct ? '#6366f1' : '#334155'
              const mid   = isErr ? 'arr-e'   : isAct ? 'arr-a'   : 'arr'
              const d     = bezier(src.x, src.y, tgt.x, tgt.y)
              return (
                <g key={edge.id}>
                  <path d={d} fill="none" stroke="transparent" strokeWidth="10"
                    onMouseEnter={e => setHoveredEdge({ edge, mx: e.clientX, my: e.clientY })}
                    onMouseMove={e => setHoveredEdge(h => h ? { ...h, mx: e.clientX, my: e.clientY } : null)}
                    onMouseLeave={() => setHoveredEdge(null)}
                  />
                  {(isAct || isErr) && <path d={d} fill="none" stroke={col} strokeWidth="6" opacity="0.07" />}
                  <path
                    id={`ep-${edge.id}`} d={d} fill="none"
                    stroke={col}
                    strokeWidth={isAct || isErr ? 2 : 1.5}
                    strokeDasharray={isAct ? '7 5' : undefined}
                    className={isAct ? (isErr ? 'eff' : 'ef') : undefined}
                    markerEnd={`url(#${mid})`}
                    opacity={isAct || isErr ? 0.9 : 0.45}
                  />
                  {isAct && (
                    <circle r="3.5" fill={isErr ? '#ef4444' : '#818cf8'} opacity="0.9">
                      <animateMotion dur={isErr ? '0.8s' : '1.6s'} repeatCount="indefinite">
                        <mpath href={`#ep-${edge.id}`} />
                      </animateMotion>
                    </circle>
                  )}
                  {isAct ? (
                    <text fontSize="8.5" fill={col} opacity="0.85" fontFamily="'JetBrains Mono', monospace">
                      <textPath href={`#ep-${edge.id}`} startOffset="50%" textAnchor="middle">
                        {edge.txKbps > 0.1 ? `${edge.txKbps.toFixed(1)} KB/s` : ''}
                        {edge.errorRate > 0 ? `  ${edge.errorRate}% err` : ''}
                      </textPath>
                    </text>
                  ) : (
                    <text fontSize="8" fill="#475569" opacity="0.55" fontFamily="sans-serif">
                      <textPath href={`#ep-${edge.id}`} startOffset="50%" textAnchor="middle">
                        {edge.protocol}
                      </textPath>
                    </text>
                  )}
                </g>
              )
            })}

            {/* Nodes */}
            {visibleNodes.map(node => {
              const sc  = STATUS_CLR[node.status] ?? STATUS_CLR.unknown
              const tc  = TYPE_CLR[node.type]     ?? TYPE_CLR.service
              const sel = selectedNode?.id === node.id
              const hi  = !highlightId || node.id === highlightId
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  opacity={hi ? 1 : 0.2}
                  data-node="1"
                  className="cursor-pointer"
                  onClick={() => setSelectedNode(sel ? null : node)}
                >
                  {node.status === 'critical' && (
                    <circle r="26" fill="none" stroke="#ef4444" strokeWidth="1.5" filter="url(#glow-c)">
                      <animate attributeName="r"       values="26;36;26"   dur="2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.5;0;0.5"  dur="2s" repeatCount="indefinite" />
                    </circle>
                  )}
                  {sel && <circle r="30" fill="none" stroke="#06b6d4" strokeWidth="2.5" opacity="0.4" filter="url(#glow-s)" />}
                  <circle r="22" fill={tc + '18'} stroke={tc} strokeWidth="1" opacity="0.7" />
                  <circle r="20" fill="#0c1425" stroke={sel ? '#06b6d4' : sc} strokeWidth={sel ? 2.5 : 2} />
                  <NodeTypeIcon type={node.type} color={tc} />
                  <text textAnchor="middle" y="34" fill="#94a3b8" fontSize="9"
                    fontFamily="'JetBrains Mono', monospace" fontWeight="500">
                    {node.label.length > 15 ? `${node.label.slice(0, 13)}…` : node.label}
                  </text>
                  {node.podCount > 0 && (
                    <g transform="translate(17,-14)">
                      <circle r="8" fill={node.readyPods < node.podCount ? '#f59e0b' : '#0f172a'} stroke={sc} strokeWidth="1.2" />
                      <text textAnchor="middle" dy="3.5" fill="white" fontSize="7" fontWeight="700">{node.podCount}</text>
                    </g>
                  )}
                  {node.restarts24h > 0 && (
                    <g transform="translate(-17,-14)">
                      <circle r="8" fill="#ef4444" />
                      <text textAnchor="middle" dy="3.5" fill="white" fontSize="8" fontWeight="800">!</text>
                    </g>
                  )}
                  {node.txKbps > 0 && (
                    <text textAnchor="middle" y="46" fill="#6366f1" fontSize="8"
                      fontFamily="monospace" opacity="0.8">
                      {`↑${node.txKbps}KB/s`}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>

          {hoveredEdge && (() => {
              const srcNode = visibleNodes.find(n => n.id === hoveredEdge.edge.source)
              const tgtNode = visibleNodes.find(n => n.id === hoveredEdge.edge.target)
              return (
                <div className="fixed z-50 pointer-events-none bg-surface-900 border border-surface-700 rounded-xl px-3 py-2 shadow-xl text-xs space-y-1"
                  style={{ left: hoveredEdge.mx + 14, top: hoveredEdge.my - 14 }}>
                  <p className="text-white font-mono font-medium truncate max-w-[200px]">
                    {srcNode?.label ?? '?'} &rarr; {tgtNode?.label ?? '?'}
                  </p>
                  <div className="flex items-center gap-3 text-surface-400">
                    <span className="px-1.5 py-0.5 bg-surface-800 rounded text-2xs font-mono">{hoveredEdge.edge.protocol}</span>
                    {hoveredEdge.edge.txKbps > 0 && <span className="text-brand-400">{hoveredEdge.edge.txKbps.toFixed(1)} KB/s</span>}
                    {hoveredEdge.edge.errorRate > 0 && <span className="text-danger">{hoveredEdge.edge.errorRate}% err</span>}
                    {hoveredEdge.edge.txKbps === 0 && hoveredEdge.edge.errorRate === 0 && <span>No traffic</span>}
                  </div>
                </div>
              )
            })()}
          {nodes.length === 0 && !loading && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <Network className="w-12 h-12 text-surface-700 mx-auto mb-3" />
                <p className="text-surface-400 text-sm font-medium">No services found</p>
                <p className="text-surface-600 text-xs mt-1">Check cluster connectivity and user namespaces</p>
              </div>
            </div>
          )}
          {loading && nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface-950/60 pointer-events-none">
              <RefreshCw className="w-6 h-6 text-brand-400 animate-spin" />
            </div>
          )}
        </div>

        {/* ── Node detail panel ── */}
        <AnimatePresence>
          {selectedNode && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 272, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="flex-shrink-0 border-l border-surface-800 overflow-hidden bg-surface-950"
            >
              <div className="h-full overflow-y-auto p-4" style={{ width: 272 }}>
                <div className="flex items-start justify-between mb-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white font-mono truncate">{selectedNode.label}</h3>
                    <p className="text-2xs text-surface-500 mt-0.5">{selectedNode.namespace} · {selectedNode.type}</p>
                  </div>
                  <button onClick={() => setSelectedNode(null)}
                    className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-surface-500 hover:text-white hover:bg-surface-800 rounded-lg ml-2 transition-all">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className={cn('flex items-center gap-2 px-3 py-2 rounded-xl border mb-4 text-xs font-semibold',
                  selectedNode.status === 'healthy'  ? 'bg-success/5 border-success/20 text-success' :
                  selectedNode.status === 'degraded' ? 'bg-warning/5 border-warning/20 text-warning' :
                                                        'bg-danger/5  border-danger/20  text-danger')}>
                  {selectedNode.status === 'healthy'
                    ? <CheckCircle2 className="w-3.5 h-3.5" />
                    : <AlertTriangle className="w-3.5 h-3.5" />}
                  <span className="capitalize">{selectedNode.status}</span>
                  <span className="ml-auto text-surface-400 font-normal capitalize">{selectedNode.type}</span>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-4">
                  {[
                    { label: 'Pods',         value: `${selectedNode.readyPods}/${selectedNode.podCount}`, warn: selectedNode.readyPods < selectedNode.podCount },
                    { label: 'Restarts 24h', value: String(selectedNode.restarts24h), warn: selectedNode.restarts24h > 0 },
                    { label: 'TX',           value: `${selectedNode.txKbps} KB/s`,  warn: false },
                    { label: 'RX',           value: `${selectedNode.rxKbps} KB/s`,  warn: false },
                    { label: 'CPU',          value: `${(selectedNode.cpuCores * 1000).toFixed(0)}m`, warn: selectedNode.cpuCores > 0.5 },
                  ].map(m => (
                    <div key={m.label} className="bg-surface-900 border border-surface-800 rounded-xl p-2.5">
                      <p className="text-2xs text-surface-500 mb-0.5">{m.label}</p>
                      <p className={cn('text-sm font-bold tabular-nums', m.warn ? 'text-warning' : 'text-white')}>
                        {m.value}
                      </p>
                    </div>
                  ))}
                </div>

                {/* ── Active incidents for this service ── */}
                {(() => {
                  const nodeIncidents = incidents.filter(i =>
                    i.state !== 'resolved' &&
                    (i.service === selectedNode.label ||
                     i.affectedServices?.includes(selectedNode.label) ||
                     i.service?.toLowerCase().includes(selectedNode.label.toLowerCase()) ||
                     selectedNode.label.toLowerCase().includes(i.service?.toLowerCase() ?? '__'))
                  )
                  if (nodeIncidents.length === 0) return null
                  return (
                    <div className="mb-4">
                      <p className="text-2xs text-surface-500 uppercase tracking-wider font-semibold mb-2">
                        Active Incidents ({nodeIncidents.length})
                      </p>
                      <div className="space-y-1.5">
                        {nodeIncidents.map(inc => (
                          <button key={inc.id}
                            onClick={() => router.push(`/incidents/${inc.id}`)}
                            className="w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-xl border border-danger/20 bg-danger/5 hover:bg-danger/10 transition-all group">
                            <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0',
                              inc.severity === 'critical' ? 'bg-danger' : 'bg-orange-400')} />
                            <span className="flex-1 text-2xs text-white truncate">{inc.title}</span>
                            <ExternalLink className="w-3 h-3 text-surface-500 group-hover:text-danger flex-shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })()}

                {/* ── Diagnosis shortcut for degraded/critical ── */}
                {(selectedNode.status === 'degraded' || selectedNode.status === 'critical') && (
                  <DiagnosisButton node={selectedNode} />
                )}

                <div>
                  <p className="text-2xs text-surface-500 uppercase tracking-wider font-semibold mb-2">
                    {`Connections (${edges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id).length})`}
                  </p>
                  <div className="space-y-1.5">
                    {edges
                      .filter(e => e.source === selectedNode.id || e.target === selectedNode.id)
                      .map(e => {
                        const peerId = e.source === selectedNode.id ? e.target : e.source
                        const peer   = nodes.find(n => n.id === peerId)
                        if (!peer) return null
                        const isOut = e.source === selectedNode.id
                        return (
                          <button key={e.id} onClick={() => setSelectedNode(peer)}
                            className="w-full flex items-center gap-2 text-xs px-2.5 py-2 bg-surface-900 hover:bg-surface-800 rounded-xl border border-surface-800 transition-all group text-left">
                            <span className={cn('text-2xs px-1.5 py-0.5 rounded font-bold flex-shrink-0',
                              isOut ? 'bg-brand-500/15 text-brand-400' : 'bg-teal-500/15 text-teal-400')}>
                              {isOut ? '→' : '←'}
                            </span>
                            <span className="text-white truncate font-mono text-2xs group-hover:text-brand-300 transition-colors">
                              {peer.label}
                            </span>
                            <span className="ml-auto text-2xs text-surface-500 flex-shrink-0">{e.protocol}</span>
                            {e.txKbps > 0 && (
                              <span className="text-2xs text-brand-400 flex-shrink-0 font-mono">{e.txKbps}KB/s</span>
                            )}
                          </button>
                        )
                      })}
                    {edges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id).length === 0 && (
                      <p className="text-2xs text-surface-600 text-center py-3">No connections in view</p>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </div>
  )
}
