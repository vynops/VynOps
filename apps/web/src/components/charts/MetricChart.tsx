'use client'

import { useState, useRef, useEffect } from 'react'
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceArea, ReferenceLine } from 'recharts'
import { format } from 'date-fns'
import type { TimeSeriesPoint } from '@/types'
import { cn } from '@/lib/utils'
import { ZoomIn, ZoomOut, Maximize2, ChevronLeft, ChevronRight } from 'lucide-react'

interface SparklineProps {
  data: TimeSeriesPoint[]
  color?: string
  height?: number
  showAxes?: boolean
  showTooltip?: boolean
  filled?: boolean
  unit?: string
  className?: string
  label?: string
  currentValue?: number | string
  status?: 'healthy' | 'degraded' | 'critical'
}

const statusColors: Record<string, string> = {
  healthy:  '#22c55e',
  degraded: '#f59e0b',
  critical: '#ef4444',
}

const CustomTooltip = ({ active, payload, unit }: { active?: boolean; payload?: any[]; unit?: string }) => {
  if (!active || !payload?.length) return null
  const { ts, value } = payload[0]?.payload ?? {}
  return (
    <div className="bg-surface-900 border border-surface-700 rounded-lg px-2.5 py-2 text-xs shadow-xl">
      {ts && <p className="text-surface-500 text-2xs mb-1">{format(new Date(ts), 'HH:mm:ss')}</p>}
      <span className="text-white font-medium">{typeof value === 'number' ? value.toFixed(2) : value}</span>
      {unit && <span className="text-surface-400 ml-1">{unit}</span>}
    </div>
  )
}

