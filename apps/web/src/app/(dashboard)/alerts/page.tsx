'use client'

import { useState, useMemo, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bell, Search, RefreshCw, ExternalLink, AlertTriangle,
  CheckCircle2, Activity, Clock, Filter, X, BookOpen,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useLiveData } from '@/hooks/useLiveData'
import { cn } from '@/lib/utils'
import type { AlertsApiResponse, AlertEntry } from '@/app/api/alerts/route'

// ── Constants ─────────────────────────────────────────────────

const EMPTY: AlertsApiResponse = {
  alerts: [], total: 0, firing: 0, resolved: 0,
  critical: 0, warning: 0, info: 0, hasPrometheus: false,
}

const SEV_BADGE: Record<string, string> = {
  critical: 'text-danger  border-danger/30  bg-danger/10',
  high:     'text-warning border-warning/30 bg-warning/10',
  warning:  'text-warning border-warning/30 bg-warning/10',
  medium:   'text-blue-400 border-blue-400/30 bg-blue-400/10',
  low:      'text-surface-400 border-surface-600 bg-surface-800',
  info:     'text-surface-400 border-surface-600 bg-surface-800',
}

const SEV_DOT: Record<string, string> = {
  critical: 'bg-danger',
  high:     'bg-warning',
  warning:  'bg-warning',
  medium:   'bg-blue-400',
  low:      'bg-surface-500',
  info:     'bg-surface-500',
}

const STATE_BADGE: Record<string, string> = {
  firing:   'text-danger  bg-danger/10  border-danger/20',
  resolved: 'text-success bg-success/10 border-success/20',
  pending:  'text-warning bg-warning/10 border-warning/20',
}

const SEV_FILTERS = ['all', 'critical', 'warning', 'medium', 'low', 'info'] as const

// ── Detail drawer ─────────────────────────────────────────────

