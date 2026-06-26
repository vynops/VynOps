import { NextResponse } from 'next/server'
import type { Trace, TraceSpan } from '@/types'
import { resolveJaegerUrl } from '@/lib/cluster'

const TIMEOUT = 8000

// ── Jaeger span → TraceSpan ──────────────────────────────────────────────────

function spanStatus(tags: { key: string; value: unknown }[]): TraceSpan['status'] {
  const tagMap = Object.fromEntries(tags.map(t => [t.key, t.value]))
  if (tagMap['error'] === true || String(tagMap['error']).toLowerCase() === 'true') return 'error'
  return 'ok'
}

function depthOf(spanId: string, parentMap: Record<string, string>, memo: Record<string, number> = {}): number {
  if (spanId in memo) return memo[spanId]
  const parent = parentMap[spanId]
  const d = parent ? 1 + depthOf(parent, parentMap, memo) : 0
  memo[spanId] = d
  return d
}

function shapeTrace(raw: Record<string, unknown>): Trace | null {
  const spansRaw = (raw.spans as Record<string, unknown>[]) ?? []
  const processes = (raw.processes as Record<string, { serviceName: string }>) ?? {}

  if (!spansRaw.length) return null

  // Earliest span = trace start (Jaeger times are in microseconds)
  const traceStartUs = Math.min(...spansRaw.map(s => s.startTime as number))
  const traceEndUs   = Math.max(...spansRaw.map(s => (s.startTime as number) + (s.duration as number)))
  const totalMs      = Math.max(1, Math.round((traceEndUs - traceStartUs) / 1000))

  // Build parent map for depth calculation
  const parentMap: Record<string, string> = {}
  for (const s of spansRaw) {
    for (const ref of (s.references as { refType: string; spanID: string }[]) ?? []) {
      if (ref.refType === 'CHILD_OF') parentMap[s.spanID as string] = ref.spanID
    }
  }

  const depthMemo: Record<string, number> = {}

  const spans: TraceSpan[] = spansRaw
    .sort((a, b) => (a.startTime as number) - (b.startTime as number))
    .map(s => {
      const rawTags = (s.tags as { key: string; value: unknown }[]) ?? []
      const proc    = processes[s.processID as string] ?? {}
      const startUs = s.startTime as number
      const durUs   = s.duration as number
      const spanId  = s.spanID as string
      const parent  = parentMap[spanId]

      // Determine status — slow = >1s individual span
      let status: TraceSpan['status'] = spanStatus(rawTags)
      if (status === 'ok' && durUs > 1_000_000) status = 'slow'

      return {
        id:          spanId,
        parentId:    parent,
        service:     proc.serviceName ?? (s.processID as string) ?? 'unknown',
        operation:   s.operationName as string ?? '',
        startOffset: Math.max(0, Math.round((startUs - traceStartUs) / 1000)),
        duration:    Math.max(0, Math.round(durUs / 1000)),
        depth:       depthOf(spanId, parentMap, depthMemo),
        status,
        tags:        Object.fromEntries(rawTags.map(t => [t.key, String(t.value)])),
      }
    })

  // Root span = first span with no parent
  const rootSpan = spansRaw
    .sort((a, b) => (a.startTime as number) - (b.startTime as number))
    .find(s => !parentMap[s.spanID as string]) ?? spansRaw[0]

  const rootProc    = processes[(rootSpan?.processID as string) ?? ''] ?? {}
  const hasError    = spans.some(s => s.status === 'error')
  const hasSlow     = spans.some(s => s.status === 'slow')
  const traceStatus = hasError ? 'error' : hasSlow ? 'slow' : 'ok'

  return {
    id:            raw.traceID as string,
    rootOperation: rootSpan?.operationName as string ?? '',
    rootService:   rootProc.serviceName ?? '',
    totalDuration: totalMs,
    spanCount:     spans.length,
    status:        traceStatus,
    startedAt:     new Date(traceStartUs / 1000).toISOString(),
    spans,
  }
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const JAEGER = await resolveJaegerUrl()
  const { searchParams } = new URL(request.url)
  const service     = searchParams.get('service') ?? ''
  const lookback    = searchParams.get('lookback') ?? '1h'
  const limit       = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100)
  const minDuration = searchParams.get('minDuration') ?? ''
  const traceId     = searchParams.get('traceId') ?? ''

  // Step 0: direct trace lookup by ID (bypasses service requirement)
  if (traceId && /^[0-9a-f]{32}$/.test(traceId)) {
    let services: string[] = []
    try {
      const svcRes = await fetch(`${JAEGER}/api/services`, { signal: AbortSignal.timeout(TIMEOUT) })
      if (svcRes.ok) { const b = await svcRes.json(); services = (b.data ?? []) as string[] }
    } catch { /* best-effort */ }
    try {
      const traceRes = await fetch(`${JAEGER}/api/traces/${traceId}`, { signal: AbortSignal.timeout(TIMEOUT) })
      if (!traceRes.ok) return NextResponse.json({ traces: [], total: 0, jaegerAvailable: true, jaegerUI: JAEGER, services })
      const body = await traceRes.json()
      const traces = ((body.data ?? []) as Record<string, unknown>[]).map(shapeTrace).filter(Boolean) as Trace[]
      return NextResponse.json({ traces, total: traces.length, jaegerAvailable: true, jaegerUI: JAEGER, services })
    } catch {
      return NextResponse.json({ traces: [], total: 0, jaegerAvailable: true, jaegerUI: JAEGER, services })
    }
  }

  // Step 1: probe Jaeger availability via /api/services (no required params)
  let services: string[] = []
  try {
    const svcRes = await fetch(`${JAEGER}/api/services`, { signal: AbortSignal.timeout(TIMEOUT) })
    if (!svcRes.ok) {
      return NextResponse.json({ traces: [], total: 0, jaegerAvailable: false, services: [] })
    }
    const svcBody = await svcRes.json()
    services = (svcBody.data ?? []) as string[]
  } catch {
    return NextResponse.json({ traces: [], total: 0, jaegerAvailable: false, services: [] })
  }

  // Jaeger is up. If no service selected, return available services so the UI
  // can populate the dropdown — traces require a service parameter.
  if (!service) {
    const firstService = services[0] ?? ''
    if (!firstService) {
      return NextResponse.json({ traces: [], total: 0, jaegerAvailable: true, jaegerUI: JAEGER, services })
    }
    // Auto-fetch traces for the first service so the UI isn't empty on first load
    const autoParams = new URLSearchParams({ service: firstService, limit: String(limit), lookback })
    try {
      const autoRes = await fetch(`${JAEGER}/api/traces?${autoParams}`, { signal: AbortSignal.timeout(TIMEOUT) })
      const autoBody = autoRes.ok ? await autoRes.json() : { data: [] }
      const traces = ((autoBody.data ?? []) as Record<string, unknown>[])
        .map(shapeTrace).filter(Boolean) as Trace[]
      return NextResponse.json({ traces, total: traces.length, jaegerAvailable: true, jaegerUI: JAEGER, services })
    } catch {
      return NextResponse.json({ traces: [], total: 0, jaegerAvailable: true, jaegerUI: JAEGER, services })
    }
  }

  // Step 2: fetch traces for the specified service
  const params = new URLSearchParams({ service, limit: String(limit), lookback })
  if (minDuration) params.set('minDuration', minDuration)

  try {
    const tracesRes = await fetch(`${JAEGER}/api/traces?${params}`, { signal: AbortSignal.timeout(TIMEOUT) })
    const tracesBody = tracesRes.ok ? await tracesRes.json() : { data: [] }
    const raw: Record<string, unknown>[] = tracesBody.data ?? []
    const traces: Trace[] = raw.map(shapeTrace).filter(Boolean) as Trace[]
    return NextResponse.json({ traces, total: traces.length, jaegerAvailable: true, jaegerUI: JAEGER, services })
  } catch {
    return NextResponse.json({ traces: [], total: 0, jaegerAvailable: true, jaegerUI: JAEGER, services })
  }
}
