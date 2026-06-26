'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { AlertTriangle, Clock, User, ChevronRight } from 'lucide-react'
import { formatDistanceToNow, formatDistanceToNowStrict } from 'date-fns'
import type { Incident } from '@/types'
import { cn, severityClass } from '@/lib/utils'

const stateColors: Record<string, string> = {
  open:          'text-danger bg-danger/10 border-danger/20',
  investigating: 'text-warning bg-warning/10 border-warning/20',
  identified:    'text-blue-400 bg-blue-400/10 border-blue-400/20',
  monitoring:    'text-brand-400 bg-brand-400/10 border-brand-400/20',
  resolved:      'text-success bg-success/10 border-success/20',
  postmortem:    'text-surface-400 bg-surface-800 border-surface-700',
}

export function IncidentRow({ incident, onClick }: { incident: Incident; onClick?: () => void }) {
  return (
    <motion.div
      whileHover={{ x: 2 }}
      onClick={onClick}
      className="flex items-center gap-3 px-4 py-3 hover:bg-surface-800/60 cursor-pointer border-b border-surface-800/50 group transition-colors"
    >
      <span className={cn('w-1 self-stretch rounded-full flex-shrink-0', incident.severity === 'critical' ? 'bg-danger' : incident.severity === 'high' ? 'bg-warning' : 'bg-info')} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-surface-500">{incident.id.toUpperCase()}</span>
          <span className={cn('text-2xs px-1.5 py-0.5 rounded-md font-medium border', severityClass(incident.severity))}>
            {incident.severity}
          </span>
          <span className={cn('text-2xs px-1.5 py-0.5 rounded-md font-medium border capitalize', stateColors[incident.state])}>
            {incident.state}
          </span>
        </div>
        <p className="text-sm font-medium text-white mt-1 truncate">{incident.title}</p>
        <div className="flex items-center gap-3 mt-1 text-2xs text-surface-500">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span suppressHydrationWarning>{formatDistanceToNow(new Date(incident.createdAt), { addSuffix: true })}</span>
          </span>
          <span className="flex items-center gap-1">
            <User className="w-3 h-3" />
            {incident.owner}
          </span>
          <span>{incident.blastRadius.affectedServices.length} services</span>
          {incident.blastRadius.affectedUsers > 0 && (
            <span className="text-danger">{incident.blastRadius.affectedUsers.toLocaleString()} users</span>
          )}
        </div>
      </div>

      <ChevronRight className="w-4 h-4 text-surface-600 group-hover:text-surface-400 flex-shrink-0 transition-colors" />
    </motion.div>
  )
}

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={cn('text-2xs px-2 py-0.5 rounded-full font-semibold border capitalize', severityClass(severity as never))}>
      {severity}
    </span>
  )
}

export function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: 'bg-success',
    degraded: 'bg-warning',
    critical: 'bg-danger',
    unknown: 'bg-surface-500',
    Running: 'bg-success',
    CrashLoopBackOff: 'bg-danger',
    OOMKilled: 'bg-danger',
    Pending: 'bg-warning',
    Failed: 'bg-danger',
  }
  return (
    <span className={cn('inline-block w-2 h-2 rounded-full flex-shrink-0', colors[status] ?? 'bg-surface-500')} />
  )
}
