'use client'

import { useEffect, useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { Command } from 'cmdk'
import {
  Search, LayoutDashboard, Activity, Server, Boxes, Siren,
  Bot, Zap, ShieldAlert, BarChart3, GitFork, Cloud, X,
  ArrowRight, Hash, AlertTriangle, Bell, DollarSign,
} from 'lucide-react'
import { useDashboardStore } from '@/store'
import { cn } from '@/lib/utils'

const NAV_COMMANDS = [
  { id: 'nav-dashboard',      group: 'Navigation',  label: 'Go to Dashboard',         href: '/dashboard',                  icon: LayoutDashboard },
  { id: 'nav-observability',  group: 'Navigation',  label: 'Go to Observability',      href: '/dashboard/observability',    icon: Activity },
  { id: 'nav-infrastructure', group: 'Navigation',  label: 'Go to Infrastructure',     href: '/dashboard/infrastructure',   icon: Server },
  { id: 'nav-kubernetes',     group: 'Navigation',  label: 'Go to Kubernetes',          href: '/dashboard/kubernetes',       icon: Boxes },
  { id: 'nav-incidents',      group: 'Navigation',  label: 'Go to Incidents',           href: '/dashboard/incidents',        icon: Siren },
  { id: 'nav-topology',       group: 'Navigation',  label: 'Go to Topology',            href: '/dashboard/topology',         icon: GitFork },
  { id: 'nav-ai',             group: 'Navigation',  label: 'Open AI Copilot',           href: '/dashboard/ai-copilot',       icon: Bot },
  { id: 'nav-automation',     group: 'Navigation',  label: 'Go to Automation Studio',   href: '/dashboard/automation',       icon: Zap },
  { id: 'nav-security',       group: 'Navigation',  label: 'Go to Security',            href: '/dashboard/security',         icon: ShieldAlert },
  { id: 'nav-analytics',      group: 'Navigation',  label: 'Go to Analytics',           href: '/dashboard/analytics',        icon: BarChart3 },
  { id: 'nav-finops',         group: 'Navigation',  label: 'Go to FinOps',               href: '/dashboard/finops',          icon: DollarSign },
]

const AI_QUERIES = [
  { id: 'q-rca',  label: 'Ask AI: Why is payment latency high?',  href: '/dashboard/ai-copilot?q=why+is+payment+latency+high' },
  { id: 'q-cost', label: 'Ask AI: How can I reduce cloud costs?', href: '/dashboard/ai-copilot?q=how+can+I+reduce+cloud+costs' },
  { id: 'q-k8s',  label: 'Ask AI: Show me failing pods',          href: '/dashboard/ai-copilot?q=show+me+failing+pods' },
]

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-danger',
  high: 'bg-orange-500',
  medium: 'bg-warning',
  low: 'bg-success',
}

