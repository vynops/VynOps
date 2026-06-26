/**
 * SSE endpoint for real-time metric streaming.
 * Queries Prometheus on each tick when PROMETHEUS_URL is set.
 * Falls back to realistic jitter simulation when Prometheus is unavailable.
 *
 * Connect via:  const es = new EventSource('/api/stream')
 *
 * Event format:
 *   data: {"type":"metrics","payload":{...}}
 *   data: {"type":"ping"}
 */

import { NextRequest, NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl } from '@/lib/cluster'

const INTERVAL_MS    = 10_000          // poll every 10s (was 5s) — reduces fetch queue
const MAX_DURATION_MS = 5 * 60 * 1_000 // auto-close after 5 min (was 10 min)

async function promInstant(query: string): Promise<number | null> {
  const PROM = await resolvePromUrl()
  if (!PROM) return null
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(2000),
    })
    const json = await r.json()
    const val = json.data?.result?.[0]?.value?.[1]
    return val !== undefined ? parseFloat(val) : null
  } catch { return null }
}

async function promRange(query: string, minutes = 5): Promise<number | null> {
  const PROM = await resolvePromUrl()
  if (!PROM) return null
  const end   = Math.floor(Date.now() / 1000)
  const start = end - minutes * 60
  try {
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=60`
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
    const json = await r.json()
    const vals: [number, string][] = json.data?.result?.[0]?.values ?? []
    if (!vals.length) return null
    return parseFloat(vals[vals.length - 1][1])
  } catch { return null }
}

async function getLiveMetrics(state: ReturnType<typeof makeInitialState>) {
  const K8S = await resolveK8sUrl()
  const [cpu, mem, activePods] = await Promise.all([
    promInstant('sum(rate(node_cpu_seconds_total{mode!="idle"}[2m])) / sum(rate(node_cpu_seconds_total[2m])) * 100'),
    promInstant('(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100'),
    K8S
      ? fetch(`${K8S}/api/v1/pods`, { signal: AbortSignal.timeout(2000) })
          .then(r => r.json())
          .then(d => (d.items ?? []).filter((p: any) => p.status?.phase === 'Running').length)
          .catch(() => null)
      : promInstant('count(kube_pod_status_phase{phase="Running"})'),
  ])

  // Request rate: sum of HTTP request rate across all services (needs instrumentation)
  const reqRate = await promInstant('sum(rate(http_requests_total[2m]))')
  // Error rate: % of 5xx responses
  const errRate = await promInstant(
    'sum(rate(http_requests_total{status=~"5.."}[2m])) / sum(rate(http_requests_total[2m])) * 100',
  )
  // p99 latency in ms
  const p99 = await promInstant(
    'histogram_quantile(0.99, sum by(le)(rate(http_request_duration_seconds_bucket[2m]))) * 1000',
  )

  return { cpu, mem, reqRate, errRate, p99, activePods }
}

function jitter(base: number, maxPct = 0.08): number {
  return parseFloat((base * (1 + (Math.random() - 0.5) * 2 * maxPct)).toFixed(1))
}
function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function makeInitialState() {
  return { cpu: 68.4, memory: 74.2, requestRate: 1247, errorRate: 0.82, p99Latency: 247, activePods: 847 }
}

export async function GET() {
  const encoder = new TextEncoder()
  const state = makeInitialState()

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          // client disconnected
        }
      }

      // --- Metrics heartbeat ---
      const metricsTimer = setInterval(async () => {
        // Try Prometheus first; fall back to jitter simulation
        const live = await getLiveMetrics(state)

        state.cpu         = live.cpu         !== null ? clamp(live.cpu,        0,  100) : clamp(jitter(state.cpu),        25, 95)
        state.memory      = live.mem         !== null ? clamp(live.mem,        0,  100) : clamp(jitter(state.memory, 0.04), 40, 92)
        state.requestRate = live.reqRate     !== null ? Math.round(clamp(live.reqRate, 0, 50000)) : Math.round(clamp(jitter(state.requestRate, 0.06), 400, 3000))
        state.errorRate   = live.errRate     !== null ? clamp(live.errRate,    0,   50) : clamp(jitter(state.errorRate, 0.15), 0.1, 8.0)
        state.p99Latency  = live.p99         !== null ? Math.round(clamp(live.p99, 0, 30000))    : Math.round(clamp(jitter(state.p99Latency, 0.1), 50, 2000))
        if (live.activePods !== null) state.activePods = live.activePods as number

        send({
          type: 'metrics',
          ts: Date.now(),
          payload: {
            cpuUsage: state.cpu,
            memoryUsage: state.memory,
            requestRate: state.requestRate,
            errorRate: state.errorRate,
            p99Latency: state.p99Latency,
            activePods: state.activePods,
          },
        })
      }, INTERVAL_MS)

      // --- Ping to keep connection alive ---
      const pingTimer = setInterval(() => {
        send({ type: 'ping', ts: Date.now() })
      }, 30_000)

      // --- Auto-close after MAX_DURATION_MS ---
      const closeTimer = setTimeout(() => {
        clearInterval(metricsTimer)
        clearInterval(pingTimer)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }, MAX_DURATION_MS)

      // Send initial snapshot immediately
      send({
        type: 'metrics',
        ts: Date.now(),
        payload: {
          cpuUsage: state.cpu,
          memoryUsage: state.memory,
          requestRate: state.requestRate,
          errorRate: state.errorRate,
          p99Latency: state.p99Latency,
          activePods: state.activePods,
        },
      })

      // Cleanup on cancel (client disconnect)
      return () => {
        clearInterval(metricsTimer)
        clearInterval(pingTimer)
        clearTimeout(closeTimer)
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    },
  })
}
