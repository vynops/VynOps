import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { promises as fs } from 'fs'
import path from 'path'
import { z } from 'zod'

const HISTORY_FILE = path.join(process.cwd(), '.data', 'chat-history.json')
const MAX_CONVERSATIONS = 20

// ── Schema ────────────────────────────────────────────────────
const MessageSchema = z.object({
  id:      z.string(),
  role:    z.enum(['user', 'assistant', 'system']),
  content: z.string(),
})

const ConversationSchema = z.object({
  id:       z.string(),
  title:    z.string(),
  ts:       z.string(),
  mode:     z.string().optional(),
  messages: z.array(MessageSchema),
})

const BodySchema = z.object({
  conversations: z.array(ConversationSchema).max(MAX_CONVERSATIONS),
})

async function readHistory(): Promise<object[]> {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ── GET /api/ai/chat/history ──────────────────────────────────
export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const conversations = await readHistory()
  return NextResponse.json({ conversations })
}

// ── POST /api/ai/chat/history ─────────────────────────────────
export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  }

  const conversations = parsed.data.conversations.slice(0, MAX_CONVERSATIONS)

  // Atomic write: write to temp file then rename
  const tmp = HISTORY_FILE + '.tmp'
  try {
    await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(conversations), 'utf8')
    await fs.rename(tmp, HISTORY_FILE)
  } catch (err) {
    // Clean up temp file on error
    await fs.unlink(tmp).catch(() => {})
    return NextResponse.json({ error: 'Failed to save history' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, saved: conversations.length })
}
