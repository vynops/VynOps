import Link from 'next/link'
import { Compass } from 'lucide-react'

export default function GlobalNotFound() {
  return (
    <html lang="en">
      <body className="bg-surface-950 text-surface-100 flex flex-col items-center justify-center min-h-screen gap-6 px-4 text-center font-sans">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-surface-800 ring-1 ring-surface-700">
          <Compass className="w-8 h-8 text-surface-400" />
        </div>
        <div className="space-y-2 max-w-md">
          <p className="text-6xl font-bold text-surface-700">404</p>
          <h1 className="text-xl font-semibold text-surface-100">Page not found</h1>
          <p className="text-sm text-surface-400">
            The resource you&apos;re looking for doesn&apos;t exist.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors"
        >
          Go to Dashboard
        </Link>
      </body>
    </html>
  )
}
