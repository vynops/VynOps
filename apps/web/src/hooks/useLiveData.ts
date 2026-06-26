import { useState, useEffect, useCallback, useRef } from 'react'
import { useDashboardStore } from '@/store'

const VALID_RANGES = ['15m','30m','1h','3h','6h','12h','24h','7d','30d']
/** Read the persisted time range directly from localStorage (client only). */
function readPersistedWindow(): string | null {
  try {
    const v = typeof window !== 'undefined' ? localStorage.getItem('timeRange') : null
    return v && VALID_RANGES.includes(v) ? v : null
  } catch { return null }
}
/**
 * If the URL contains a `window=` query param whose value is a range label
 * (e.g. '1h', '24h') — i.e. NOT already a numeric minutes value — replace it
 * with the localStorage-persisted value so stale defaults are corrected.
 * Numeric values (e.g. window=10080) are left untouched.
 */
function applyPersistedWindow(url: string): string {
  const saved = readPersistedWindow()
  if (!saved) return url
  return url.replace(/([?&]window=)([^&]+)/, (match, prefix, val) => {
    // If the current value is already numeric minutes, leave it alone
    if (/^\d+$/.test(val)) return match
    // Only replace range labels
    return VALID_RANGES.includes(val) ? prefix + saved : match
  })
}

interface UseLiveDataResult<T> {
  data: T
  loading: boolean
  error: string | null
  isLive: boolean
  refresh: () => void
}

export function useLiveData<T>(
  url: string,
  fallback: T,
  transform?: (raw: any) => T,
  intervalMs = 30_000,
): UseLiveDataResult<T> {
  // Start with empty-equivalent to match SSR, set fallback on client
  const [data, setData] = useState<T>(fallback)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isLive, setIsLive] = useState(false)
  const [mounted, setMounted] = useState(false)
  const transformRef = useRef(transform)
  transformRef.current = transform

  // Read isRealtimeActive and activeCluster from global store
  const isRealtimeActive = useDashboardStore(s => s.isRealtimeActive)
  const activeCluster = useDashboardStore(s => s.activeCluster)

  useEffect(() => {
    setMounted(true)
    setData(fallback) // ensure fallback is applied client-side
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reset to fallback immediately when cluster changes so stale data from the
  // previous cluster never persists while the new fetch is in-flight or fails.
  useEffect(() => {
    if (!mounted) return
    setData(fallback)
    setIsLive(false)
    setError(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCluster?.id])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const reqHeaders: Record<string, string> = {}
      if (activeCluster) {
        // Always send all 6 headers when a cluster is selected.
        // 'none' sentinel tells the resolver NOT to fall back to env vars for
        // services the cluster doesn't have configured.
        reqHeaders['X-K8s-Url']          = activeCluster.k8sUrl          || 'none'
        reqHeaders['X-Prom-Url']         = activeCluster.promUrl         || 'none'
        reqHeaders['X-Alertmanager-Url'] = activeCluster.alertmanagerUrl || 'none'
        reqHeaders['X-Loki-Url']         = activeCluster.lokiUrl         || 'none'
        reqHeaders['X-Jaeger-Url']       = activeCluster.jaegerUrl       || 'none'
        reqHeaders['X-Grafana-Url']      = activeCluster.grafanaUrl      || 'none'
      }
      // On first client render the URL may contain the SSR default '1h'.
      // Correct it to the persisted localStorage value before fetching.
      const effectiveUrl = applyPersistedWindow(url)
      const res = await fetch(effectiveUrl, Object.keys(reqHeaders).length ? { headers: reqHeaders } : undefined)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        const msg = body?.error ?? `HTTP ${res.status}`
        setError(msg)
        setIsLive(false)
        return
      }
      const raw = await res.json()
      const result = transformRef.current ? transformRef.current(raw) : raw as T
      if (result !== null && result !== undefined) {
        setData(result)
        setIsLive(true)
      }
    } catch (e) {
      setError(String(e))
      setIsLive(false)
    } finally {
      setLoading(false)
    }
  }, [url, activeCluster])

  useEffect(() => {
    if (!mounted) return
    fetchData()
    // Only set up polling interval when realtime is active
    if (!isRealtimeActive) return
    const interval = setInterval(fetchData, intervalMs)
    return () => clearInterval(interval)
  }, [fetchData, intervalMs, mounted, isRealtimeActive])

  return { data, loading, error, isLive, refresh: fetchData }
}