function AlertDetail({ alert, onClose }: { alert: AlertEntry; onClose: () => void }) {
  const sev = alert.severity.toLowerCase()
  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      className="fixed top-0 right-0 h-full w-full sm:w-[480px] bg-surface-900 border-l border-surface-700 z-50 overflow-y-auto shadow-2xl"
    >
      <div className="p-5 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', SEV_DOT[sev] ?? 'bg-surface-500')} />
            <h2 className="text-sm font-semibold text-surface-100 truncate">{alert.name}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap gap-2">
          <span className={cn('text-2xs px-2 py-0.5 rounded border font-semibold uppercase', SEV_BADGE[sev] ?? SEV_BADGE.info)}>
            {alert.severity}
          </span>
          <span className={cn('text-2xs px-2 py-0.5 rounded border font-semibold uppercase', STATE_BADGE[alert.state] ?? 'text-surface-400 border-surface-600 bg-surface-800')}>
            {alert.state}
          </span>
          {alert.namespace && (
            <span className="text-2xs px-2 py-0.5 rounded border font-semibold text-surface-300 border-surface-600 bg-surface-800">
              ns: {alert.namespace}
            </span>
          )}
        </div>

        {/* Summary */}
        {alert.summary && (
          <div>
            <p className="text-2xs text-surface-500 uppercase tracking-wide mb-1">Summary</p>
            <p className="text-sm text-surface-200">{alert.summary}</p>
          </div>
        )}

        {/* Description */}
        {alert.description && (
          <div>
            <p className="text-2xs text-surface-500 uppercase tracking-wide mb-1">Description</p>
            <p className="text-sm text-surface-300">{alert.description}</p>
          </div>
        )}

        {/* Timing */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-2xs text-surface-500 uppercase tracking-wide mb-1">Firing since</p>
            <p className="text-sm text-surface-200">{formatDistanceToNow(new Date(alert.startsAt), { addSuffix: true })}</p>
            <p className="text-2xs text-surface-500 mt-0.5">{new Date(alert.startsAt).toLocaleString()}</p>
          </div>
          {alert.job && (
            <div>
              <p className="text-2xs text-surface-500 uppercase tracking-wide mb-1">Job</p>
              <p className="text-sm text-surface-200 font-mono">{alert.job}</p>
            </div>
          )}
        </div>

        {/* Labels */}
        {Object.keys(alert.labels).length > 0 && (
          <div>
            <p className="text-2xs text-surface-500 uppercase tracking-wide mb-2">Labels</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(alert.labels)
                .filter(([k]) => !['__name__', 'alertstate'].includes(k))
                .map(([k, v]) => (
                  <span key={k} className="text-2xs font-mono px-1.5 py-0.5 rounded bg-surface-800 text-surface-300 border border-surface-700">
                    {k}=<span className="text-brand-400">{v}</span>
                  </span>
                ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-surface-700">
          {alert.runbookUrl && (
            <a
              href={alert.runbookUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-surface-700 hover:bg-surface-600 text-surface-200 border border-surface-600"
            >
              <BookOpen className="w-3.5 h-3.5" />
              Runbook
              <ExternalLink className="w-3 h-3 text-surface-500" />
            </a>
          )}
          <Link
            href={`/incidents?q=${encodeURIComponent(alert.name)}`}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-surface-700 hover:bg-surface-600 text-surface-200 border border-surface-600"
          >
            <Activity className="w-3.5 h-3.5" />
            Related Incidents
          </Link>
        </div>
      </div>
    </motion.div>
  )
}

// ── Main page ─────────────────────────────────────────────────

function AlertsPage() {
  const searchParams = useSearchParams()

  const [search,    setSearch]    = useState(searchParams.get('name') ?? '')
  const [sevFilter, setSevFilter] = useState<string>('all')
  const [selected,  setSelected]  = useState<AlertEntry | null>(null)

  const { data, loading, error, isLive, refresh } = useLiveData<AlertsApiResponse>(
    '/api/alerts', EMPTY,
    undefined, 30_000,
  )

  // Auto-highlight the alert named in ?name= query param
  const nameParam = searchParams.get('name')
  const highlighted = nameParam?.toLowerCase() ?? null

  const filtered = useMemo(() => {
    return data.alerts.filter(a => {
      if (sevFilter !== 'all') {
        const normalised = a.severity.toLowerCase()
        // treat warning/medium as same bucket for filter
        const matchSev = sevFilter === 'warning'
          ? normalised === 'warning' || normalised === 'medium'
          : normalised === sevFilter
        if (!matchSev) return false
      }
      if (search) {
        const q = search.toLowerCase()
        if (!a.name.toLowerCase().includes(q) &&
            !a.namespace.toLowerCase().includes(q) &&
            !a.summary.toLowerCase().includes(q) &&
            !a.job.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [data.alerts, sevFilter, search])

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-950">
      {/* Page header */}
      <div className="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-surface-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bell className="w-5 h-5 text-warning" />
            <h1 className="text-base font-semibold text-surface-100">Alerts</h1>
            {isLive && (
              <span className="flex items-center gap-1 text-2xs text-success">
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                Live
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              className="p-1.5 rounded-md hover:bg-surface-700 text-surface-400 hover:text-surface-200"
              title="Refresh"
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {/* Summary stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          {[
            { label: 'Total',    value: data.total,    color: 'text-surface-100' },
            { label: 'Firing',   value: data.firing,   color: 'text-danger' },
            { label: 'Critical', value: data.critical, color: 'text-danger' },
            { label: 'Warning',  value: data.warning,  color: 'text-warning' },
          ].map(s => (
            <div key={s.label} className="bg-surface-900 border border-surface-700 rounded-lg px-4 py-3">
              <p className="text-2xs text-surface-500 uppercase tracking-wide">{s.label}</p>
              <p className={cn('text-2xl font-bold mt-0.5', s.color)}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* No Prometheus banner */}
        {!data.hasPrometheus && !loading && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md bg-surface-800 border border-surface-700 text-xs text-surface-400">
            <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />
            Prometheus is unreachable — alert data unavailable.
          </div>
        )}

        {/* Name-param banner */}
        {nameParam && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md bg-brand-500/10 border border-brand-500/20 text-xs text-brand-300">
            <Bell className="w-3.5 h-3.5 flex-shrink-0" />
            Showing results for alert: <span className="font-semibold">{nameParam}</span>
            <button onClick={() => setSearch('')} className="ml-auto text-surface-500 hover:text-surface-300">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-surface-800 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500 pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search alerts…"
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-surface-800 border border-surface-700 rounded-md text-surface-200 placeholder-surface-500 focus:outline-none focus:border-brand-500"
          />
        </div>

        {/* Severity filter */}
        <div className="flex items-center gap-1">
          <Filter className="w-3.5 h-3.5 text-surface-500" />
          <div className="flex items-center gap-1">
            {SEV_FILTERS.map(f => (
              <button
                key={f}
                onClick={() => setSevFilter(f)}
                className={cn(
                  'text-2xs px-2.5 py-1 rounded-md border capitalize transition-colors',
                  sevFilter === f
                    ? 'bg-brand-500/20 border-brand-500/40 text-brand-300'
                    : 'bg-surface-800 border-surface-700 text-surface-400 hover:text-surface-200',
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto min-h-0">
        {loading && data.alerts.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-surface-500 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading alerts…
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-32 text-danger text-sm gap-2">
            <AlertTriangle className="w-4 h-4" /> Failed to load alerts
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-surface-500 text-sm">
            <CheckCircle2 className="w-6 h-6 text-success" />
            No alerts match the current filters
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-900 border-b border-surface-800 z-10">
              <tr>
                {['Alert', 'Severity', 'State', 'Namespace', 'Since', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-2xs font-semibold text-surface-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-800/60">
              {filtered.map(alert => {
                const sev   = alert.severity.toLowerCase()
                const isHighlighted = highlighted && alert.name.toLowerCase().includes(highlighted)
                return (
                  <tr
                    key={alert.id}
                    onClick={() => setSelected(alert)}
                    className={cn(
                      'cursor-pointer transition-colors hover:bg-surface-800/60',
                      isHighlighted && 'bg-brand-500/5 border-l-2 border-l-brand-500',
                    )}
                  >
                    {/* Name */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className={cn('w-2 h-2 rounded-full flex-shrink-0', SEV_DOT[sev] ?? 'bg-surface-500')} />
                        <span className="font-medium text-surface-100 truncate max-w-[200px]">{alert.name}</span>
                        {isHighlighted && (
                          <span className="text-2xs px-1.5 py-0.5 rounded bg-brand-500/20 text-brand-300 border border-brand-500/30 flex-shrink-0">
                            matched
                          </span>
                        )}
                      </div>
                      {alert.summary && alert.summary !== alert.name && (
                        <p className="text-2xs text-surface-500 ml-4 mt-0.5 truncate max-w-[240px]">{alert.summary}</p>
                      )}
                    </td>

                    {/* Severity */}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={cn('text-2xs px-2 py-0.5 rounded border font-semibold uppercase', SEV_BADGE[sev] ?? SEV_BADGE.info)}>
                        {alert.severity}
                      </span>
                    </td>

                    {/* State */}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={cn('text-2xs px-2 py-0.5 rounded border font-semibold uppercase', STATE_BADGE[alert.state] ?? 'text-surface-400 border-surface-700 bg-surface-800')}>
                        {alert.state}
                      </span>
                    </td>

                    {/* Namespace */}
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-surface-300 font-mono">{alert.namespace || '—'}</span>
                    </td>

                    {/* Since */}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="flex items-center gap-1 text-xs text-surface-400">
                        <Clock className="w-3 h-3" />
                        {formatDistanceToNow(new Date(alert.startsAt), { addSuffix: true })}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                        {alert.runbookUrl && (
                          <a
                            href={alert.runbookUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open runbook"
                            className="p-1 rounded hover:bg-surface-700 text-surface-500 hover:text-brand-400"
                          >
                            <BookOpen className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <Link
                          href={`/incidents?q=${encodeURIComponent(alert.name)}`}
                          title="View related incidents"
                          className="p-1 rounded hover:bg-surface-700 text-surface-500 hover:text-surface-200"
                        >
                          <Activity className="w-3.5 h-3.5" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail drawer */}
      <AnimatePresence>
        {selected && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 z-40"
              onClick={() => setSelected(null)}
            />
            <AlertDetail alert={selected} onClose={() => setSelected(null)} />
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function AlertsPageWrapper() {
  return (
    <Suspense>
      <AlertsPage />
    </Suspense>
  )
}
