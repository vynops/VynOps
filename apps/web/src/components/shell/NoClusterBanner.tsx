'use client'

import Link from 'next/link'
import { AlertTriangle, Plus, Settings } from 'lucide-react'
import { useDashboardStore } from '@/store'

export default function NoClusterBanner() {
  const activeCluster = useDashboardStore(s => s.activeCluster)
  const clusters      = useDashboardStore(s => s.clusters)

  // Hide once a cluster is active, or while clusters are still loading (clusters === [])
  // Show only after the store has been hydrated and still no active cluster
  if (activeCluster !== null) return null

  const hasRegistered = clusters.length > 0

  return (
    <div className="mx-4 mt-4 flex items-center gap-3 px-4 py-3 rounded-xl border border-warning/30 bg-warning/5 text-warning">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />

      <div className="flex-1 min-w-0">
        {hasRegistered ? (
          <span className="text-sm">
            No cluster selected — pick one from the cluster dropdown in the top bar to see live data.
          </span>
        ) : (
          <span className="text-sm">
            No cluster configured yet — add one to start monitoring your infrastructure.
          </span>
        )}
      </div>

      <Link
        href="/settings"
        className="flex items-center gap-1.5 flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-warning/15 hover:bg-warning/25 border border-warning/30 transition-all"
      >
        {hasRegistered ? (
          <><Settings className="w-3 h-3" /> Settings</>
        ) : (
          <><Plus className="w-3 h-3" /> Add cluster</>
        )}
      </Link>
    </div>
  )
}
