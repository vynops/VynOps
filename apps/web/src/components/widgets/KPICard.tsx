'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TooltipRow {
  label: string
  value: string
  sub?: string
  color?: 'success' | 'warning' | 'danger' | 'neutral'
}

interface KPICardProps {
  label: string
  value: string | number
  unit?: string
  trend?: number           // percentage change
  trendLabel?: string
  status?: 'healthy' | 'degraded' | 'critical' | 'neutral'
  icon?: React.ReactNode
  pulse?: boolean
  className?: string
  onClick?: () => void
  tooltip?: TooltipRow[]
}

const tooltipColors: Record<string, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
  neutral: 'text-surface-300',
}

export default function KPICard({
  label, value, unit, trend, trendLabel, status = 'neutral',
  icon, pulse, className, onClick, tooltip,
}: KPICardProps) {
  const [hovered, setHovered] = useState(false)
  const statusColors: Record<string, string> = {
    healthy:  'border-success/20 bg-success/5',
    degraded: 'border-warning/20 bg-warning/5',
    critical: 'border-danger/20 bg-danger/5',
    neutral:  'border-surface-800 bg-surface-900',
  }

  const valueColors: Record<string, string> = {
    healthy:  'text-success',
    degraded: 'text-warning',
    critical: 'text-danger',
    neutral:  'text-white',
  }

  const trendPositive = (trend ?? 0) > 0
  const trendNeutral = trend === 0 || trend === undefined

  return (
    <div
      className={cn('relative', tooltip && 'cursor-default')}
      onMouseEnter={() => tooltip && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <motion.div
        whileHover={{ y: -2, scale: 1.01 }}
        transition={{ duration: 0.15 }}
        onClick={onClick}
        className={cn(
          'relative rounded-2xl border p-4 overflow-hidden transition-all',
          statusColors[status],
          onClick && 'cursor-pointer hover-glow',
          className,
        )}
      >
        {/* Background glow for critical */}
        {status === 'critical' && (
          <div className="absolute inset-0 bg-gradient-radial from-danger/10 to-transparent pointer-events-none" />
        )}

        <div className="relative flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-surface-400 truncate">{label}</p>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className={cn('text-2xl font-bold leading-none tabular-nums', valueColors[status])}>
                {typeof value === 'number' ? value.toLocaleString() : value}
              </span>
              {unit && <span className="text-sm text-surface-500">{unit}</span>}
            </div>

            {(trend !== undefined || trendLabel) && (
              <div className="mt-2 flex items-center gap-1">
                {!trendNeutral && (
                  trendPositive
                    ? <TrendingUp className="w-3 h-3 text-success" />
                    : <TrendingDown className="w-3 h-3 text-danger" />
                )}
                {trendNeutral && <Minus className="w-3 h-3 text-surface-500" />}
                {trend !== undefined && (
                  <span className={cn('text-xs font-medium', trendNeutral ? 'text-surface-500' : trendPositive ? 'text-success' : 'text-danger')}>
                    {trendPositive ? '+' : ''}{trend.toFixed(1)}%
                  </span>
                )}
                {trendLabel && <span className="text-xs text-surface-500">{trendLabel}</span>}
              </div>
            )}
          </div>

          {icon && (
            <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0', statusColors[status])}>
              {icon}
            </div>
          )}
        </div>

        {/* Pulse dot for active */}
        {pulse && (
          <div className="absolute top-3 right-3">
            <span className="relative flex h-2 w-2">
              <span className={cn('animate-ping absolute inline-flex h-full w-full rounded-full opacity-75', status === 'critical' ? 'bg-danger' : 'bg-success')} />
              <span className={cn('relative inline-flex rounded-full h-2 w-2', status === 'critical' ? 'bg-danger' : 'bg-success')} />
            </span>
          </div>
        )}
      </motion.div>

      {/* Hover tooltip — outside motion.div to avoid transform stacking context */}
      {tooltip && hovered && (
        <div className="absolute left-0 top-full mt-2 z-50 w-60 rounded-xl bg-surface-900 border border-surface-700 shadow-2xl p-3 text-xs pointer-events-none">
          {tooltip.map((row, i) => (
            <div key={i} className={cn('flex items-start justify-between gap-2', i > 0 && 'mt-1.5')}>
              <span className="text-surface-400 shrink-0">{row.label}</span>
              <span className="text-right">
                <span className={tooltipColors[row.color ?? 'neutral']}>{row.value}</span>
                {row.sub && <span className="text-surface-500 ml-1">{row.sub}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
