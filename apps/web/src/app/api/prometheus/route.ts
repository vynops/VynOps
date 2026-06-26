import { NextRequest, NextResponse } from 'next/server'
import { resolvePromUrl } from '@/lib/cluster'

export async function GET(req: NextRequest) {
  const PROMETHEUS_URL = await resolvePromUrl()
  if (!PROMETHEUS_URL) {
    return NextResponse.json({ error: 'PROMETHEUS_URL not configured' }, { status: 503 })
  }

  const { searchParams } = req.nextUrl
  const query = searchParams.get('query')
  const type = searchParams.get('type') ?? 'query' // 'query' or 'query_range'

  if (!query) {
    return NextResponse.json({ error: 'query param required' }, { status: 400 })
  }

  const params = new URLSearchParams({ query })
  if (type === 'query_range') {
    params.set('start', searchParams.get('start') ?? '')
    params.set('end', searchParams.get('end') ?? '')
    params.set('step', searchParams.get('step') ?? '60')
  }

  try {
    const upstream = await fetch(
      `${PROMETHEUS_URL}/api/v1/${type}?${params}`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 0 } },
    )
    const data = await upstream.json()
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
