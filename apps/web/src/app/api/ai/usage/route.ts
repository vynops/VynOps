import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { auth } from '@/lib/auth'

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

  const entries = readEntries().reverse().slice(0, limit)

  // Aggregate totals
  const allEntries = readEntries()
  const todayStr   = new Date().toISOString().slice(0, 10)
  const todayEntries = allEntries.filter((e: any) => e.ts?.startsWith(todayStr))

  const totals = {
    allTime: {
      requests:         allEntries.length,
      promptTokens:     allEntries.reduce((s: number, e: any) => s + (e.promptTokens ?? 0), 0),
      completionTokens: allEntries.reduce((s: number, e: any) => s + (e.completionTokens ?? 0), 0),
      totalTokens:      allEntries.reduce((s: number, e: any) => s + (e.totalTokens ?? 0), 0),
    },
    today: {
      requests:         todayEntries.length,
      promptTokens:     todayEntries.reduce((s: number, e: any) => s + (e.promptTokens ?? 0), 0),
      completionTokens: todayEntries.reduce((s: number, e: any) => s + (e.completionTokens ?? 0), 0),
      totalTokens:      todayEntries.reduce((s: number, e: any) => s + (e.totalTokens ?? 0), 0),
    },
  }

  return NextResponse.json({ entries, totals })
}
