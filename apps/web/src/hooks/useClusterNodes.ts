import { useState, useEffect, useCallback } from 'react'
import { useDashboardStore } from '@/store'
import type { K8sNode } from '@/types'

interface UseClusterNodesResult {
  nodes: K8sNode[]
  loading: boolean
  error: string | null
  isLive: boolean
  refresh: () => void
}

export function useClusterNodes(fallback: K8sNode[]): UseClusterNodesResult {
  const [nodes, setNodes] = useState<K8sNode[]>([]) // empty on SSR to avoid hydration mismatch
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isLive, setIsLive] = useState(false)
  const [mounted, setMounted] = useState(false)

  const activeCluster = useDashboardStore(s => s.activeCluster)

  useEffect(() => {
    setMounted(true)
    setNodes(fallback) // apply fallback client-side
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetch_ = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const headers: Record<string, string> = {}
      if (activeCluster) {
        headers['X-K8s-Url']          = activeCluster.k8sUrl          || 'none'
        headers['X-Prom-Url']         = activeCluster.promUrl         || 'none'
        headers['X-Alertmanager-Url'] = activeCluster.alertmanagerUrl || 'none'
        headers['X-Loki-Url']         = activeCluster.lokiUrl         || 'none'
        headers['X-Jaeger-Url']       = activeCluster.jaegerUrl       || 'none'
        headers['X-Grafana-Url']      = activeCluster.grafanaUrl      || 'none'
      }
      const res = await fetch('/api/k8s/nodes', Object.keys(headers).length ? { headers } : undefined)
      if (res.status === 503) {
        setIsLive(false)
        setNodes([])  // clear stale data from previous cluster
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.nodes?.length) {
        const seen = new Set<string>()
        const unique = (data.nodes as K8sNode[]).filter(n => {
          if (seen.has(n.name)) return false
          seen.add(n.name)
          return true
        })
        setNodes(unique)
        setIsLive(true)
      }
    } catch (e) {
      setError(String(e))
      setIsLive(false)
    } finally {
      setLoading(false)
    }
  }, [activeCluster])

  useEffect(() => {
    if (!mounted) return
    fetch_()
    const interval = setInterval(fetch_, 30_000)
    return () => clearInterval(interval)
  }, [fetch_, mounted, activeCluster])

  return { nodes, loading, error, isLive, refresh: fetch_ }
}
