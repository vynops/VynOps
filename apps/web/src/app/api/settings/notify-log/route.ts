import { NextResponse }  from 'next/server'
import { auth }          from '@/lib/auth'
import fs                from 'fs'
import { NOTIF_LOG_PATH } from '../config/shared'

// ── GET /api/settings/notify-log — last 50 delivery entries ──
export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200)

  try {
    if (!fs.existsSync(NOTIF_LOG_PATH)) return NextResponse.json({ entries: [] })

    const lines = fs.readFileSync(NOTIF_LOG_PATH, 'utf-8')
      .trim().split('\n')
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)

    return NextResponse.json({ entries: lines })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
