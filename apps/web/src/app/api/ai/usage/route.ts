import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { auth } from '@/lib/auth'
import { summarizeAIUsage, summarizeAIUsageBySource } from '@/lib/ai-usage'

const USAGE_FILE = join(process.cwd(), 'data', 'ai-usage.jsonl')

function readEntries() {
  if (!existsSync(USAGE_FILE)) return []
  return readFileSync(USAGE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '500'), 1000)

  const allEntries = readEntries()
  const entries = allEntries.slice().reverse().slice(0, limit)
  const todayStr   = new Date().toISOString().slice(0, 10)
  const todayEntries = allEntries.filter((e: any) => e.ts?.startsWith(todayStr))

  const totals = {
    allTime: {
      ...summarizeAIUsage(allEntries),
      bySource: summarizeAIUsageBySource(allEntries),
    },
    today: {
      ...summarizeAIUsage(todayEntries),
      bySource: summarizeAIUsageBySource(todayEntries),
    },
  }

  return NextResponse.json({ entries, totals })
}
