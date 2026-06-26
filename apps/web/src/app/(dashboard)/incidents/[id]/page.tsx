'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronLeft, Siren, RefreshCw, AlertTriangle, CheckCircle2,
  Clock, ExternalLink, Users, Zap, Activity, ShieldAlert, Timer,
  MessageSquare, Send, ChevronDown, UserCheck, Loader2, Radio, Info,
  Tag, X, Check, AlertCircle,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'
import { getClusterHeaders, useDashboardStore } from '@/store'

type AlertDoc = {
  id: string; name: string; severity: string; state: string
  summary: string; labels: Record<string, string>; startsAt: string
  source: string; affectedServices: string[]
}
type TimelineEvent = {
  id: string; ts: string; type: string; title: string; description: string
  severity?: string; actor?: string
}
type IncidentDoc = {
  id: string; title: string; description: string; severity: string; state: string
  owner: string; team: string; service: string; environment: string
  labels: Record<string, string>; createdAt: string; updatedAt: string
  resolvedAt?: string; slaDeadline: string; slaBreached: boolean
  alertCount: number; alerts: AlertDoc[]; timeline: TimelineEvent[]
  blastRadius: { affectedServices: string[]; affectedUsers: number; affectedRegions: string[]; slaBreached: boolean; dependentServices: string[] }
  runbookUrls: string[]; linkedDeployments: string[]; source: 'auto' | 'manual'; durationMinutes: number
  escalationLevel: number
}

const SEV_BADGE: Record<string, string> = {
  critical: 'text-danger  border-danger/30  bg-danger/10',
  high:     'text-warning border-warning/30 bg-warning/10',
  medium:   'text-blue-400 border-blue-400/30 bg-blue-400/10',
  low:      'text-surface-400 border-surface-600 bg-surface-800',
}
const SEV_BAR: Record<string, string> = { critical: 'bg-danger', high: 'bg-warning', medium: 'bg-blue-400', low: 'bg-surface-500' }
const STATE_COLORS: Record<string, string> = {
  open: 'text-danger bg-danger/10 border-danger/20', investigating: 'text-warning bg-warning/10 border-warning/20',
  identified: 'text-blue-400 bg-blue-400/10 border-blue-400/20', monitoring: 'text-brand-400 bg-brand-400/10 border-brand-400/20',
  resolved: 'text-success bg-success/10 border-success/20',
}
const TL_ICONS: Record<string, React.ReactNode> = {
  alert: <AlertTriangle className="w-3.5 h-3.5 text-warning" />, ai_insight: <Zap className="w-3.5 h-3.5 text-brand-400" />,
  deployment: <Activity className="w-3.5 h-3.5 text-blue-400" />, user_action: <UserCheck className="w-3.5 h-3.5 text-surface-400" />,
  escalation: <ShieldAlert className="w-3.5 h-3.5 text-danger" />, resolution: <CheckCircle2 className="w-3.5 h-3.5 text-success" />,
}
const STATES = ['open', 'investigating', 'identified', 'monitoring', 'resolved'] as const

