'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard, Activity, Server, Boxes, DollarSign, Siren,
  GitFork, Bot, Zap, ShieldAlert, BarChart3, Bell,
  Settings, ChevronLeft, ChevronRight, Rocket, X as CloseX, BrainCircuit,
} from 'lucide-react'
import { useDashboardStore } from '@/store'
import { cn } from '@/lib/utils'
import { useState, useEffect } from 'react'

type NavItem = { id: string; label: string; href: string; icon: any; badge?: string; highlight?: boolean }
type NavGroup = { label: string; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Observe',
    items: [
      { id: 'dashboard',      label: 'Home',           href: '/dashboard',      icon: LayoutDashboard },
      { id: 'observability',  label: 'Observability',  href: '/observability',  icon: Activity },
      { id: 'kubernetes',     label: 'Kubernetes',     href: '/kubernetes',     icon: Boxes },
      { id: 'infrastructure', label: 'Infrastructure', href: '/infrastructure', icon: Server },
      { id: 'topology',       label: 'Topology',       href: '/topology',       icon: GitFork },
    ],
  },
  {
    label: 'Respond',
    items: [
      { id: 'alerts',      label: 'Alerts',      href: '/alerts',      icon: Bell,   badge: 'alerts' },
      { id: 'incidents',   label: 'Incidents',   href: '/incidents',   icon: Siren,  badge: 'incidents' },
      { id: 'deployments', label: 'Deployments', href: '/deployments', icon: Rocket },
    ],
  },
  {
    label: 'AI Ops',
    items: [
      { id: 'ai-copilot',  label: 'AI Copilot',    href: '/ai-copilot',  icon: Bot,          highlight: true },
      { id: 'autonomous',  label: 'Autonomous Ops', href: '/autonomous',  icon: BrainCircuit, highlight: true },
      { id: 'automation',  label: 'Automation',     href: '/automation',  icon: Zap },
    ],
  },
  {
    label: 'Govern',
    items: [
      { id: 'security',  label: 'Security',  href: '/security',  icon: ShieldAlert },
      { id: 'finops',    label: 'FinOps',    href: '/finops',    icon: DollarSign },
      { id: 'analytics', label: 'Analytics', href: '/analytics', icon: BarChart3 },
    ],
  },
  {
    label: 'Admin',
    items: [
      { id: 'settings', label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
]

export default function LeftNav() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const mobileOpen = useDashboardStore(s => s.mobileNavOpen)
  const setMobileNavOpen = useDashboardStore(s => s.setMobileNavOpen)
  const incidents = useDashboardStore(s => s.incidents)
  const alerts = useDashboardStore(s => s.alerts)

  const [appName,    setAppName]    = useState('VynOps')
  const [appTagline, setAppTagline] = useState('AI Platform')
  const appInitial = appName.charAt(0).toUpperCase() || 'A'

  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem('user_profile') ?? '{}')
      if (p.platform_name)    setAppName(p.platform_name)
      if (p.platform_tagline) setAppTagline(p.platform_tagline)
    } catch {}
    const onStorage = () => {
      try {
        const p = JSON.parse(localStorage.getItem('user_profile') ?? '{}')
        setAppName(p.platform_name    || 'VynOps')
        setAppTagline(p.platform_tagline || 'AI Platform')
      } catch {}
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const firingAlerts  = alerts.filter(a => a.state === 'firing').length
  const openIncidents = incidents.filter(i => i.state !== 'resolved').length

  const getBadge = (id: string) => {
    if (id === 'alerts')        return firingAlerts  > 0 ? firingAlerts  : undefined
    if (id === 'incidents')     return openIncidents > 0 ? openIncidents : undefined
    if (id === 'observability') return firingAlerts  > 0 ? firingAlerts  : undefined
    return undefined
  }

  return (
    <>
      {/* Mobile overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="sm:hidden fixed inset-0 z-40 bg-black/60"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Nav */}
      <motion.nav
        animate={{ width: collapsed ? 56 : 220 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
        className={cn(
          'relative flex flex-col bg-surface-950 border-r border-surface-800 h-full z-50 overflow-hidden',
          'hidden sm:flex',
          mobileOpen && '!flex fixed left-0 top-0 h-screen z-50 shadow-2xl',
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-3 py-4 border-b border-surface-800 h-14 flex-shrink-0">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center flex-shrink-0 shadow-glow-brand">
            <span className="text-white font-bold text-sm">{appInitial}</span>
          </div>
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
                className="flex flex-col min-w-0"
              >
                <span className="text-white font-bold text-sm leading-tight">{appName}</span>
                <span className="text-brand-500 text-2xs font-medium tracking-widest uppercase">{appTagline}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Nav groups */}
        <div className="flex-1 overflow-y-auto scrollbar-none py-3 px-2">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label} className={gi > 0 ? 'mt-4' : ''}>
              <AnimatePresence>
                {!collapsed && (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-surface-500 text-2xs font-semibold uppercase tracking-widest px-2.5 pb-1"
                  >
                    {group.label}
                  </motion.p>
                )}
              </AnimatePresence>
              <div className="space-y-0.5">
                {group.items.map(item => {
                  const Icon = item.icon
                  const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
                  const badge = getBadge(item.id)

                  return (
                    <Link key={item.id} href={item.href} onClick={() => setMobileNavOpen(false)}>
                      <motion.div
                        whileHover={{ x: 2 }}
                        transition={{ duration: 0.1 }}
                        className={cn(
                          'flex items-center gap-3 px-2.5 py-2 rounded-xl text-sm font-medium cursor-pointer relative group border-l-2 transition-all duration-150',
                          isActive
                            ? 'nav-item-active bg-brand-500/10'
                            : item.highlight
                            ? 'text-brand-400 border-brand-500/30 hover:bg-brand-500/10 hover:text-brand-300 border-l-2'
                            : 'nav-item',
                        )}
                        title={collapsed ? item.label : undefined}
                      >
                        <Icon className={cn('flex-shrink-0', collapsed ? 'w-5 h-5' : 'w-4 h-4', item.highlight && 'drop-shadow-[0_0_6px_rgba(6,182,212,0.6)]')} />

                        <AnimatePresence>
                          {!collapsed && (
                            <motion.span
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              className="truncate"
                            >
                              {item.label}
                            </motion.span>
                          )}
                        </AnimatePresence>

                        {badge !== undefined && (
                          <motion.span
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            className={cn(
                              'flex-shrink-0 rounded-full text-2xs font-bold leading-none flex items-center justify-center',
                              collapsed
                                ? 'absolute -top-0.5 -right-0.5 w-4 h-4 bg-danger text-white'
                                : 'ml-auto px-1.5 py-0.5 bg-danger/20 text-danger min-w-[20px]',
                            )}
                          >
                            {badge}
                          </motion.span>
                        )}
                      </motion.div>
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="absolute -right-3 top-[72px] z-30 w-6 h-6 rounded-full bg-surface-800 border border-surface-700 hidden sm:flex items-center justify-center text-surface-400 hover:text-white hover:bg-surface-700 transition-colors"
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
        </button>

        {/* Mobile close */}
        {mobileOpen && (
          <button onClick={() => setMobileNavOpen(false)} className="sm:hidden absolute top-3 right-3 z-50 w-7 h-7 flex items-center justify-center rounded-lg bg-surface-800 text-surface-400 hover:text-white transition-all">
            <CloseX className="w-3.5 h-3.5" />
          </button>
        )}
      </motion.nav>
    </>
  )
}
