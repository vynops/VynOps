'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bot, History, Search, Trash2, ChevronDown, ChevronRight,
  MessageSquare, ArrowLeft, Loader2, TrendingUp, Lightbulb,
  Wrench, Sparkles, Filter, Clock, User, AlertTriangle,
  ExternalLink, CalendarDays, MessagesSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────
interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface Conversation {
  id: string
  title: string
  ts: string
  mode?: string
  messages: ChatMessage[]
}

// ── Mode config ───────────────────────────────────────────────
const MODES: Record<string, { label: string; icon: React.ElementType; color: string; bg: string; border: string }> = {
  investigate: { label: 'Investigate', icon: Search,    color: 'text-brand-400',   bg: 'bg-brand-500/10',  border: 'border-brand-500/30' },
  predict:     { label: 'Predict',     icon: TrendingUp, color: 'text-purple-400',  bg: 'bg-purple-500/10', border: 'border-purple-500/30' },
  optimize:    { label: 'Optimize',    icon: Lightbulb,  color: 'text-warning',     bg: 'bg-warning/10',    border: 'border-warning/30' },
  remediate:   { label: 'Remediate',   icon: Wrench,     color: 'text-success',     bg: 'bg-success/10',    border: 'border-success/30' },
  chat:        { label: 'Free Chat',   icon: Sparkles,   color: 'text-surface-400', bg: 'bg-surface-800',   border: 'border-surface-700' },
}

// ── Helpers ───────────────────────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7)  return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function absTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Inline markdown (simple renderer for history view) ────────
function MiniMarkdown({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <div className="space-y-1 text-xs text-surface-300 leading-relaxed">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1" />
        if (line.startsWith('### ')) return <p key={i} className="font-semibold text-surface-200 mt-2">{line.slice(4)}</p>
        if (line.startsWith('## '))  return <p key={i} className="font-bold text-white mt-2">{line.slice(3)}</p>
        if (line.startsWith('# '))   return <p key={i} className="font-bold text-white text-sm mt-2">{line.slice(2)}</p>
        if (line.startsWith('```'))  return null
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return <p key={i} className="flex gap-1.5"><span className="text-brand-400 flex-shrink-0">·</span><span>{formatInline(line.slice(2))}</span></p>
        }
        if (/^\d+\.\s/.test(line)) {
          const [num, ...rest] = line.split('. ')
          return <p key={i} className="flex gap-1.5"><span className="text-surface-500 flex-shrink-0 w-4">{num}.</span><span>{formatInline(rest.join('. '))}</span></p>
        }
        return <p key={i}>{formatInline(line)}</p>
      })}
    </div>
  )
}

function formatInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} className="text-white font-semibold">{p.slice(2, -2)}</strong>
    if (p.startsWith('`')  && p.endsWith('`'))  return <code key={i} className="font-mono bg-surface-700 px-1 rounded text-brand-300">{p.slice(1, -1)}</code>
    return p
  })
}

