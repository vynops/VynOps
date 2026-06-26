'use client'

import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[dashboard] unhandled error:', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 px-4 text-center">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-danger/10 ring-1 ring-danger/20">
        <AlertTriangle className="w-8 h-8 text-danger" />
      </div>
      <div className="space-y-2 max-w-md">
        <h2 className="text-lg font-semibold text-surface-100">Something went wrong</h2>
        <p className="text-sm text-surface-400">
          {error.message || 'An unexpected error occurred. The team has been notified.'}
        </p>
        {error.digest && (
          <p className="text-xs text-surface-600 font-mono">Error ID: {error.digest}</p>
        )}
      </div>
      <button
        onClick={reset}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors"
      >
        <RefreshCw className="w-4 h-4" />
        Try again
      </button>
    </div>
  )
}
