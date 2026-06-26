import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { readOutcomes } from '@/lib/autonomousLearning'

const LOG_FILE = join(process.cwd(), 'data', 'autonomous.log.jsonl')

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100'), 500)

  if (!existsSync(LOG_FILE)) return NextResponse.json({ entries: [], total: 0 })

  try {
    const lines    = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    const raw      = lines.map(l => JSON.parse(l))

    // Join outcome data so the UI can show resolved/persisted per action
    const outcomes   = readOutcomes()
    const outcomeMap = new Map(outcomes.map(o => [o.actionId, o]))

    const entries = raw.reverse().slice(0, limit).map(entry => {
      if (entry.id) {
        const o = outcomeMap.get(entry.id)
        if (o) return { ...entry, outcome: o.outcome, outcomeCheckedAt: o.ts }
        if (entry.result === 'ok') return { ...entry, outcome: 'pending' }
      }
      return entry
    })

    return NextResponse.json({ entries, total: lines.length })
  } catch {
    return NextResponse.json({ entries: [], total: 0 })
  }
}
