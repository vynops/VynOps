'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Plus, Settings, WifiOff, X } from 'lucide-react'
import { useDashboardStore } from '@/store'

export default function NoClusterBanner() {
  const activeCluster        = useDashboardStore(s => s.activeCluster)
  const clusters             = useDashboardStore(s => s.clusters)
  const clusterStatus        = useDashboardStore(s => s.clusterStatus)
  const clusterStatusCheckedAt = useDashboardStore(s => s.clusterStatusCheckedAt)
  const [dismissed, setDismissed] = useState(false)

  // Still initialising — don't flash anything
  if (clusterStatus === 'checking') return null

  // Unreachable: dismissible sticky banner; re-appears on next status change
  if (clusterStatus === 'unreachable' && !dismissed) {
    const checkedLabel = clusterStatusCheckedAt
      ? new Date(clusterStatusCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null
    return (
      <div className="mx-4 mt-4 flex items-center gap-3 px-4 py-3 rounded-xl border border-danger/30 bg-danger/5 text-danger">
        <WifiOff className="w-4 h-4 flex-shrink-0" />
        <div className="flex-1 min-w-0 text-sm">
          Cluster unreachable — check kubectl proxy or VPN.
          {checkedLabel && <span className="ml-1 text-surface-400 text-xs">Last checked {checkedLabel}</span>}
        </div>
        <Link
          href="/settings"
          className="flex items-center gap-1.5 flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-danger/15 hover:bg-danger/25 border border-danger/30 transition-all"
        >
          <Settings className="w-3 h-3" /> Settings
        </Link>
        <button onClick={() => setDismissed(true)} className="text-surface-400 hover:text-surface-200 transition-colors ml-1">
          <X className="w-4 h-4" />
        </button>
      </div>
    )
  }

  // Unconfigured: show only when no active cluster
  if (activeCluster !== null) return null

  const hasRegistered = clusters.length > 0

  return (
    <div className="mx-4 mt-4 flex items-center gap-3 px-4 py-3 rounded-xl border border-warning/30 bg-warning/5 text-warning">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        {hasRegistered ? (
          <span className="text-sm">No cluster selected — pick one from the cluster dropdown in the top bar to see live data.</span>
        ) : (
          <span className="text-sm">No cluster configured yet — add one to start monitoring your infrastructure.</span>
        )}
      </div>
      <Link
        href="/settings"
        className="flex items-center gap-1.5 flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-warning/15 hover:bg-warning/25 border border-warning/30 transition-all"
      >
        {hasRegistered ? <><Settings className="w-3 h-3" /> Settings</> : <><Plus className="w-3 h-3" /> Add cluster</>}
      </Link>
    </div>
  )
}

