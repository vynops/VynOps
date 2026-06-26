import { NextResponse } from 'next/server'
import { auth }         from '@/lib/auth'
import fs               from 'fs'
import { AUDIT_PATH }   from '../config/shared'

// ── GET /api/settings/audit — last 100 audit entries ─────────
export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const page       = Math.max(parseInt(searchParams.get('page')     ?? '0',  10), 0)
  const pageSize   = Math.min(parseInt(searchParams.get('pageSize') ?? '20', 10), 100)
  const userFilter = searchParams.get('user') ?? ''

  try {
    if (!fs.existsSync(AUDIT_PATH)) return NextResponse.json({ entries: [], total: 0, page, pageSize })

    const all = fs.readFileSync(AUDIT_PATH, 'utf-8')
      .trim().split('\n')
      .filter(Boolean)
      .reverse()                    // newest first
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
      .filter((e: any) => !userFilter || (e.user ?? '').includes(userFilter))

    const total   = all.length
    const entries = all.slice(page * pageSize, (page + 1) * pageSize)

    return NextResponse.json({ entries, total, page, pageSize })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
