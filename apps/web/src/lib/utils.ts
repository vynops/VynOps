import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { formatDistanceToNow, format } from 'date-fns'
import type { Severity, HealthStatus } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTs(ts: string | number, pattern = 'HH:mm:ss') {
  return format(new Date(ts), pattern)
}

export function timeAgo(ts: string | number) {
  return formatDistanceToNow(new Date(ts), { addSuffix: true })
}

export function severityClass(severity: Severity): string {
  const map: Record<Severity, string> = {
    critical: 'severity-critical',
    high:     'severity-high',
    medium:   'severity-medium',
    low:      'severity-low',
    info:     'severity-info',
  }
  return map[severity]
}

export function severityDot(severity: Severity): string {
  const map: Record<Severity, string> = {
    critical: 'bg-danger',
    high:     'bg-orange-500',
    medium:   'bg-warning',
    low:      'bg-info',
    info:     'bg-surface-500',
  }
  return map[severity]
}

export function healthStatusClass(status: HealthStatus): string {
  const map: Record<HealthStatus, string> = {
    healthy:  'status-dot healthy',
    degraded: 'status-dot warning',
    critical: 'status-dot critical',
    unknown:  'status-dot unknown',
  }
  return map[status]
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB/s`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB/s`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB/s`
  return `${bytes} B/s`
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

export function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

export function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

export function trendColor(value: number, inverted = false): string {
  const positive = inverted ? value < 0 : value > 0
  return positive ? 'text-success' : 'text-danger'
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function exportCSV(rows: Record<string, unknown>[], filename = 'export.csv') {
  if (!rows.length) return
  const headers = Object.keys(rows[0]!)
  const csvContent = [
    headers.join(','),
    ...rows.map(row =>
      headers.map(h => {
        const val = String(row[h] ?? '')
        return val.includes(',') || val.includes('"') || val.includes('\n')
          ? `"${val.replace(/"/g, '""')}"` : val
      }).join(','),
    ),
  ].join('\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
