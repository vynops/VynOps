import { NextResponse } from 'next/server'
import { resolveLokiUrl } from '@/lib/cluster'

const TIMEOUT = 8_000

function detectLevel(msg: string): string {
  const m = msg.toLowerCase()
  if (/\b(error|err|fatal|panic|crit)\b/.test(m)) return 'ERROR'
  if (/\b(warn|warning)\b/.test(m))               return 'WARN'
  if (/\bdebug\b/.test(m))                         return 'DEBUG'
  return 'INFO'
}

function parseStreams(data: Record<string, unknown>): { id: number; ts: string; level: string; msg: string; labels: Record<string, string> }[] {
  const lines: { id: number; ts: string; level: string; msg: string; labels: Record<string, string> }[] = []
  let id = 0
  for (const stream of ((data?.result ?? []) as any[])) {
    const labels = (stream.stream ?? {}) as Record<string, string>
    const streamLevel = (labels.level ?? labels.severity ?? '').toUpperCase() || null
    for (const [tsNs, rawMsg] of ((stream.values ?? []) as [string, string][])) {
      const msg   = String(rawMsg)
      const level = streamLevel || detectLevel(msg)
      lines.push({ id: id++, ts: new Date(parseInt(tsNs) / 1_000_000).toISOString(), level, msg, labels })
    }
  }
  return lines.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
}

export async function GET(request: Request) {
  const LOKI = await resolveLokiUrl()
  if (!LOKI) {
    return NextResponse.json({ lines: [], lokiAvailable: false, lokiUrl: '', labels: [] })
  }

  const { searchParams } = new URL(request.url)
  const query = searchParams.get('query') ?? ''
  const since = Math.min(Math.max(parseInt(searchParams.get('since') ?? '60', 10), 1), 10080)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10), 1000)
  const startParam = searchParams.get('start') ? parseInt(searchParams.get('start')!, 10) : null
  const endParam   = searchParams.get('end')   ? parseInt(searchParams.get('end')!,   10) : null

  // Probe Loki + get label names
  let labels: string[] = []
  try {
    const labelsRes = await fetch(`${LOKI}/loki/api/v1/labels`, { signal: AbortSignal.timeout(TIMEOUT) })
    if (!labelsRes.ok) {
      return NextResponse.json({ lines: [], lokiAvailable: false, lokiUrl: LOKI, labels: [] })
    }
    const body = await labelsRes.json()
    labels = (body.data ?? []) as string[]
  } catch {
    return NextResponse.json({ lines: [], lokiAvailable: false, lokiUrl: LOKI, labels: [] })
  }

  // No query → just return availability + labels for the UI to populate dropdowns
  if (!query.trim()) {
    return NextResponse.json({ lines: [], lokiAvailable: true, lokiUrl: LOKI, labels })
  }

  // Query log range
  const now   = Math.floor(Date.now() / 1000)
  const start = startParam ?? (now - since * 60)
  const end   = endParam   ?? now
  const params = new URLSearchParams({
    query, limit: String(limit), direction: 'backward',
    start: String(start), end: String(end),
  })

  try {
    const res = await fetch(`${LOKI}/loki/api/v1/query_range?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT * 2),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return NextResponse.json({ lines: [], lokiAvailable: true, lokiUrl: LOKI, labels, error: errText })
    }
    const body = await res.json()
    const lines = parseStreams(body.data ?? {})
    return NextResponse.json({ lines, total: lines.length, lokiAvailable: true, lokiUrl: LOKI, labels })
  } catch (e) {
    return NextResponse.json({ lines: [], lokiAvailable: true, lokiUrl: LOKI, labels, error: String(e) })
  }
}
