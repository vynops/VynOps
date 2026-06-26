'use client'

import { useEffect, useRef } from 'react'
import { useDashboardStore } from '@/store'

interface MetricsPayload {
  cpuUsage: number
  memoryUsage: number
  requestRate: number
  errorRate: number
  p99Latency: number
  activePods: number
}

interface SSEEvent {
  type: 'metrics' | 'alert' | 'ping'
  ts?: number
  payload?: MetricsPayload
}

/**
 * Connects to the /api/stream SSE endpoint when realtimeActive is true.
 * Dispatches metric updates to the Zustand dashboard store.
 *
 * Mount this once in a layout or provider — it is idempotent.
 */
export function useRealtimeStream() {
  const isActive = useDashboardStore((s) => s.isRealtimeActive)
  const updateClusterMetrics = useDashboardStore((s) => s.updateClusterMetrics)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    if (!isActive) {
      esRef.current?.close()
      esRef.current = null
      return
    }

    // Avoid duplicate connections
    if (esRef.current) return

    const es = new EventSource('/api/stream')
    esRef.current = es

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SSEEvent
        if (data.type === 'metrics' && data.payload) {
          updateClusterMetrics(data.payload)
        }
      } catch {
        // ignore malformed events
      }
    }

    es.onerror = () => {
      // Browser will auto-reconnect on error; close cleanly on unmount
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [isActive, updateClusterMetrics])
}
