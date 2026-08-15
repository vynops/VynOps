'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Bell, ChevronDown, Activity, WifiOff,
  Command, LogOut, User, Menu,
} from 'lucide-react'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useDashboardStore } from '@/store'
import { cn } from '@/lib/utils'
import { ROLE_COLORS, ROLE_LABELS, type Role } from '@/lib/roles'
import type { K8sCluster } from '@/types'

const TIME_RANGES = ['15m', '30m', '1h', '3h', '6h', '12h', '24h', '7d', '30d'] as const

export default function TopHeader() {
  const {
    activeCluster, setActiveCluster, clusters, setClusters,
    timeRange, setTimeRange,
    openCommandPalette,
    alerts, incidents,
    isRealtimeActive, toggleRealtime,
    toggleMobileNav,
    setClusterStatus,
  } = useDashboardStore()

  const { data: session } = useSession()
  // Fall back to store user if session not yet loaded
  const authUser = session?.user
  const [profileName, setProfileName] = useState<string | null>(null)
  const [profileEmail, setProfileEmail] = useState<string | null>(null)

  useEffect(() => {
    if (!authUser?.email) return
    const read = () => {
      try {
        const p = JSON.parse(localStorage.getItem('user_profile') ?? '{}')
        // Only use stored name/email if they belong to the current logged-in user
        const sameUser = !p.email || p.email === authUser.email

        // Auto-heal stale old admin name persisted in localStorage.
        const migratedName = (p.name === 'Alex Kumar' && authUser.name === 'Alex Karev') ? 'Alex Karev' : p.name
        if (sameUser && migratedName !== p.name) {
          localStorage.setItem('user_profile', JSON.stringify({ ...p, name: migratedName }))
        }

        setProfileName(sameUser ? (migratedName ?? null) : null)
        setProfileEmail(sameUser ? (p.email ?? null) : null)
      } catch {}
    }
    read()
    window.addEventListener('storage', read)
    return () => window.removeEventListener('storage', read)
  }, [authUser?.email])

  const displayName   = profileName  ?? authUser?.name  ?? ''
  const displayEmail  = profileEmail ?? authUser?.email ?? ''
  const displayRole   = (authUser as { role?: Role } | undefined)?.role ?? 'admin'
  const displayAvatar = displayName.split(' ').filter(Boolean).map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()

  const router = useRouter()
  const [clusterOpen, setClusterOpen] = useState(false)
  const [timeOpen, setTimeOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)

  // Sync persisted timeRange / realtimeActive from localStorage after hydration.
  // readTimeRange() in the store runs at module-eval time (server-side = no window),
  // so the initial store value is always '1h'. This effect corrects it on the client.
  useEffect(() => {
    try {
      const VALID = ['15m','30m','1h','3h','6h','12h','24h','7d','30d']
      const saved = localStorage.getItem('timeRange')
      if (saved && VALID.includes(saved) && saved !== timeRange) setTimeRange(saved as typeof TIME_RANGES[number])
      const savedLive = localStorage.getItem('realtimeActive')
      if (savedLive !== null && (savedLive === 'true') !== isRealtimeActive) toggleRealtime()
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally run once on mount only

  // Close all dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('[data-dropdown]')) {
        setClusterOpen(false); setTimeOpen(false)
        setNotifOpen(false);   setUserOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])


  // Load clusters from settings; auto-seed from the default K8s connection on first run
  useEffect(() => {
    fetch('/api/settings/clusters')
      .then(r => r.json())
      .then(async (saved: K8sCluster[]) => {
        if (saved.length > 0) {
          setClusters(saved)
          const savedId = (() => { try { return localStorage.getItem('activeClusterId') } catch { return null } })()
          const preferred = savedId ? saved.find(c => c.id === savedId) : null
          // Always refresh activeCluster from the latest API data (stale store data
          // would have empty service URLs and cause false "not configured" states)
          setActiveCluster(preferred ?? saved[0])
          return
        }
        // No clusters persisted yet — discover from K8S_API_URL and save
        const live = await fetch('/api/k8s/cluster').then(r => r.json()).catch(() => null)
        if (!live?.name || !live?.k8sUrl) return
        const seeded: K8sCluster = await fetch('/api/settings/clusters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: live.name, k8sUrl: live.k8sUrl }),
        }).then(r => r.json()).catch(() => null)
        if (seeded?.id) {
          setClusters([seeded])
          setActiveCluster(seeded)
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Probe active cluster connectivity every 30s
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      const state = useDashboardStore.getState()
      if (!state.activeCluster) {
        setClusterStatus(state.clusters.length === 0 ? 'unconfigured' : 'unconfigured')
        return
      }
      const headers: Record<string, string> = {
        'X-K8s-Url': state.activeCluster.k8sUrl || 'none',
      }
      try {
        const r = await fetch('/api/settings/probe', { headers })
        if (cancelled) return
        if (!r.ok) { setClusterStatus('unreachable'); return }
        const data = await r.json()
        const k8sOk = data?.k8s?.ok === true
        setClusterStatus(k8sOk ? 'connected' : (data?.k8s?.error === 'Not configured' ? 'unconfigured' : 'unreachable'))
      } catch {
        if (!cancelled) setClusterStatus('unreachable')
      }
    }
    probe()
    const id = setInterval(probe, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCluster?.id])

  const criticalAlerts = alerts.filter(a => a.severity === 'critical' && a.state === 'firing').length
  const openIncidents = incidents.filter(i => i.state !== 'resolved').length

  const statusColors: Record<string, string> = {
    healthy: 'bg-success',
    degraded: 'bg-warning',
    critical: 'bg-danger',
    unknown: 'bg-surface-500',
  }

  return (
    <header className="h-14 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 bg-surface-950/90 backdrop-blur-sm border-b border-surface-800 flex-shrink-0 z-30">
      {/* Mobile hamburger */}
      <button
        onClick={toggleMobileNav}
        className="sm:hidden flex items-center justify-center w-8 h-8 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-white transition-all flex-shrink-0"
      >
        <Menu className="w-4 h-4" />
      </button>

      {/* Global search */}
      <button
        onClick={openCommandPalette}
        className="flex items-center gap-2 flex-1 max-w-xs sm:max-w-sm bg-surface-800/60 hover:bg-surface-800 border border-surface-700/60 rounded-xl px-3 py-1.5 text-sm text-surface-400 hover:text-surface-300 transition-all group"
      >
        <Search className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="flex-1 text-left truncate hidden xs:block sm:block">Search infrastructure, incidents, pods...</span>
        <kbd className="hidden sm:flex items-center gap-0.5 px-1.5 py-0.5 bg-surface-700 rounded text-2xs text-surface-400 border border-surface-600 group-hover:border-surface-500">
          <Command className="w-2.5 h-2.5" /><span>K</span>
        </kbd>
      </button>

      <div className="flex items-center gap-2 ml-auto">

        {/* Realtime indicator */}
        <button
          onClick={toggleRealtime}
          className={cn(
            'hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all',
            isRealtimeActive
              ? 'bg-success/10 text-success border-success/30 hover:bg-success/20'
              : 'bg-surface-800 text-surface-400 border-surface-700 hover:bg-surface-700',
          )}
        >
          {isRealtimeActive ? (
            <>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
              </span>
              Live
            </>
          ) : (
            <>
              <WifiOff className="w-3 h-3" />
              Paused
            </>
          )}
        </button>

        {/* Time range selector */}
        <div className="relative hidden sm:block" data-dropdown>
          <button
            onClick={() => setTimeOpen(o => !o)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-lg text-sm text-surface-300 transition-all"
            suppressHydrationWarning
          >
            <Activity className="w-3.5 h-3.5 text-brand-400" />
            <span suppressHydrationWarning>{timeRange}</span>
            <ChevronDown className="w-3 h-3 text-surface-500" />
          </button>
          <AnimatePresence>
            {timeOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute top-full mt-1 right-0 bg-surface-900 border border-surface-700 rounded-xl p-1 shadow-xl z-50 min-w-[100px]"
              >
                {TIME_RANGES.map(r => (
                  <button
                    key={r}
                    onClick={() => { setTimeRange(r); setTimeOpen(false) }}
                    className={cn(
                      'w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors',
                      r === timeRange ? 'bg-brand-500/20 text-brand-400' : 'text-surface-300 hover:bg-surface-800',
                    )}
                  >
                    {r}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Cluster picker */}
        <div className="relative hidden sm:block" data-dropdown>
          <button
            onClick={() => setClusterOpen(o => !o)}
            className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700 rounded-lg text-sm transition-all"
          >
            <span className={cn(
              'w-2 h-2 rounded-full flex-shrink-0',
              activeCluster ? (statusColors[activeCluster.status] ?? 'bg-surface-500') : 'bg-surface-600',
            )} />
            <span className="text-surface-300 max-w-[120px] truncate">
              {activeCluster ? activeCluster.name : 'No cluster'}
            </span>
            <ChevronDown className="w-3 h-3 text-surface-500" />
          </button>
          <AnimatePresence>
            {clusterOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute top-full mt-1 right-0 bg-surface-900 border border-surface-700 rounded-xl p-1 shadow-xl z-50 min-w-[220px]"
              >
                {clusters.length === 0 && (
                  <div className="px-3 py-2 text-sm text-surface-500">No clusters configured</div>
                )}
                {clusters.map(c => (
                  <button
                    key={c.id}
                    onClick={() => { setActiveCluster(c); setClusterOpen(false) }}
                    className={cn(
                      'w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors',
                      c.id === activeCluster?.id ? 'bg-brand-500/10 text-brand-400' : 'text-surface-300 hover:bg-surface-800',
                    )}
                  >
                    <span className={cn('w-2 h-2 rounded-full flex-shrink-0', statusColors[c.status] ?? 'bg-surface-500')} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{c.name}</div>
                      <div className="text-2xs text-surface-500 truncate">{c.provider} · {c.region}</div>
                    </div>
                    {c.id === activeCluster?.id && (
                      <span className="text-2xs text-brand-400 flex-shrink-0">active</span>
                    )}
                  </button>
                ))}
                <div className="border-t border-surface-800 mt-1 pt-1">
                  <a
                    href="/dashboard/settings/clusters"
                    onClick={() => setClusterOpen(false)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brand-400 hover:bg-surface-800 transition-colors"
                  >
                    <span className="font-bold leading-none">+</span>
                    <span>Add cluster</span>
                  </a>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Notifications */}
        <div className="relative" data-dropdown>
          <button
            onClick={() => setNotifOpen(o => !o)}
            className="relative w-8 h-8 flex items-center justify-center rounded-lg bg-surface-800 hover:bg-surface-700 border border-surface-700 text-surface-400 hover:text-white transition-all"
          >
            <Bell className="w-4 h-4" />
            {(criticalAlerts > 0 || openIncidents > 0) && (
              <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-danger rounded-full text-2xs text-white flex items-center justify-center font-bold">
                {criticalAlerts + openIncidents > 9 ? '9+' : criticalAlerts + openIncidents}
              </span>
            )}
          </button>

          <AnimatePresence>
            {notifOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute top-full mt-1 right-0 bg-surface-900 border border-surface-700 rounded-xl shadow-xl z-50 w-80"
              >
                <div className="p-3 border-b border-surface-800 flex items-center justify-between">
                  <Link href="/incidents" onClick={() => setNotifOpen(false)} className="text-sm font-semibold text-white hover:text-brand-400 transition-colors">Notifications</Link>
                  <Link href="/incidents" onClick={() => setNotifOpen(false)} className="text-2xs text-surface-500 hover:text-brand-400 transition-colors">{criticalAlerts + openIncidents} active →</Link>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {alerts.filter(a => a.state === 'firing').length === 0 && openIncidents === 0 && (
                    <div className="px-3 py-6 text-center text-2xs text-surface-500">No active alerts</div>
                  )}
                  {incidents.filter(i => i.state !== 'resolved').slice(0, 10).map(inc => (
                    <Link
                      key={inc.id}
                      href={`/incidents/${inc.id}`}
                      onClick={() => setNotifOpen(false)}
                      className="flex gap-3 px-3 py-2.5 border-b border-surface-800/50 hover:bg-surface-800 transition-colors group"
                    >
                      <span className={cn('w-1.5 rounded-full flex-shrink-0 self-stretch', inc.severity === 'critical' ? 'bg-danger' : inc.severity === 'high' ? 'bg-warning' : 'bg-info')} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-white truncate group-hover:text-brand-400 transition-colors">{inc.title}</p>
                        <p className="text-2xs text-surface-400 mt-0.5">{inc.service} · <span className={cn(inc.severity === 'critical' ? 'text-danger' : inc.severity === 'high' ? 'text-warning' : 'text-info')}>{inc.severity}</span></p>
                      </div>
                      <ChevronDown className="w-3 h-3 text-surface-600 group-hover:text-brand-400 -rotate-90 flex-shrink-0 self-center transition-colors" />
                    </Link>
                  ))}
                  {alerts.filter(a => a.state === 'firing').slice(0, 10).map(alert => (
                    <Link
                      key={alert.id}
                      href="/incidents"
                      onClick={() => setNotifOpen(false)}
                      className="flex gap-3 px-3 py-2.5 border-b border-surface-800/50 hover:bg-surface-800 transition-colors group"
                    >
                      <span className={cn('w-1.5 rounded-full flex-shrink-0 self-stretch', alert.severity === 'critical' ? 'bg-danger' : alert.severity === 'high' ? 'bg-warning' : 'bg-info')} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-white truncate group-hover:text-brand-400 transition-colors">{alert.name}</p>
                        <p className="text-2xs text-surface-400 mt-0.5 line-clamp-2">{alert.summary}</p>
                      </div>
                      <ChevronDown className="w-3 h-3 text-surface-600 group-hover:text-brand-400 -rotate-90 flex-shrink-0 self-center transition-colors" />
                    </Link>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* User menu */}
        <div className="relative pl-2 border-l border-surface-800" data-dropdown>
          <button
            onClick={() => setUserOpen((o) => !o)}
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface-800 transition-all"
          >
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-500 to-purple-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {displayAvatar}
            </div>
            <div className="hidden sm:block text-left">
              <div className="text-xs font-medium text-white leading-tight">{displayName}</div>
              <div className={cn('text-2xs px-1.5 rounded-full border', ROLE_COLORS[displayRole])}>
                {ROLE_LABELS[displayRole]}
              </div>
            </div>
            <ChevronDown className="w-3 h-3 text-surface-500 hidden sm:block" />
          </button>

          <AnimatePresence>
            {userOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute top-full mt-1 right-0 bg-surface-900 border border-surface-700 rounded-xl shadow-xl z-50 w-56 overflow-hidden"
              >
                {/* User info */}
                <div className="px-3 py-3 border-b border-surface-800">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-500 to-purple-500 flex items-center justify-center text-white text-xs font-bold">
                      {displayAvatar}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-white">{displayName}</div>
                      <div className="text-2xs text-surface-400">{displayEmail || authUser?.email}</div>
                    </div>
                  </div>
                  <div className={cn('mt-2 text-2xs px-2 py-0.5 rounded-full border inline-flex', ROLE_COLORS[displayRole])}>
                    {ROLE_LABELS[displayRole]}
                  </div>
                </div>

                {/* Actions */}
                <div className="p-1">
                  <button
                    onClick={() => { router.push('/dashboard/settings?tab=profile'); setUserOpen(false) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-300 hover:bg-surface-800 hover:text-white rounded-lg transition-colors">
                    <User className="w-3.5 h-3.5" />
                    Profile settings
                  </button>
                  <button
                    onClick={() => signOut({ callbackUrl: '/login' })}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger/10 rounded-lg transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    Sign out
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  )
}