export default function CommandPalette() {
  const { commandPaletteOpen, closeCommandPalette, openCommandPalette, incidents, alerts, threats } = useDashboardStore()
  const router = useRouter()
  const [query, setQuery] = useState('')

  const handleKeydown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      commandPaletteOpen ? closeCommandPalette() : openCommandPalette()
    }
    if (e.key === 'Escape') closeCommandPalette()
  }, [commandPaletteOpen, closeCommandPalette, openCommandPalette])

  useEffect(() => {
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [handleKeydown])

  // Reset query on close
  useEffect(() => { if (!commandPaletteOpen) setQuery('') }, [commandPaletteOpen])

  const openIncidents = incidents.filter(i => i.state !== 'resolved')
  const firingAlerts = alerts.filter(a => a.state === 'firing').slice(0, 5)
  const activeThreats = threats.filter(t => !t.mitigated).slice(0, 4)

  return (
    <AnimatePresence>
      {commandPaletteOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
            onClick={closeCommandPalette}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -20 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="fixed top-[20vh] left-1/2 -translate-x-1/2 w-full max-w-xl z-50"
          >
            <Command
              className="bg-surface-900 border border-surface-700 rounded-2xl shadow-2xl overflow-hidden"
              shouldFilter
            >
              <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-800">
                <Search className="w-4 h-4 text-surface-400 flex-shrink-0" />
                <Command.Input
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search pages, incidents, alerts, threats..."
                  className="flex-1 bg-transparent text-sm text-white placeholder-surface-500 outline-none"
                  autoFocus
                />
                <button onClick={closeCommandPalette} className="text-surface-500 hover:text-surface-300">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <Command.List className="max-h-96 overflow-y-auto p-2">
                <Command.Empty className="py-8 text-center text-sm text-surface-500">
                  No results for &ldquo;{query}&rdquo;
                </Command.Empty>

                {/* Navigation */}
                <Command.Group
                  heading="Navigation"
                  className="[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-surface-500 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
                >
                  {NAV_COMMANDS.map(cmd => {
                    const Icon = cmd.icon
                    return (
                      <Command.Item
                        key={cmd.id}
                        value={cmd.label}
                        onSelect={() => { router.push(cmd.href); closeCommandPalette() }}
                        className="flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-surface-300 cursor-pointer aria-selected:bg-brand-500/15 aria-selected:text-white transition-colors"
                      >
                        <Icon className="w-4 h-4 flex-shrink-0 text-surface-400" />
                        <span className="flex-1">{cmd.label}</span>
                        <ArrowRight className="w-3 h-3 text-surface-600" />
                      </Command.Item>
                    )
                  })}
                </Command.Group>

                {/* Live Incidents */}
                {openIncidents.length > 0 && (
                  <Command.Group
                    heading="Open Incidents"
                    className="[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-surface-500 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
                  >
                    {openIncidents.map(inc => (
                      <Command.Item
                        key={inc.id}
                        value={`${inc.id} ${inc.title} ${inc.service}`}
                        onSelect={() => { router.push(`/dashboard/incidents/${inc.id}`); closeCommandPalette() }}
                        className="flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-surface-300 cursor-pointer aria-selected:bg-brand-500/15 aria-selected:text-white transition-colors"
                      >
                        <AlertTriangle className="w-4 h-4 flex-shrink-0 text-danger" />
                        <div className="flex-1 min-w-0">
                          <p className="truncate">{inc.title}</p>
                          <p className="text-2xs text-surface-500">{inc.id.toUpperCase()} · {inc.service}</p>
                        </div>
                        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', SEVERITY_DOT[inc.severity] ?? 'bg-surface-500')} />
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}

                {/* Firing Alerts */}
                {firingAlerts.length > 0 && (
                  <Command.Group
                    heading="Firing Alerts"
                    className="[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-surface-500 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
                  >
                    {firingAlerts.map(alert => (
                      <Command.Item
                        key={alert.id}
                        value={`${alert.name} ${alert.affectedServices.join(' ')} ${alert.summary}`}
                        onSelect={() => { router.push('/dashboard/observability'); closeCommandPalette() }}
                        className="flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-surface-300 cursor-pointer aria-selected:bg-brand-500/15 aria-selected:text-white transition-colors"
                      >
                        <Bell className="w-4 h-4 flex-shrink-0 text-warning" />
                        <div className="flex-1 min-w-0">
                          <p className="truncate">{alert.name}</p>
                          <p className="text-2xs text-surface-500">{alert.affectedServices[0] ?? alert.source}</p>
                        </div>
                        <span className={cn('text-2xs px-1.5 py-0.5 rounded capitalize', SEVERITY_DOT[alert.severity] ? 'text-warning' : 'text-surface-500')}>{alert.severity}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}

                {/* AI Quick Queries */}
                <Command.Group
                  heading="AI Queries"
                  className="[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-surface-500 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
                >
                  {AI_QUERIES.map(q => (
                    <Command.Item
                      key={q.id}
                      value={q.label}
                      onSelect={() => { router.push(q.href); closeCommandPalette() }}
                      className="flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-surface-300 cursor-pointer aria-selected:bg-brand-500/15 aria-selected:text-white transition-colors"
                    >
                      <Bot className="w-4 h-4 flex-shrink-0 text-brand-400" />
                      <span className="flex-1">{q.label}</span>
                      <ArrowRight className="w-3 h-3 text-surface-600" />
                    </Command.Item>
                  ))}
                  {query.length > 3 && (
                    <Command.Item
                      value={`ask ai ${query}`}
                      onSelect={() => { router.push(`/dashboard/ai-copilot?q=${encodeURIComponent(query)}`); closeCommandPalette() }}
                      className="flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-brand-400 cursor-pointer aria-selected:bg-brand-500/15 aria-selected:text-white transition-colors border border-brand-500/20"
                    >
                      <Bot className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1">Ask AI: &ldquo;{query}&rdquo;</span>
                      <ArrowRight className="w-3 h-3" />
                    </Command.Item>
                  )}
                </Command.Group>
              </Command.List>

              <div className="flex items-center gap-3 px-4 py-2 border-t border-surface-800 text-2xs text-surface-600">
                <span className="flex items-center gap-1"><kbd className="bg-surface-800 px-1 rounded">↑↓</kbd> navigate</span>
                <span className="flex items-center gap-1"><kbd className="bg-surface-800 px-1 rounded">↵</kbd> select</span>
                <span className="flex items-center gap-1"><kbd className="bg-surface-800 px-1 rounded">esc</kbd> close</span>
                <span className="ml-auto">{openIncidents.length} open incidents · {firingAlerts.length} firing alerts</span>
              </div>
            </Command>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
