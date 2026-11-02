import { NextResponse } from 'next/server'
import { assertAdmin }  from '@/lib/rbac'
import fs               from 'fs'
import { AUDIT_PATH }   from '../config/shared'

type AuditEntry = {
  ts?: string
  user?: string
  action?: string
  fields?: string[]
  detail?: string
}

function readEntries(): AuditEntry[] {
  const files = [`${AUDIT_PATH}.2`, `${AUDIT_PATH}.1`, AUDIT_PATH]
  return files.flatMap(file => {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf-8').split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as AuditEntry } catch { return null }
      })
      .filter((entry): entry is AuditEntry => entry !== null && typeof entry === 'object')
  }).sort((a, b) => Date.parse(b.ts ?? '') - Date.parse(a.ts ?? ''))
}

// ── GET /api/settings/audit — admin-only audit history ───────
export async function GET(req: Request) {
  const deny = await assertAdmin()
  if (deny) return deny

  const { searchParams } = new URL(req.url)
  const requestedPage = Number.parseInt(searchParams.get('page') ?? '0', 10)
  const requestedPageSize = Number.parseInt(searchParams.get('pageSize') ?? '20', 10)
  const page = Number.isFinite(requestedPage) ? Math.max(requestedPage, 0) : 0
  const pageSize = Number.isFinite(requestedPageSize) ? Math.min(Math.max(requestedPageSize, 1), 100) : 20
  const userFilter = (searchParams.get('user') ?? '').trim().toLowerCase()
  const actionFilter = (searchParams.get('action') ?? '').trim().toLowerCase()

  try {
    const all = readEntries().filter(entry =>
      (!userFilter || (entry.user ?? '').toLowerCase().includes(userFilter)) &&
      (!actionFilter || (entry.action ?? '').toLowerCase().includes(actionFilter))
    )

    const total = all.length
    const entries = searchParams.get('export') === '1'
      ? all
      : all.slice(page * pageSize, (page + 1) * pageSize)

    return NextResponse.json({ entries, total, page, pageSize })
  } catch (e: any) {
    return NextResponse.json({ error: 'Unable to read audit log' }, { status: 500 })
  }
}
