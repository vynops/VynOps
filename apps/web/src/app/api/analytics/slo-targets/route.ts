import { NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { assertOperator } from '@/lib/rbac'

const DATA_DIR = join(process.cwd(), 'data')
const SLO_FILE = join(DATA_DIR, 'slo-targets.json')

function load(): Record<string, number> {
  try {
    if (existsSync(SLO_FILE)) return JSON.parse(readFileSync(SLO_FILE, 'utf8'))
  } catch {}
  return {}
}

export async function GET() {
  return NextResponse.json(load())
}

export async function PUT(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny

  let body: { key: string; target: number }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { key, target } = body
  if (!key || typeof target !== 'number' || target <= 0 || target > 100)
    return NextResponse.json({ error: 'key (string) and target (0–100) are required' }, { status: 400 })

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const current = load()
  current[key] = parseFloat(target.toFixed(4))
  writeFileSync(SLO_FILE, JSON.stringify(current, null, 2))
  return NextResponse.json({ ok: true, key, target: current[key] })
}

export async function DELETE(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny

  let body: { key: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const current = load()
  delete current[body.key]
  writeFileSync(SLO_FILE, JSON.stringify(current, null, 2))
  return NextResponse.json({ ok: true })
}