function fmtDuration(m: number) { return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m/60)}h ${m%60}m` : `${Math.floor(m/1440)}d ${Math.floor((m%1440)/60)}h` }

function SlaTag({ deadline, breached }: { deadline: string; breached: boolean }) {
  const ml = Math.round((new Date(deadline).getTime() - Date.now()) / 60000)
  if (breached)    return <span className="text-xs px-2 py-0.5 rounded font-semibold text-white bg-danger">SLA BREACHED</span>
  if (ml < 30)     return <span className="text-xs px-2 py-0.5 rounded font-semibold text-warning bg-warning/10 border border-warning/30">{ml}m left</span>
  return                  <span className="text-xs px-2 py-0.5 rounded font-semibold text-success bg-success/10 border border-success/20">SLA OK</span>
}

export default function IncidentDetailPage() {
  const params  = useParams()
  const id      = Array.isArray(params.id) ? params.id[0]! : (params.id as string)
  const { activeCluster, user } = useDashboardStore()
  const [inc,       setInc]       = useState<IncidentDoc | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [saving,    setSaving]    = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [stateOpen, setStateOpen] = useState(false)
  const [assOpen,   setAssOpen]   = useState(false)
  const [assVal,    setAssVal]    = useState('')
  const [assMembers, setAssMembers] = useState<{ id: string; name: string; email: string; isOnCall?: boolean }[]>([])
  const [noteOpen,  setNoteOpen]  = useState(false)
  const [noteTitle, setNoteTitle] = useState('Update')
  const [noteText,  setNoteText]  = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/incidents/${encodeURIComponent(id)}`, {
        cache: 'no-store',
        headers: getClusterHeaders(),
      })
      if (!r.ok) { const b = await r.json().catch(() => ({})); setError((b as any).error ?? 'Not found') }
      else { const d: IncidentDoc = await r.json(); setInc(d); setAssVal(d.owner); setError(null) }
    } catch (e) { setError(String(e)) }
    finally   { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!inc || inc.state === 'resolved') return
    const t = setInterval(load, 30_000); return () => clearInterval(t)
  }, [inc?.state, load])

  // Re-check exhaustion whenever escalationLevel changes (survives page reloads)
  useEffect(() => {
    if (!inc || (inc.escalationLevel ?? 0) === 0) return
    fetch('/api/settings/oncall/escalate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentLevel: inc.escalationLevel, checkOnly: true }),
    }).then(r => r.json()).then(j => { if (j.exhausted) setEscExhausted(true) }).catch(() => {})
  }, [inc?.escalationLevel])

  const patch = useCallback(async (body: Record<string, unknown>) => {
    if (!inc) return; setSaving(true); setSaveError(null)
    try {
      const r = await fetch(`/api/incidents/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...getClusterHeaders() },
        body: JSON.stringify({ ...body, actor: user?.name ?? 'operator' }),
      })
      if (r.ok) setInc(await r.json())
      else { const d = await r.json().catch(() => ({})); setSaveError((d as any).error ?? `Error ${r.status}`) }
    } catch (e) { setSaveError(String(e)) }
    finally { setSaving(false) }
  }, [id, inc, user?.name])

  const changeState = (s: string) => { patch({ state: s }); setStateOpen(false) }
  const assign = () => { if (assVal.trim()) { patch({ owner: assVal.trim() }); setAssOpen(false) } }

  const openAssign = useCallback(async () => {
    setAssOpen(o => !o); setStateOpen(false)
    if (assMembers.length > 0) return
    try {
      const r = await fetch('/api/settings/oncall')
      const j = await r.json()
      const schedules: any[] = j.schedules ?? []
      const seen = new Set<string>()
      const members: { id: string; name: string; email: string; isOnCall?: boolean }[] = []
      for (const s of schedules) {
        const onCallId = s.currentOnCall?.id
        for (const m of s.members ?? []) {
          if (seen.has(m.id)) continue
          seen.add(m.id)
          members.push({ ...m, isOnCall: m.id === onCallId })
        }
      }
      // sort: on-call first
      members.sort((a, b) => (b.isOnCall ? 1 : 0) - (a.isOnCall ? 1 : 0))
      setAssMembers(members)
    } catch { /* ignore */ }
  }, [assMembers.length])

  // ── Escalation ─────────────────────────────────────────────
  const [escalating,    setEscalating]    = useState(false)
  const [escContact,    setEscContact]    = useState<{ name: string; email: string; levelDesc: string; nextLevel: number; hasMore: boolean; slackSent: boolean } | null>(null)
  const [escExhausted,  setEscExhausted]  = useState(false)
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const escalate = useCallback(async () => {
    if (!inc || escalating) return
    setEscalating(true)
    try {
      // 1. Get next escalation contact + send Slack
      const er = await fetch('/api/settings/oncall/escalate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentLevel:   inc.escalationLevel ?? 0,
          incidentId:     inc.id,
          incidentTitle:  inc.title,
          severity:       inc.severity,
          service:        inc.service,
          url:            `${window.location.origin}/incidents/${inc.id}`,
        }),
      })
      const ej = await er.json()

      if (ej.exhausted) {
        setEscExhausted(true)
        return
      }

      const { nextLevel, contact, levelDesc, hasMore, slackSent } = ej
      const desc = `Notified ${contact.name} (${contact.email}) via Slack — ${levelDesc}`

      // 2. Advance state to 'investigating' if still open, else keep current
      const newState = (inc.state === 'open') ? 'investigating' : inc.state

      // 3. PATCH incident with escalationLevel + state + timeline entry
      await patch({
        escalationLevel: nextLevel,
        escalationDesc:  desc,
        state:           newState,
        actor:           'operator',
      })

      setEscContact({ name: contact.name, email: contact.email, levelDesc, nextLevel, hasMore, slackSent: !!slackSent })
      // Auto-clear the toast after 6s
      if (escTimerRef.current) clearTimeout(escTimerRef.current)
      escTimerRef.current = setTimeout(() => setEscContact(null), 6000)
    } finally { setEscalating(false) }
  }, [inc, escalating, patch])

  useEffect(() => () => { if (escTimerRef.current) clearTimeout(escTimerRef.current) }, [])

  const postNote = async () => {
    if (!noteText.trim()) return
    await patch({ note: noteText.trim(), noteTitle: noteTitle || 'Update' })
    setNoteText(''); setNoteTitle('Update'); setNoteOpen(false)
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-brand-400" /></div>
  if (error || !inc) return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <Siren className="w-12 h-12 text-surface-700" />
      <p className="text-surface-400 text-sm">{error ?? 'Incident not found'}</p>
      <Link href="/incidents" className="text-brand-400 hover:text-brand-300 text-xs flex items-center gap-1"><ChevronLeft className="w-4 h-4" /> Incidents</Link>
    </div>
  )

  const timeline = [...inc.timeline].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-surface-800 flex-shrink-0">
        <Link href="/incidents" className="flex items-center gap-1 text-surface-500 hover:text-white text-xs transition-colors flex-shrink-0">
          <ChevronLeft className="w-3.5 h-3.5" /> Incidents
        </Link>
        <span className="w-px h-4 bg-surface-700" />
        <span className="text-xs font-mono text-surface-500">{inc.id}</span>
        <span className={cn('text-xs px-2 py-0.5 rounded border capitalize font-medium flex-shrink-0', SEV_BADGE[inc.severity])}>{inc.severity}</span>
        <span className={cn('text-xs px-2 py-0.5 rounded border capitalize font-medium flex-shrink-0', STATE_COLORS[inc.state])}>{inc.state}</span>
        <h1 className="text-sm font-bold text-white truncate flex-1 min-w-0">{inc.title}</h1>
        <div className="flex items-center gap-2 flex-shrink-0">
          <SlaTag deadline={inc.slaDeadline} breached={inc.slaBreached} />
          {inc.state !== 'resolved' && <span className="flex items-center gap-1 text-2xs text-success"><Radio className="w-3 h-3 animate-pulse" /> Live</span>}
          <button onClick={load} disabled={saving} className="p-1.5 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-white transition-all">
            <RefreshCw className={cn('w-3.5 h-3.5', saving && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-surface-800 bg-surface-900/50 flex-shrink-0 flex-wrap">
        <div className="relative">
          <button onClick={() => { setStateOpen(o => !o); setAssOpen(false) }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-white transition-all">
            Status: <span className="font-semibold capitalize ml-0.5">{inc.state}</span><ChevronDown className="w-3 h-3 text-surface-500 ml-0.5" />
          </button>
          <AnimatePresence>
            {stateOpen && (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                className="absolute top-full left-0 mt-1 bg-surface-800 border border-surface-700 rounded-xl overflow-hidden shadow-xl z-30 min-w-[160px]">
                {STATES.map(s => (
                  <button key={s} onClick={() => changeState(s)} disabled={s === inc.state}
                    className={cn('w-full text-left px-4 py-2 text-xs capitalize hover:bg-surface-700 transition-colors', s === inc.state ? 'text-surface-500' : 'text-white')}>{s}</button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="relative">
          <button onClick={openAssign}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-xl text-xs text-white transition-all">
            <Users className="w-3.5 h-3.5 text-surface-500" />
            {inc.owner === 'Unassigned' ? 'Assign' : inc.owner}
          </button>
          <AnimatePresence>
            {assOpen && (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                className="absolute top-full left-0 mt-1 bg-surface-800 border border-surface-700 rounded-xl shadow-xl z-30 min-w-[260px] overflow-hidden">
                {/* On-call & team members */}
                {assMembers.length > 0 && (
                  <div className="p-2 border-b border-surface-700 space-y-0.5">
                    {assMembers.map(m => (
                      <button key={m.id} onClick={() => { patch({ owner: m.name }); setAssOpen(false) }}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors text-left',
                          m.name === inc.owner ? 'bg-brand-500/20 text-brand-400' : 'hover:bg-surface-700 text-white',
                        )}>
                        <span className={cn(
                          'w-6 h-6 rounded-full flex items-center justify-center text-2xs font-bold flex-shrink-0',
                          m.isOnCall ? 'bg-success/20 text-success' : 'bg-surface-600 text-surface-300',
                        )}>
                          {m.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="font-medium">{m.name}</span>
                          {m.isOnCall && <span className="ml-1.5 text-2xs text-success font-semibold">● On-call</span>}
                          <span className="block text-2xs text-surface-500 truncate">{m.email}</span>
                        </span>
                        {m.name === inc.owner && <CheckCircle2 className="w-3.5 h-3.5 text-brand-400 flex-shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
                {/* Free-text input */}
                <div className="p-2 flex gap-2">
                  <input value={assVal} onChange={e => setAssVal(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && assign()}
                    placeholder="Other name or email…"
                    className="flex-1 bg-surface-700 border border-surface-600 rounded-lg px-2 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500" />
                  <button onClick={assign} disabled={!assVal.trim()}
                    className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-lg text-xs font-medium text-white transition-all">
                    Assign
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <button onClick={() => { setNoteOpen(o => !o); setStateOpen(false); setAssOpen(false) }}
          className={cn('flex items-center gap-1.5 px-3 py-1.5 border rounded-xl text-xs transition-all',
            noteOpen ? 'bg-brand-500/10 text-brand-400 border-brand-500/30' : 'bg-surface-800 hover:bg-surface-700 border-surface-700 text-white')}>
          <MessageSquare className="w-3.5 h-3.5" /> Add Note
        </button>

        {/* Escalate button */}
        <div className="relative">
          <button onClick={escalate}
            disabled={inc.state === 'resolved' || escExhausted || escalating}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 border rounded-xl text-xs transition-all',
              escExhausted
                ? 'bg-surface-800 border-surface-700 text-surface-500 cursor-not-allowed'
                : 'bg-warning/10 hover:bg-warning/20 border-warning/30 text-warning disabled:opacity-40',
            )}>
            {escalating
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <ShieldAlert className="w-3.5 h-3.5" />}
            {escExhausted ? 'All contacts notified' : `Escalate${(inc.escalationLevel ?? 0) > 0 ? ` · L${(inc.escalationLevel ?? 0) + 1}` : ''}`}
          </button>
          {/* Escalation toast */}
          <AnimatePresence>
            {escContact && (
              <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                className="absolute top-full left-0 mt-2 z-40 bg-surface-800 border border-warning/30 rounded-xl shadow-xl p-3 min-w-[260px]">
                <div className="flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-white">Escalated to L{escContact.nextLevel}</p>
                    <p className="text-2xs text-surface-400 mt-0.5">{escContact.levelDesc}</p>
                    <p className="text-2xs text-warning mt-1 font-medium">{escContact.name}</p>
                    <p className="text-2xs text-surface-500">{escContact.email}</p>
                    <p className={cn('text-2xs mt-1.5 flex items-center gap-1 font-medium', escContact.slackSent ? 'text-green-400' : 'text-danger')}>
                      {escContact.slackSent
                        ? <><Check className="w-3 h-3" /> Slack message sent</>  
                        : <><AlertCircle className="w-3 h-3" /> Slack not configured — notify manually</>}
                    </p>
                    {escContact.hasMore && <p className="text-2xs text-surface-600 mt-1">Further escalation available</p>}
                  </div>
                  <button onClick={() => setEscContact(null)} className="ml-auto text-surface-600 hover:text-white">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {saveError && (
            <span className="text-2xs text-danger bg-danger/10 border border-danger/20 rounded-lg px-2 py-1 max-w-xs truncate" title={saveError}>{saveError}</span>
          )}
          {inc.state !== 'resolved' && (
            <button onClick={() => changeState('resolved')}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-success hover:bg-success/90 rounded-xl text-xs font-semibold text-white transition-all">
              <CheckCircle2 className="w-3.5 h-3.5" /> Resolve
            </button>
          )}
        </div>
      </div>

      {/* Note form */}
      <AnimatePresence>
        {noteOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="border-b border-surface-800 bg-surface-900 overflow-hidden flex-shrink-0">
            <div className="px-6 py-3 flex items-start gap-3">
              <div className="flex flex-col gap-1.5 flex-shrink-0 w-36">
                <label className="text-2xs text-surface-500 uppercase tracking-wider">Title</label>
                <input value={noteTitle} onChange={e => setNoteTitle(e.target.value)} placeholder="e.g. Root cause found"
                  className="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500" />
              </div>
              <div className="flex flex-col gap-1.5 flex-1">
                <label className="text-2xs text-surface-500 uppercase tracking-wider">Note</label>
                <textarea value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="What happened? Actions taken? ETA?" rows={2}
                  className="w-full bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none focus:border-brand-500 resize-none" />
              </div>
              <div className="flex flex-col gap-1.5 flex-shrink-0 mt-5">
                <button onClick={postNote} disabled={!noteText.trim()}
                  className="flex items-center gap-1 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-xl text-xs font-medium text-white transition-all">
                  <Send className="w-3 h-3" /> Post
                </button>
                <button onClick={() => setNoteOpen(false)} className="px-3 py-1.5 bg-surface-800 border border-surface-700 rounded-xl text-xs text-surface-500 hover:text-white text-center">Cancel</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex">
        {/* Main */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-w-0">
          {inc.description && (
            <div className="rounded-xl bg-surface-900 border border-surface-800 p-4">
              <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-2 flex items-center gap-1.5"><Info className="w-3.5 h-3.5" /> Description</p>
              <p className="text-sm text-surface-300 leading-relaxed">{inc.description}</p>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Duration',      value: fmtDuration(inc.durationMinutes), danger: false, icon: <Timer className="w-4 h-4 text-brand-400" /> },
              { label: 'Active Alerts', value: String(inc.alertCount),           danger: false, icon: <AlertTriangle className="w-4 h-4 text-warning" /> },
              { label: 'Svcs Affected', value: String(inc.blastRadius.affectedServices.length), danger: false, icon: <Activity className="w-4 h-4 text-blue-400" /> },
              { label: 'SLA', value: inc.slaBreached ? 'Breached' : 'Within SLA', danger: inc.slaBreached,
                icon: <ShieldAlert className={cn('w-4 h-4', inc.slaBreached ? 'text-danger' : 'text-success')} /> },
            ].map(s => (
              <div key={s.label} className="rounded-xl bg-surface-900 border border-surface-800 p-3 flex items-center gap-3">
                {s.icon}
                <div>
                  <p className="text-2xs text-surface-500">{s.label}</p>
                  <p className={cn('text-sm font-bold', s.danger ? 'text-danger' : 'text-white')}>{s.value}</p>
                </div>
              </div>
            ))}
          </div>
          {inc.alerts.length > 0 && (
            <div className="rounded-xl bg-surface-900 border border-surface-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-warning" />
                <span className="text-xs font-semibold text-white">Active Alerts</span>
                <span className="text-2xs text-surface-500">{inc.alerts.length} firing</span>
              </div>
              <div className="divide-y divide-surface-800/50">
                {inc.alerts.map(a => (
                  <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                    <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0', SEV_BAR[a.severity] ?? 'bg-surface-500')} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">{a.name}</p>
                      <div className="flex flex-wrap gap-x-3 mt-0.5">
                        {a.labels.namespace && <span className="text-2xs text-surface-500 font-mono">ns:{a.labels.namespace}</span>}
                        {a.labels.job       && <span className="text-2xs text-surface-500 font-mono">job:{a.labels.job}</span>}
                      </div>
                      <p className="text-2xs text-surface-600 mt-1" suppressHydrationWarning>Firing {formatDistanceToNow(new Date(a.startsAt))}</p>
                    </div>
                    <span className={cn('text-2xs px-1.5 py-0.5 rounded border flex-shrink-0 capitalize font-medium', SEV_BADGE[a.severity])}>{a.severity}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="rounded-xl bg-surface-900 border border-surface-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-surface-800 flex items-center gap-2">
              <Clock className="w-4 h-4 text-brand-400" />
              <span className="text-xs font-semibold text-white">Timeline</span>
              <span className="text-2xs text-surface-500">{timeline.length} events · newest first</span>
            </div>
            <div className="p-5">
              <div className="relative">
                <div className="absolute left-3 top-0 bottom-0 w-px bg-surface-800" />
                <div className="space-y-5">
                  {timeline.map(ev => (
                    <div key={ev.id} className="flex gap-4 relative">
                      <div className="w-6 h-6 rounded-full bg-surface-800 border border-surface-700 flex items-center justify-center flex-shrink-0 z-10">
                        {TL_ICONS[ev.type] ?? <Activity className="w-3 h-3 text-surface-400" />}
                      </div>
                      <div className="flex-1 min-w-0 pb-1 pt-0.5">
                        <p className="text-sm font-semibold text-white flex items-center gap-2">
                          {ev.title}
                          {ev.actor === 'system' && (
                            <span className="text-2xs font-medium px-1.5 py-0.5 rounded bg-brand-500/15 text-brand-400 border border-brand-500/20">auto</span>
                          )}
                        </p>
                        <p className="text-xs text-surface-400 mt-0.5 leading-relaxed">{ev.description}</p>
                        <div className="flex items-center gap-3 mt-1.5">
                          {ev.actor && ev.actor !== 'system' && <span className="text-2xs text-surface-600 flex items-center gap-1"><UserCheck className="w-3 h-3" />{ev.actor}</span>}
                          <span className="text-2xs text-surface-700" suppressHydrationWarning>{formatDistanceToNow(new Date(ev.ts), { addSuffix: true })}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-72 flex-shrink-0 border-l border-surface-800 overflow-y-auto px-4 py-4 space-y-4">
          <div className="rounded-xl bg-surface-900 border border-surface-800 p-4 space-y-2.5">
            <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider">Details</p>
            {[
              { label: 'Service',     value: inc.service },
              { label: 'Owner',       value: inc.owner },
              { label: 'Team',        value: inc.team },
              { label: 'Environment', value: inc.environment },
              { label: 'Source',      value: inc.source },
              { label: 'Created',     value: new Date(inc.createdAt).toLocaleString() },
              { label: 'Updated',     value: new Date(inc.updatedAt).toLocaleString() },
              ...(inc.resolvedAt ? [{ label: 'Resolved', value: new Date(inc.resolvedAt).toLocaleString() }] : []),
              { label: 'SLA Deadline',value: new Date(inc.slaDeadline).toLocaleString() },
            ].map(m => (
              <div key={m.label} className="flex items-start justify-between gap-2 text-xs">
                <span className="text-surface-500 flex-shrink-0">{m.label}</span>
                <span className="text-white font-medium text-right break-all">{m.value}</span>
              </div>
            ))}
          </div>
          {Object.keys(inc.labels).length > 0 && (
            <div className="rounded-xl bg-surface-900 border border-surface-800 p-4">
              <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Tag className="w-3.5 h-3.5" /> Labels</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(inc.labels).map(([k, v]) => (
                  <span key={k} className="text-2xs px-2 py-0.5 rounded-full bg-surface-800 border border-surface-700 font-mono">
                    <span className="text-brand-400">{k}</span>=<span className="text-surface-300">{v}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {inc.blastRadius.affectedServices.length > 0 && (
            <div className="rounded-xl bg-surface-900 border border-surface-800 p-4">
              <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-3 flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5 text-danger" /> Blast Radius</p>
              <div className="flex flex-wrap gap-1.5">
                {inc.blastRadius.affectedServices.map(s => (
                  <span key={s} className="text-2xs px-2 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/20">{s}</span>
                ))}
              </div>
            </div>
          )}
          {inc.runbookUrls.length > 0 && (
            <div className="rounded-xl bg-surface-900 border border-surface-800 p-4">
              <p className="text-2xs font-semibold text-surface-400 uppercase tracking-wider mb-3">Runbooks</p>
              <div className="space-y-2">
                {inc.runbookUrls.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300 transition-colors">
                    <ExternalLink className="w-3 h-3 flex-shrink-0" /><span className="truncate">{url.split('/').pop() ?? url}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