export function Sparkline({ data, color = '#06b6d4', height = 40, filled = true, unit, status }: SparklineProps) {
  const finalColor = status ? statusColors[status] : color

  return (
    <ResponsiveContainer width="100%" height={height}>
      {filled ? (
        <AreaChart data={data} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
          <defs>
            <linearGradient id={`grad-${finalColor.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={finalColor} stopOpacity={0.3} />
              <stop offset="95%" stopColor={finalColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke={finalColor}
            strokeWidth={1.5}
            fill={`url(#grad-${finalColor.replace('#', '')})`}
            dot={false}
            isAnimationActive={false}
          />
          <Tooltip content={<CustomTooltip unit={unit} />} />
        </AreaChart>
      ) : (
        <LineChart data={data} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
          <Line type="monotone" dataKey="value" stroke={finalColor} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          <Tooltip content={<CustomTooltip unit={unit} />} />
        </LineChart>
      )}
    </ResponsiveContainer>
  )
}

interface MetricChartProps {
  data: TimeSeriesPoint[]
  label: string
  unit?: string
  color?: string
  status?: 'healthy' | 'degraded' | 'critical'
  height?: number
  className?: string
  threshold?: number
  onPointClick?: (ts: number, value: number) => void
}

export function MetricChart({ data, label, unit, color, status, height = 160, className, threshold, onPointClick }: MetricChartProps) {
  const finalColor = status ? statusColors[status] : (color ?? '#06b6d4')

  // ?? Zoom / pan state ???????????????????????????????????????????????????????
  const [zoom,     setZoom]     = useState<{ left: number; right: number } | null>(null)
  const [selStart, setSelStart] = useState<number | null>(null)
  const [selEnd,   setSelEnd]   = useState<number | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging   = useRef(false)
  const mouseDownTs  = useRef<number | null>(null)
  const hoverTs      = useRef<number | null>(null)
  const zoomRef      = useRef(zoom)
  useEffect(() => { zoomRef.current = zoom }, [zoom])

  const fullLeft  = data[0]?.ts ?? 0
  const fullRight = data[data.length - 1]?.ts ?? 0
  const fullRange = fullRight - fullLeft

  // Reset zoom whenever the underlying data window shifts
  useEffect(() => { setZoom(null) }, [fullLeft, fullRight])

  const currentLeft  = zoom?.left  ?? fullLeft
  const currentRight = zoom?.right ?? fullRight
  const currentRange = currentRight - currentLeft
  const zoomRatio    = fullRange > 0 ? fullRange / currentRange : 1
  const isZoomed     = zoomRatio > 1.05

  const displayData = zoom
    ? data.filter(p => p.ts >= zoom.left && p.ts <= zoom.right)
    : data

  // ?? Wheel zoom (non-passive so we can preventDefault) ?????????????????????
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!fullRange) return
      const z      = zoomRef.current
      const cLeft  = z?.left  ?? fullLeft
      const cRight = z?.right ?? fullRight
      const cRange = cRight - cLeft
      const factor = e.deltaY > 0 ? 1.3 : 0.77    // scroll down = zoom out, up = zoom in
      const newRange = Math.min(cRange * factor, fullRange)
      if (newRange < 30_000) return                 // floor: 30 seconds
      const center   = hoverTs.current ?? (cLeft + cRight) / 2
      const newLeft  = Math.max(fullLeft,  center - newRange / 2)
      const newRight = Math.min(fullRight, newLeft + newRange)
      if (newRange >= fullRange * 0.98) setZoom(null)
      else setZoom({ left: newLeft, right: newRight })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [fullLeft, fullRight, fullRange])

  // ?? Drag-to-zoom ??????????????????????????????????????????????????????????
  const onChartMouseDown = (e: any) => {
    const ts = e?.activePayload?.[0]?.payload?.ts
    if (ts == null) return
    mouseDownTs.current = ts
    isDragging.current  = false
    setSelStart(ts)
    setSelEnd(null)
  }

  const onChartMouseMove = (e: any) => {
    const ts = e?.activePayload?.[0]?.payload?.ts
    if (ts != null) hoverTs.current = ts
    if (mouseDownTs.current != null && ts != null) {
      if (Math.abs(ts - mouseDownTs.current) > currentRange * 0.02) {
        isDragging.current = true
        setSelEnd(ts)
      }
    }
  }

  const onChartMouseUp = (e: any) => {
    if (isDragging.current && selStart != null && selEnd != null) {
      const left  = Math.min(selStart, selEnd)
      const right = Math.max(selStart, selEnd)
      if (right - left > 30_000) setZoom({ left, right })
    } else if (!isDragging.current && onPointClick) {
      const pt = e?.activePayload?.[0]?.payload as TimeSeriesPoint | undefined
      if (pt) onPointClick(pt.ts, pt.value)
    }
    mouseDownTs.current = null
    isDragging.current  = false
    setSelStart(null)
    setSelEnd(null)
  }

  // ?? Button helpers ?????????????????????????????????????????????????????????
  const zoomBy = (factor: number) => {
    const newRange = Math.min(currentRange * factor, fullRange)
    if (newRange < 30_000) return
    const center   = (currentLeft + currentRight) / 2
    const newLeft  = Math.max(fullLeft,  center - newRange / 2)
    const newRight = Math.min(fullRight, newLeft + newRange)
    if (newRange >= fullRange * 0.98) setZoom(null)
    else setZoom({ left: newLeft, right: newRight })
  }

  const pan = (dir: -1 | 1) => {
    const step     = currentRange * 0.35
    const newLeft  = Math.max(fullLeft,  currentLeft + dir * step)
    const newRight = Math.min(fullRight, newLeft + currentRange)
    if (newLeft === fullLeft && dir === -1) return
    if (newRight === fullRight && dir === 1) return
    setZoom({ left: newLeft, right: newRight })
  }

  // ?? X-axis format ??????????????????????????????????????????????????????????
  const spanMs = displayData.length >= 2
    ? displayData[displayData.length - 1].ts - displayData[0].ts : 0
  const crossesMidnight = displayData.length >= 2 &&
    new Date(displayData[0].ts).getDate() !== new Date(displayData[displayData.length - 1].ts).getDate()
  const xFmt = spanMs > 2 * 24 * 60 * 60 * 1000
    ? (v: number) => format(new Date(v), 'MMM d')
    : crossesMidnight
      ? (v: number) => format(new Date(v), 'MMM d HH:mm')
      : (v: number) => format(new Date(v), 'HH:mm')

  const btnCls = 'w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-white transition-colors disabled:opacity-25 disabled:cursor-default'

  return (
    <div className={cn('space-y-1 group/chart', className)}>
      {/* Header: label + zoom toolbar */}
      <div className="flex items-center gap-2 min-h-[18px]">
        {label && <p className="text-xs font-medium text-surface-400 flex-1 truncate">{label}</p>}
        <div className="flex items-center gap-0.5 opacity-0 group-hover/chart:opacity-100 transition-opacity flex-shrink-0">
          {isZoomed && (
            <span className="text-2xs font-mono text-brand-400 mr-1 tabular-nums">{zoomRatio.toFixed(1)}?</span>
          )}
          <button onClick={() => pan(-1)} disabled={!isZoomed} title="Pan left" className={btnCls}>
            <ChevronLeft className="w-3 h-3" />
          </button>
          <button onClick={() => zoomBy(0.7)} title="Zoom in (or scroll up)" className={btnCls}>
            <ZoomIn className="w-3 h-3" />
          </button>
          <button onClick={() => setZoom(null)} disabled={!isZoomed} title="Reset zoom (double-click chart)" className={btnCls}>
            <Maximize2 className="w-3 h-3" />
          </button>
          <button onClick={() => zoomBy(1.4)} title="Zoom out (or scroll down)" className={btnCls}>
            <ZoomOut className="w-3 h-3" />
          </button>
          <button onClick={() => pan(1)} disabled={!isZoomed} title="Pan right" className={btnCls}>
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Chart area */}
      <div
        ref={containerRef}
        onDoubleClick={() => setZoom(null)}
        title={onPointClick
          ? 'Scroll to zoom ? Drag to select ? Click to drill ? Double-click to reset'
          : 'Scroll to zoom ? Drag to select ? Double-click to reset'}
      >
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart
            data={displayData}
            margin={{ top: 4, bottom: 0, left: -10, right: 8 }}
            style={{ cursor: selStart != null && selEnd != null ? 'ew-resize' : onPointClick ? 'crosshair' : 'default' }}
            onMouseDown={onChartMouseDown}
            onMouseMove={onChartMouseMove}
            onMouseUp={onChartMouseUp}
            onMouseLeave={() => { hoverTs.current = null }}
          >
            <defs>
              <linearGradient id={`chart-${label.replace(/\W/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={finalColor} stopOpacity={0.2} />
                <stop offset="95%" stopColor={finalColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
            <XAxis
              dataKey="ts"
              tickFormatter={xFmt}
              tick={{ fontSize: 10, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `${v}${unit ?? ''}`}
            />
            <Tooltip content={<CustomTooltip unit={unit} />} />
            <Area
              type="monotone"
              dataKey="value"
              stroke={finalColor}
              strokeWidth={2}
              fill={`url(#chart-${label.replace(/\W/g, '')})`}
              dot={false}
              isAnimationActive={false}
            />
            {/* Threshold reference line */}
            {threshold != null && (
              <ReferenceLine
                y={threshold}
                stroke={finalColor}
                strokeDasharray="5 3"
                strokeOpacity={0.5}
                label={{ value: `${threshold}${unit ?? ''}`, position: 'insideTopRight', fill: finalColor, fontSize: 10, opacity: 0.7 }}
              />
            )}
            {/* Drag-select region */}
            {selStart != null && selEnd != null && (
              <ReferenceArea
                x1={Math.min(selStart, selEnd)}
                x2={Math.max(selStart, selEnd)}
                fill={finalColor}
                fillOpacity={0.12}
                stroke={finalColor}
                strokeOpacity={0.5}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Hint */}
      {onPointClick && (
        <p className="text-2xs text-surface-700 text-center select-none">
          {isZoomed
            ? '? ? pan  ?  scroll zoom  ?  drag select  ?  click drill  ?  dbl-click reset'
            : 'scroll to zoom  ?  drag to select  ?  click to drill down'}
        </p>
      )}
    </div>
  )
}

// ?? DualSeriesChart ???????????????????????????????????????????????????????????
// Two series on the same Y-axis (e.g. Read + Write IOPS). Full zoom/pan/drag.
export interface DualSeries {
  key: string      // must be unique, used as recharts dataKey
  label: string
  color: string
}

export function DualSeriesChart({
  data,
  series,
  unit = '',
  height = 200,
  className,
  onPointClick,
}: {
  data: { ts: number; [key: string]: number }[]
  series: [DualSeries, DualSeries]
  unit?: string
  height?: number
  className?: string
  onPointClick?: (ts: number) => void
}) {
  const [zoom,     setZoom]     = useState<{ left: number; right: number } | null>(null)
  const [selStart, setSelStart] = useState<number | null>(null)
  const [selEnd,   setSelEnd]   = useState<number | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging   = useRef(false)
  const mouseDownTs  = useRef<number | null>(null)
  const hoverTs      = useRef<number | null>(null)
  const zoomRef      = useRef(zoom)
  useEffect(() => { zoomRef.current = zoom }, [zoom])

  const fullLeft  = data[0]?.ts ?? 0
  const fullRight = data[data.length - 1]?.ts ?? 0
  const fullRange = fullRight - fullLeft
  useEffect(() => { setZoom(null) }, [fullLeft, fullRight])

  const currentLeft  = zoom?.left  ?? fullLeft
  const currentRight = zoom?.right ?? fullRight
  const currentRange = currentRight - currentLeft
  const zoomRatio    = fullRange > 0 ? fullRange / currentRange : 1
  const isZoomed     = zoomRatio > 1.05

  const displayData = zoom ? data.filter(p => p.ts >= zoom.left && p.ts <= zoom.right) : data

  // Wheel zoom
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!fullRange) return
      const z      = zoomRef.current
      const cLeft  = z?.left  ?? fullLeft
      const cRight = z?.right ?? fullRight
      const cRange = cRight - cLeft
      const factor = e.deltaY > 0 ? 1.3 : 0.77
      const newRange = Math.min(cRange * factor, fullRange)
      if (newRange < 30_000) return
      const center   = hoverTs.current ?? (cLeft + cRight) / 2
      const newLeft  = Math.max(fullLeft,  center - newRange / 2)
      const newRight = Math.min(fullRight, newLeft + newRange)
      if (newRange >= fullRange * 0.98) setZoom(null)
      else setZoom({ left: newLeft, right: newRight })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [fullLeft, fullRight, fullRange])

  const onChartMouseDown = (e: any) => {
    const ts = e?.activePayload?.[0]?.payload?.ts
    if (ts == null) return
    mouseDownTs.current = ts
    isDragging.current  = false
    setSelStart(ts)
    setSelEnd(null)
  }
  const onChartMouseMove = (e: any) => {
    const ts = e?.activePayload?.[0]?.payload?.ts
    if (ts != null) hoverTs.current = ts
    if (mouseDownTs.current != null && ts != null) {
      if (Math.abs(ts - mouseDownTs.current) > currentRange * 0.02) {
        isDragging.current = true
        setSelEnd(ts)
      }
    }
  }
  const onChartMouseUp = () => {
    if (isDragging.current && selStart != null && selEnd != null) {
      const left  = Math.min(selStart, selEnd)
      const right = Math.max(selStart, selEnd)
      if (right - left > 30_000) setZoom({ left, right })
    } else if (!isDragging.current && onPointClick && mouseDownTs.current != null) {
      const ts = mouseDownTs.current
      onPointClick(ts)
    }
    mouseDownTs.current = null
    isDragging.current  = false
    setSelStart(null)
    setSelEnd(null)
  }

  const zoomBy = (factor: number) => {
    const newRange = Math.min(currentRange * factor, fullRange)
    if (newRange < 30_000) return
    const center   = (currentLeft + currentRight) / 2
    const newLeft  = Math.max(fullLeft,  center - newRange / 2)
    const newRight = Math.min(fullRight, newLeft + newRange)
    if (newRange >= fullRange * 0.98) setZoom(null)
    else setZoom({ left: newLeft, right: newRight })
  }
  const pan = (dir: -1 | 1) => {
    const step     = currentRange * 0.35
    const newLeft  = Math.max(fullLeft,  currentLeft + dir * step)
    const newRight = Math.min(fullRight, newLeft + currentRange)
    setZoom({ left: newLeft, right: newRight })
  }

  const spanMs = displayData.length >= 2
    ? displayData[displayData.length - 1].ts - displayData[0].ts : 0
  const crossesMidnight = displayData.length >= 2 &&
    new Date(displayData[0].ts).getDate() !== new Date(displayData[displayData.length - 1].ts).getDate()
  const xFmt = spanMs > 2 * 24 * 60 * 60 * 1000
    ? (v: number) => format(new Date(v), 'MMM d')
    : crossesMidnight ? (v: number) => format(new Date(v), 'MMM d HH:mm')
    : (v: number) => format(new Date(v), 'HH:mm')

  const DualTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const ts = payload[0]?.payload?.ts
    return (
      <div className="bg-surface-900 border border-surface-700 rounded-lg px-2.5 py-2 text-xs shadow-xl space-y-1">
        {ts && <p className="text-surface-500 text-2xs mb-1">{format(new Date(ts), 'HH:mm:ss')}</p>}
        {payload.map((p: any) => (
          <div key={p.dataKey} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
            <span className="text-surface-300">{p.name}:</span>
            <span className="text-white font-medium tabular-nums">{typeof p.value === 'number' ? p.value.toFixed(2) : p.value}{unit}</span>
          </div>
        ))}
      </div>
    )
  }

  const btnCls = 'w-5 h-5 flex items-center justify-center rounded hover:bg-surface-700 text-surface-500 hover:text-white transition-colors disabled:opacity-25'

  return (
    <div className={cn('space-y-1 group/chart', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between min-h-[18px]">
        <div className="flex items-center gap-3">
          {series.map(s => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className="w-2.5 h-0.5 rounded-full" style={{ background: s.color }} />
              <span className="text-2xs text-surface-400">{s.label}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover/chart:opacity-100 transition-opacity">
          {isZoomed && <span className="text-2xs font-mono text-brand-400 mr-1">{zoomRatio.toFixed(1)}?</span>}
          <button onClick={() => pan(-1)}     disabled={!isZoomed} className={btnCls}><ChevronLeft  className="w-3 h-3" /></button>
          <button onClick={() => zoomBy(0.7)}                      className={btnCls}><ZoomIn       className="w-3 h-3" /></button>
          <button onClick={() => setZoom(null)} disabled={!isZoomed} className={btnCls}><Maximize2  className="w-3 h-3" /></button>
          <button onClick={() => zoomBy(1.4)}                      className={btnCls}><ZoomOut      className="w-3 h-3" /></button>
          <button onClick={() => pan(1)}      disabled={!isZoomed} className={btnCls}><ChevronRight className="w-3 h-3" /></button>
        </div>
      </div>

      {/* Chart */}
      <div ref={containerRef} onDoubleClick={() => setZoom(null)}
        title="Scroll to zoom ? Drag to select ? Double-click to reset">
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={displayData} margin={{ top: 4, bottom: 0, left: -10, right: 8 }}
            style={{ cursor: selStart != null ? 'ew-resize' : 'crosshair' }}
            onMouseDown={onChartMouseDown}
            onMouseMove={onChartMouseMove}
            onMouseUp={onChartMouseUp}
            onMouseLeave={() => { hoverTs.current = null }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
            <XAxis dataKey="ts" tickFormatter={xFmt} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={v => `${v}${unit}`} />
            <Tooltip content={<DualTooltip />} />
            {series.map(s => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label}
                stroke={s.color} strokeWidth={2} dot={false} isAnimationActive={false} />
            ))}
            {selStart != null && selEnd != null && (
              <ReferenceArea x1={Math.min(selStart, selEnd)} x2={Math.max(selStart, selEnd)}
                fill="#06b6d4" fillOpacity={0.1} stroke="#06b6d4" strokeOpacity={0.4} />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

