import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { assertOperator, assertSession } from '@/lib/rbac'
import type { OnCallMember, EscalationLevel, OnCallSchedule, OnCallData } from '@/app/api/settings/oncall/shared'

const DATA_DIR  = join(process.cwd(), 'data')
const ONCALL_FILE = join(DATA_DIR, 'oncall.json')

const DEFAULT_DATA: OnCallData = {
  schedules: [
    {
      id:            'primary',
      name:          'Platform Engineering',
      rotationDays:  7,
      rotationStart: '2026-06-02T00:00:00Z',
      members: [
        { id: 'm1', name: 'Admin', email: 'admin@VynOps.io' },
      ],
      escalationLevels: [
        { level: 1, delayMins: 0,  description: 'Primary on-call' },
        { level: 2, delayMins: 15, description: 'Secondary (wake-up)' },
        { level: 3, delayMins: 30, description: 'Engineering Lead' },
      ],
    },
  ],
}

function readData(): OnCallData {
  if (!existsSync(ONCALL_FILE)) return DEFAULT_DATA
  try {
    return JSON.parse(readFileSync(ONCALL_FILE, 'utf8')) as OnCallData
  } catch { return DEFAULT_DATA }
}

function writeData(data: OnCallData): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(ONCALL_FILE, JSON.stringify(data, null, 2), 'utf8')
}

/** Compute current on-call person for a schedule */
function currentOnCall(sched: OnCallSchedule): OnCallMember | null {
  const now = Date.now()

  // Active override takes precedence
  if (sched.overrideUntil && sched.overrideMember) {
    if (new Date(sched.overrideUntil).getTime() > now) return sched.overrideMember
  }

  if (!sched.members.length) return null

  const rotationMs = sched.rotationDays * 24 * 60 * 60 * 1000
  const elapsed    = now - new Date(sched.rotationStart).getTime()
  const idx        = Math.floor(elapsed / rotationMs) % sched.members.length
  return sched.members[Math.max(0, idx)] ?? sched.members[0] ?? null
}

// ?? GET ???????????????????????????????????????????????????????

export async function GET() {
  const deny = await assertSession()
  if (deny) return deny

  const data = readData()

  const enriched = data.schedules.map(s => ({
    ...s,
    currentOnCall:     currentOnCall(s),
    nextRotationAt:    (() => {
      const rotMs   = s.rotationDays * 24 * 60 * 60 * 1000
      const elapsed = Date.now() - new Date(s.rotationStart).getTime()
      return new Date(new Date(s.rotationStart).getTime() + (Math.floor(elapsed / rotMs) + 1) * rotMs).toISOString()
    })(),
  }))

  return NextResponse.json({ schedules: enriched })
}

// ?? PUT: replace entire schedule list ????????????????????????

export async function PUT(req: NextRequest) {
  const deny = await assertOperator()
  if (deny) return deny

  let body: Partial<OnCallData>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data = readData()

  if (Array.isArray(body.schedules)) {
    // Basic validation
    for (const s of body.schedules) {
      if (!s.id || !s.name || !Array.isArray(s.members)) {
        return NextResponse.json({ error: 'Invalid schedule: id, name, members required' }, { status: 400 })
      }
    }
    data.schedules = body.schedules as OnCallSchedule[]
    writeData(data)
  }

  return NextResponse.json(data)
}

// ?? POST: override current on-call ???????????????????????????

export async function POST(req: NextRequest) {
  const deny = await assertOperator()
  if (deny) return deny

  let body: { scheduleId: string; member: OnCallMember; durationMins: number }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data = readData()
  const sched = data.schedules.find(s => s.id === body.scheduleId)
  if (!sched) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })

  sched.overrideMember = body.member
  sched.overrideUntil  = new Date(Date.now() + (body.durationMins ?? 60) * 60_000).toISOString()
  writeData(data)

  return NextResponse.json({ ...sched, currentOnCall: currentOnCall(sched) })
}
