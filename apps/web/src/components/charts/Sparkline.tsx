'use client'

interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  color?: string
  className?: string
  showDots?: boolean
}

export function Sparkline({ data, width = 80, height = 24, color = '#22c55e', className = '', showDots = false }: SparklineProps) {
  if (!data || data.length < 2) return <span className={`inline-block w-[80px] h-[24px] ${className}`} />

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  const lastPt = pts[pts.length - 1].split(',')

  return (
    <svg width={width} height={height} className={`inline-block align-middle ${className}`}>
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {showDots && data.map((_, i) => {
        const [x, y] = pts[i].split(',')
        return <circle key={i} cx={x} cy={y} r="1.5" fill={color} />
      })}
      {/* Latest value dot */}
      <circle cx={lastPt[0]} cy={lastPt[1]} r="2.5" fill={color} />
    </svg>
  )
}

interface MiniBarProps {
  value: number          // 0-100
  warn?: number
  crit?: number
  width?: number
  height?: number
  label?: string
}

export function MiniBar({ value, warn = 75, crit = 90, width = 60, height = 6, label }: MiniBarProps) {
  const color = value >= crit ? '#ef4444' : value >= warn ? '#f59e0b' : '#22c55e'
  const pct = Math.min(Math.max(value, 0), 100)

  return (
    <div className="flex items-center gap-1.5">
      <div style={{ width, height }} className="rounded-full bg-surface-800 overflow-hidden flex-shrink-0">
        <div style={{ width: `${pct}%`, height, backgroundColor: color }} className="rounded-full transition-all" />
      </div>
      {label !== undefined && <span className="text-2xs tabular-nums" style={{ color }}>{label}</span>}
    </div>
  )
}