// ── Conversation card ─────────────────────────────────────────
function ConvCard({
  conv,
  isExpanded,
  isDeleting,
  onToggle,
  onDelete,
}: {
  conv: Conversation
  isExpanded: boolean
  isDeleting: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  const mode   = MODES[conv.mode ?? 'chat'] ?? MODES.chat
  const ModeIcon = mode.icon
  const userMsgs = conv.messages.filter(m => m.role === 'user')
  const asstMsgs = conv.messages.filter(m => m.role === 'assistant')
  const lastUser = [...userMsgs].reverse().find(m => m.content.trim())
  const lastAsst = [...asstMsgs].reverse().find(m => m.content.trim())
  const preview  = lastUser?.content ?? conv.title

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className={cn(
        'rounded-2xl border transition-all overflow-hidden',
        isExpanded ? 'border-brand-500/30 bg-surface-900' : 'border-surface-800 bg-surface-900 hover:border-surface-700',
      )}
    >
      {/* Card header */}
      <div className="flex items-start gap-3 p-4 cursor-pointer select-none" onClick={onToggle}>
        {/* Mode badge */}
        <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 border', mode.bg, mode.border)}>
          <ModeIcon className={cn('w-4 h-4', mode.color)} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-white leading-snug line-clamp-1">{conv.title}</p>
            <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
              {/* Open in copilot */}
              <Link
                href={`/dashboard/ai-copilot?conv=${conv.id}`}
                onClick={e => e.stopPropagation()}
                title="Open in Copilot"
                className="p-1.5 rounded-lg hover:bg-brand-500/10 text-surface-500 hover:text-brand-400 transition-all"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>
              {/* Delete */}
              <button
                onClick={e => { e.stopPropagation(); onDelete() }}
                disabled={isDeleting}
                title="Delete conversation"
                className="p-1.5 rounded-lg hover:bg-danger/10 text-surface-500 hover:text-danger transition-all disabled:opacity-40"
              >
                {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              </button>
              {/* Expand toggle */}
              <div className="p-1.5 text-surface-500">
                {isExpanded
                  ? <ChevronDown className="w-3.5 h-3.5 text-brand-400" />
                  : <ChevronRight className="w-3.5 h-3.5" />}
              </div>
            </div>
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            <span className={cn('text-2xs font-medium px-1.5 py-0.5 rounded-md border', mode.bg, mode.border, mode.color)}>
              {mode.label}
            </span>
            <span className="flex items-center gap-1 text-2xs text-surface-500" title={absTime(conv.ts)}>
              <Clock className="w-3 h-3" />{relativeTime(conv.ts)}
            </span>
            <span className="flex items-center gap-1 text-2xs text-surface-500">
              <MessagesSquare className="w-3 h-3" />{userMsgs.length} question{userMsgs.length !== 1 ? 's' : ''}
            </span>
            <span className="flex items-center gap-1 text-2xs text-surface-500">
              <Bot className="w-3 h-3" />{asstMsgs.length} response{asstMsgs.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Preview — only when collapsed */}
          {!isExpanded && (
            <p className="mt-2 text-xs text-surface-500 line-clamp-2 leading-relaxed">
              {preview.length > 160 ? preview.slice(0, 160) + '…' : preview}
            </p>
          )}
        </div>
      </div>

      {/* Expanded thread */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-surface-800 px-4 py-4 space-y-3 max-h-[520px] overflow-y-auto">
              {conv.messages.filter(m => m.role !== 'system').map(msg => (
                <div
                  key={msg.id}
                  className={cn(
                    'flex gap-2.5',
                    msg.role === 'user' ? 'flex-row-reverse' : 'flex-row',
                  )}
                >
                  {/* Avatar */}
                  <div className={cn(
                    'w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5',
                    msg.role === 'user' ? 'bg-surface-700' : 'bg-gradient-to-br from-brand-500 to-purple-600',
                  )}>
                    {msg.role === 'user'
                      ? <User className="w-3 h-3 text-surface-300" />
                      : <Bot className="w-3 h-3 text-white" />}
                  </div>

                  {/* Bubble */}
                  <div className={cn(
                    'max-w-[82%] rounded-xl px-3 py-2.5',
                    msg.role === 'user'
                      ? 'bg-brand-500/10 border border-brand-500/20 text-xs text-surface-200'
                      : 'bg-surface-800 border border-surface-700',
                  )}>
                    {msg.role === 'user'
                      ? <p className="text-xs text-surface-200 leading-relaxed">{msg.content}</p>
                      : msg.content
                        ? <MiniMarkdown content={msg.content} />
                        : <p className="text-xs text-surface-600 italic">No response</p>}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer CTA */}
            <div className="px-4 py-3 border-t border-surface-800 flex items-center justify-between">
              <p className="text-2xs text-surface-600">{absTime(conv.ts)}</p>
              <Link
                href={`/dashboard/ai-copilot?conv=${conv.id}`}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 rounded-xl text-xs text-brand-400 font-medium transition-all"
              >
                <ExternalLink className="w-3 h-3" /> Continue in Copilot
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ── Page ──────────────────────────────────────────────────────
export default function AIHistoryPage() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [search, setSearch]               = useState('')
  const [modeFilter, setModeFilter]       = useState<string | null>(null)
  const [expanded, setExpanded]           = useState<string | null>(null)
  const [deleting, setDeleting]           = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/ai/chat/history')
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => setConversations(d.conversations ?? []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    setDeleting(id)
    const updated = conversations.filter(c => c.id !== id)
    try {
      await fetch('/api/ai/chat/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversations: updated }),
      })
      setConversations(updated)
      if (expanded === id) setExpanded(null)
    } catch { /* ignore */ }
    setDeleting(null)
  }, [conversations, expanded])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return conversations
      .filter(c => !modeFilter || c.mode === modeFilter)
      .filter(c => !q ||
        c.title.toLowerCase().includes(q) ||
        c.messages.some(m => m.content.toLowerCase().includes(q)),
      )
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
  }, [conversations, modeFilter, search])

  // Stats
  const totalMessages = conversations.reduce((s, c) => s + c.messages.filter(m => m.role === 'user').length, 0)
  const modeCount = Object.fromEntries(
    Object.keys(MODES).map(k => [k, conversations.filter(c => (c.mode ?? 'chat') === k).length]),
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-surface-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/ai-copilot"
            className="p-1.5 rounded-xl border border-surface-700 text-surface-400 hover:text-white hover:border-surface-500 transition-all"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <History className="w-5 h-5 text-brand-400" /> Conversation History
            </h1>
            <p className="text-xs text-surface-500 mt-0.5">
              {conversations.length} conversation{conversations.length !== 1 ? 's' : ''} · {totalMessages} question{totalMessages !== 1 ? 's' : ''} asked
            </p>
          </div>
        </div>

        <Link
          href="/dashboard/ai-copilot"
          className="flex items-center gap-2 px-3 py-1.5 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 rounded-xl text-sm text-brand-400 font-medium transition-all"
        >
          <Bot className="w-4 h-4" /> Open Copilot
        </Link>
      </div>

      {/* Stats strip */}
      {conversations.length > 0 && (
        <div className="flex gap-3 px-6 py-3 border-b border-surface-800 overflow-x-auto scrollbar-none flex-shrink-0">
          {Object.entries(MODES).map(([key, m]) => {
            const Icon = m.icon
            const count = modeCount[key] ?? 0
            if (count === 0) return null
            return (
              <button
                key={key}
                onClick={() => setModeFilter(modeFilter === key ? null : key)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium flex-shrink-0 transition-all',
                  modeFilter === key
                    ? cn(m.bg, m.border, m.color)
                    : 'bg-surface-900 border-surface-800 text-surface-500 hover:border-surface-700 hover:text-surface-300',
                )}
              >
                <Icon className="w-3 h-3" />
                {m.label}
                <span className={cn(
                  'ml-0.5 text-2xs px-1.5 py-0.5 rounded-full',
                  modeFilter === key ? 'bg-white/10' : 'bg-surface-800',
                )}>{count}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Toolbar */}
      <div className="px-6 py-3 border-b border-surface-800 flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search conversations and messages…"
            className="w-full max-w-md bg-surface-800 border border-surface-700 rounded-xl pl-9 pr-3 py-2 text-sm text-white placeholder-surface-500 outline-none focus:border-brand-500 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300">
              <span className="text-xs">✕</span>
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && (
          <div className="flex items-center justify-center py-20 gap-2 text-surface-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading history…</span>
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center gap-2 text-sm text-danger bg-danger/5 border border-danger/20 rounded-xl px-4 py-3">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
          </div>
        )}

        {!loading && !error && conversations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500/20 to-purple-600/20 border border-brand-500/20 flex items-center justify-center mb-4">
              <History className="w-7 h-7 text-brand-400" />
            </div>
            <p className="text-sm font-semibold text-white mb-1">No conversations yet</p>
            <p className="text-xs text-surface-500 mb-4">Start chatting with VynOps AI to build your history.</p>
            <Link href="/dashboard/ai-copilot"
              className="flex items-center gap-2 px-4 py-2 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 rounded-xl text-sm text-brand-400 font-medium transition-all">
              <Bot className="w-4 h-4" /> Start a conversation
            </Link>
          </div>
        )}

        {!loading && !error && conversations.length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Search className="w-8 h-8 text-surface-600 mb-3" />
            <p className="text-sm text-surface-400">No conversations match your search.</p>
            <button onClick={() => { setSearch(''); setModeFilter(null) }} className="mt-2 text-xs text-brand-400 hover:underline">
              Clear filters
            </button>
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <>
            {/* Result count when filtering */}
            {(search || modeFilter) && (
              <p className="text-2xs text-surface-500 mb-3">
                {filtered.length} result{filtered.length !== 1 ? 's' : ''}
                {modeFilter && <> in <span className="text-surface-300">{MODES[modeFilter]?.label}</span></>}
                {search && <> matching <span className="text-surface-300">"{search}"</span></>}
                <button onClick={() => { setSearch(''); setModeFilter(null) }} className="ml-2 text-brand-400 hover:underline">Clear</button>
              </p>
            )}

            <motion.div layout className="space-y-3">
              <AnimatePresence mode="popLayout">
                {filtered.map(conv => (
                  <ConvCard
                    key={conv.id}
                    conv={conv}
                    isExpanded={expanded === conv.id}
                    isDeleting={deleting === conv.id}
                    onToggle={() => setExpanded(e => e === conv.id ? null : conv.id)}
                    onDelete={() => handleDelete(conv.id)}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          </>
        )}
      </div>
    </div>
  )
}
