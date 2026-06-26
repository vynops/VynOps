'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, ScrollText, RefreshCw, Copy, Check, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getClusterHeaders } from '@/store'

const TAIL_OPTIONS = [50, 100, 200, 500, 1000] as const

interface LogViewerProps {
  pod: string
  namespace: string
  container?: string
  onClose: () => void
}

export function LogViewer({ pod, namespace, container, onClose }: LogViewerProps) {
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [tailLines, setTailLines] = useState<number>(200)
  const [timestamps, setTimestamps] = useState(true)
  const [previous, setPrevious] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [copied, setCopied] = useState(false)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({
      pod,
      namespace,
      tailLines: String(tailLines),
      timestamps: String(timestamps),
    })
    if (container) params.set('container', container)
    if (previous) params.set('previous', 'true')

    try {
      const r = await fetch(`/api/k8s/logs?${params}`, { headers: getClusterHeaders() })
      const j = await r.json()
      if (j.unavailable) { setUnavailable(j.reason ?? 'Logs unavailable'); setLoading(false); return }
      if (j.error) { setError(j.error); return }
      setUnavailable(null)
      setLogs(j.logs ?? '')
      setLastFetched(new Date())
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [pod, namespace, container, tailLines, timestamps, previous])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(fetchLogs, 5000)
    return () => clearInterval(t)
  }, [autoRefresh, fetchLogs])

  const handleCopy = () => {
    navigator.clipboard.writeText(logs)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const lines = logs.split('\n').filter(Boolean)

  return (
    <div className="fixed inset-y-0 right-0 w-[720px] bg-surface-950 border-l border-surface-700 z-50 flex flex-col shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-800">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-brand-400" />
            <span className="font-mono">{pod}</span>
            {container && <span className="text-brand-300 font-mono text-xs">/{container}</span>}
          </h3>
          <p className="text-2xs text-surface-500 mt-0.5">
            namespace: <span className="font-mono">{namespace}</span>
            {lastFetched && <span className="ml-2">· {lastFetched.toLocaleTimeString()}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-2xs text-surface-400 hover:text-white px-2 py-1 rounded bg-surface-800 hover:bg-surface-700"
          >
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />} Copy
          </button>
          <button
            onClick={() => fetchLogs()}
            disabled={loading}
            className="flex items-center gap-1 text-2xs text-surface-400 hover:text-white px-2 py-1 rounded bg-surface-800 hover:bg-surface-700 disabled:opacity-40"
          >
            <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} /> Refresh
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-700 text-surface-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex items-center flex-wrap gap-4 px-5 py-2.5 border-b border-surface-800 bg-surface-900">
        <div className="flex items-center gap-1.5 text-2xs text-surface-400">
          <span>Last</span>
          <select
            value={tailLines}
            onChange={e => setTailLines(Number(e.target.value))}
            className="bg-surface-800 border border-surface-700 rounded px-1.5 py-0.5 text-white text-2xs"
          >
            {TAIL_OPTIONS.map(n => <option key={n} value={n}>{n} lines</option>)}
          </select>
        </div>

        <label className="flex items-center gap-1.5 text-2xs text-surface-400 cursor-pointer select-none">
          <input type="checkbox" checked={timestamps} onChange={e => setTimestamps(e.target.checked)} className="accent-brand-500" />
          <Clock className="w-3 h-3" /> Timestamps
        </label>

        <label className="flex items-center gap-1.5 text-2xs text-surface-400 cursor-pointer select-none">
          <input type="checkbox" checked={previous} onChange={e => setPrevious(e.target.checked)} className="accent-brand-500" />
          Previous container
        </label>

        <label className="flex items-center gap-1.5 text-2xs cursor-pointer select-none ml-auto">
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="accent-success" />
          <span className={autoRefresh ? 'text-success' : 'text-surface-400'}>Auto-refresh (5s)</span>
        </label>
      </div>

      {/* Log content */}
      <div className="flex-1 overflow-y-auto p-4 font-mono text-2xs leading-relaxed">
        {loading && lines.length === 0 && (
          <p className="text-surface-500 animate-pulse">Loading logs…</p>
        )}
        {unavailable && (
          <div className="flex flex-col items-center justify-center h-40 gap-3 text-center">
            <ScrollText className="w-8 h-8 text-surface-700" />
            <p className="text-surface-400 text-xs font-semibold">Logs unavailable</p>
            <p className="text-surface-600 text-2xs max-w-xs">{unavailable}</p>
          </div>
        )}
        {error && (
          <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-danger text-xs">{error}</div>
        )}
        {!error && !loading && lines.length === 0 && (
          <p className="text-surface-600">No log output found.</p>
        )}
        {lines.map((line, i) => {
          const lower = line.toLowerCase()
          const cls =
            lower.includes('error') || lower.includes('fatal') || lower.includes('panic')
              ? 'text-danger'
              : lower.includes('warn')
              ? 'text-warning'
              : lower.includes('info') || lower.includes('level=info')
              ? 'text-surface-300'
              : 'text-surface-500'
          return (
            <div key={i} className={cn('whitespace-pre-wrap break-all py-px', cls)}>
              {line}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
