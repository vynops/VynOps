import { NextResponse }  from 'next/server'
import { auth }          from '@/lib/auth'
import { assertOperator } from '@/lib/rbac'
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const DATA_DIR = join(process.cwd(), 'data')
const LOG_FILE = join(DATA_DIR, 'automation.log.jsonl')
const MAX_ENTRIES = 500

function readEntries(): object[] {
  if (!existsSync(LOG_FILE)) return []
  try {
    return readFileSync(LOG_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => JSON.parse(l))
  } catch { return [] }
}

function writeEntries(entries: object[]) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(LOG_FILE, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8')
}

// ── GET — return run history newest-first ──────────────────────────────────
export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100'), 500)

  const entries = readEntries()
  return NextResponse.json({
    entries: [...entries].reverse().slice(0, limit),
    total:   entries.length,
  })
}

// ── POST — append a new run record ─────────────────────────────────────────
export async function POST(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body?.id || !body?.runAt || !body?.runbookId) {
    return NextResponse.json({ error: 'Missing required fields: id, runAt, runbookId' }, { status: 400 })
  }

  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG_FILE, JSON.stringify(body) + '\n', 'utf8')
  } catch {
    return NextResponse.json({ error: 'Failed to write log' }, { status: 500 })
  }

  // Trim oldest entries if over cap
  const entries = readEntries()
  if (entries.length > MAX_ENTRIES) {
    writeEntries(entries.slice(-MAX_ENTRIES))
  }

  return NextResponse.json({ ok: true })
}

// ── DELETE — remove one entry by id, or clear all ─────────────────────────
export async function DELETE(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')

  if (id) {
    const before  = readEntries() as any[]
    const after   = before.filter(e => e.id !== id)
    writeEntries(after)
    return NextResponse.json({ ok: true, deleted: before.length - after.length })
  }

  // Clear all
  writeEntries([])
  return NextResponse.json({ ok: true, deleted: 'all' })
}
