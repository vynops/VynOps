import Link from 'next/link'
import { Compass } from 'lucide-react'

export default function DashboardNotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 px-4 text-center">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-surface-800 ring-1 ring-surface-700">
        <Compass className="w-8 h-8 text-surface-400" />
      </div>
      <div className="space-y-2 max-w-md">
        <h2 className="text-lg font-semibold text-surface-100">Page not found</h2>
        <p className="text-sm text-surface-400">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
      </div>
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-200 text-sm font-medium transition-colors ring-1 ring-surface-700"
      >
        Back to Dashboard
      </Link>
    </div>
  )
}
