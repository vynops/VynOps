'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Server, Plus, Trash2, RefreshCw, CheckCircle2, XCircle,
  Loader2, ChevronLeft, ExternalLink, Activity, Globe, Cpu, Hash, Pencil, Save, X, Zap,
  Database, GitBranch, Bell, Key, BookOpen, User, Info, Clock, Users, Layers, ChevronRight, Settings,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'

const SETTINGS_SECTIONS = [
  { id: 'clusters',      label: 'Clusters',       href: '/dashboard/settings/clusters' },
  { id: 'connections',   label: 'Connections',   href: '/settings#connections' },
  { id: 'datasources',   label: 'Data Sources',   href: '/settings#datasources' },
  { id: 'integrations',  label: 'Integrations',   href: '/settings#integrations' },
  { id: 'notifications', label: 'Notifications',  href: '/settings#notifications' },
  { id: 'ai-provider',   label: 'AI Provider',    href: '/settings#ai-provider' },
  { id: 'users',         label: 'Users',           href: '/settings#users' },
  { id: 'oncall',        label: 'On-Call',         href: '/settings#oncall' },
  { id: 'access',        label: 'Access & Keys',   href: '/settings#access' },
  { id: 'audit-log',     label: 'Audit Log',       href: '/settings#audit-log' },
  { id: 'profile',       label: 'Profile',         href: '/settings#profile' },
  { id: 'about',         label: 'About',           href: '/settings#about' },
]
import { useDashboardStore } from '@/store'
import type { K8sCluster } from '@/types'

const STATUS_DOT: Record<string, string> = {
  healthy:  'bg-green-500',
  degraded: 'bg-yellow-500',
  critical: 'bg-red-500',
  unknown:  'bg-surface-500',
}

const STATUS_BADGE: Record<string, string> = {
  healthy:  'text-green-400 bg-green-500/10 border-green-500/30',
  degraded: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  critical: 'text-red-400 bg-red-500/10 border-red-500/30',
  unknown:  'text-surface-400 bg-surface-500/10 border-surface-500/30',
}

function ClustersPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { clusters, setClusters, activeCluster, setActiveCluster } = useDashboardStore()

  const [loading, setLoading]   = useState(true)
  const [adding,  setAdding]    = useState(false)
  const [saving,  setSaving]    = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [probing,  setProbing]  = useState<string | null>(null)
  const [error,   setError]     = useState<string | null>(null)
  const [success, setSuccess]   = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<K8sCluster | null>(null)
  const [editForm, setEditForm] = useState<typeof form | null>(null)
  const manageMode = searchParams.get('manage') === '1'

  // Add-cluster form state
  const [form, setForm] = useState({
    name:             '',
    k8sUrl:           '',
    promUrl:          '',
    alertmanagerUrl:  '',
    lokiUrl:          '',
    jaegerUrl:        '',
    grafanaUrl:       '',
    provider:         'on-prem',
    region:           '',
    environment:      'production',
    description:      '',
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch('/api/settings/clusters')
      const data = await res.json()
      setClusters(data)
    } catch {
      setError('Failed to load clusters.')
    } finally {
      setLoading(false)
    }
  }, [setClusters])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!manageMode) router.replace('/settings?tab=clusters')
  }, [manageMode, router])

  if (!manageMode) return null

  function openEdit(c: K8sCluster) {
    setEditTarget(c)
    setEditForm({
      name:            c.name,
      k8sUrl:          c.k8sUrl          ?? '',
      promUrl:         c.promUrl         ?? '',
      alertmanagerUrl: c.alertmanagerUrl ?? '',
      lokiUrl:         c.lokiUrl         ?? '',
      jaegerUrl:       c.jaegerUrl       ?? '',
      grafanaUrl:      c.grafanaUrl      ?? '',
      provider:        c.provider,
      region:          c.region,
      environment:     c.environment ?? 'production',
      description:     c.description ?? '',
    })
    setError(null)
    setSuccess(null)
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editTarget || !editForm) return
    if (!editForm.name.trim() || !editForm.k8sUrl.trim()) {
      setError('Name and K8s API URL are required.')
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/settings/clusters', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editTarget.id, ...editForm }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const updated: K8sCluster = await res.json()
      const next = clusters.map(c => c.id === updated.id ? updated : c)
      setClusters(next)
      if (activeCluster?.id === updated.id) setActiveCluster(updated)
      setEditTarget(null)
      setEditForm(null)
      setSuccess(`Cluster "${updated.name}" updated.`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update cluster.')
    } finally {
      setSaving(false)
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.k8sUrl.trim()) {
      setError('Name and K8s API URL are required.')
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/settings/clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const created: K8sCluster = await res.json()
      setClusters([...clusters, created])
      if (!activeCluster) setActiveCluster(created)
      setForm({ name: '', k8sUrl: '', promUrl: '', alertmanagerUrl: '', lokiUrl: '', jaegerUrl: '', grafanaUrl: '', provider: 'on-prem', region: '', environment: 'production', description: '' })
      setAdding(false)
      setSuccess(`Cluster "${created.name}" added successfully.`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add cluster.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Remove cluster "${name}"? This cannot be undone.`)) return
    setDeleting(id)
    setError(null)
    try {
      const res = await fetch('/api/settings/clusters', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const updated = clusters.filter(c => c.id !== id)
      setClusters(updated)
      if (activeCluster?.id === id) setActiveCluster(updated[0] ?? null)
      setSuccess(`Cluster "${name}" removed.`)
    } catch {
      setError('Failed to remove cluster.')
    } finally {
      setDeleting(null)
    }
  }

  async function handleProbe(id: string, name: string) {
    setProbing(id)
    setError(null)
    try {
      const res = await fetch('/api/settings/clusters', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const updated: K8sCluster = await res.json()
      const next = clusters.map(c => c.id === updated.id ? updated : c)
      setClusters(next)
      if (activeCluster?.id === updated.id) setActiveCluster(updated)
      setSuccess(`"${name}" re-probed — ${updated.nodeCount} nodes · ${updated.podCount} pods · ${updated.cpuCapacity.toFixed(1)} CPU cores · ${updated.memoryCapacity.toFixed(1)} GiB RAM`)
    } catch {
      setError('Failed to probe cluster.')
    } finally {
      setProbing(null)
    }
  }

  async function handleSetDefault(id: string) {
    setError(null)
    try {
      const res = await fetch('/api/settings/clusters?setDefault=1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Refresh the full list so isDefault flags are correct
      const list = await fetch('/api/settings/clusters').then(r => r.json())
      setClusters(list)
      if (activeCluster) setActiveCluster(list.find((c: K8sCluster) => c.id === activeCluster.id) ?? list[0] ?? null)
      setSuccess('Default cluster updated.')
    } catch {
      setError('Failed to set default cluster.')
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 py-4 border-b border-surface-800 flex-shrink-0">
        <h1 className="text-lg font-bold text-white flex items-center gap-2">
          <Settings className="w-5 h-5 text-brand-400" /> Settings
        </h1>
        <p className="text-xs text-surface-500 mt-0.5">Platform configuration · connections · integrations · access</p>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Settings sidebar */}
        <div className="hidden md:flex md:flex-col w-52 flex-shrink-0 border-r border-surface-800 p-3 space-y-0.5 overflow-y-auto">
          {SETTINGS_SECTIONS.map(s => (
            <Link key={s.id} href={s.href}
              className={cn('w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm transition-all group',
                s.id === 'clusters'
                  ? 'bg-brand-500/10 text-brand-400'
                  : 'text-surface-400 hover:bg-surface-800 hover:text-surface-300')}>
              <span>{s.label}</span>
              {s.id === 'clusters' && <ChevronRight className="w-3 h-3" />}
            </Link>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/dashboard/settings"
            className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-white transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </Link>
          <Server className="w-5 h-5 text-brand-400" />
          <div>
            <h1 className="text-xl font-semibold">Cluster Management</h1>
            <p className="text-sm text-surface-400">Register and manage Kubernetes clusters</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={load}
              className="p-2 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-white transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setAdding(true); setError(null); setSuccess(null) }}
              className="flex items-center gap-2 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Cluster
            </button>
          </div>
        </div>

        {/* Feedback banners */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="flex items-center gap-2 mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm"
            >
              <XCircle className="w-4 h-4 flex-shrink-0" />
              {error}
              <button onClick={() => setError(null)} className="ml-auto text-red-400/60 hover:text-red-400">✕</button>
            </motion.div>
          )}
          {success && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="flex items-center gap-2 mb-4 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl text-green-400 text-sm"
            >
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              {success}
              <button onClick={() => setSuccess(null)} className="ml-auto text-green-400/60 hover:text-green-400">✕</button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Add cluster form */}
        <AnimatePresence>
          {adding && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden mb-6"
            >
              <form
                onSubmit={handleAdd}
                className="bg-surface-900 border border-surface-700 rounded-xl p-5"
              >
                <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
                  <Plus className="w-4 h-4 text-brand-400" />
                  New Cluster
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Cluster Name <span className="text-red-400">*</span></label>
                    <input
                      value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="my-prod-cluster"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">K8s API URL <span className="text-red-400">*</span></label>
                    <input
                      value={form.k8sUrl}
                      onChange={e => setForm(f => ({ ...f, k8sUrl: e.target.value }))}
                      placeholder="http://localhost:8001"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Prometheus URL</label>
                    <input
                      value={form.promUrl}
                      onChange={e => setForm(f => ({ ...f, promUrl: e.target.value }))}
                      placeholder="http://localhost:9090"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Alertmanager URL</label>
                    <input
                      value={form.alertmanagerUrl}
                      onChange={e => setForm(f => ({ ...f, alertmanagerUrl: e.target.value }))}
                      placeholder="http://localhost:9093"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Loki URL</label>
                    <input
                      value={form.lokiUrl}
                      onChange={e => setForm(f => ({ ...f, lokiUrl: e.target.value }))}
                      placeholder="http://localhost:3100"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Jaeger URL</label>
                    <input
                      value={form.jaegerUrl}
                      onChange={e => setForm(f => ({ ...f, jaegerUrl: e.target.value }))}
                      placeholder="http://localhost:16686"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Grafana URL</label>
                    <input
                      value={form.grafanaUrl}
                      onChange={e => setForm(f => ({ ...f, grafanaUrl: e.target.value }))}
                      placeholder="http://localhost:3000"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Provider</label>
                    <select
                      value={form.provider}
                      onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
                    >
                      <option value="on-prem">On-Prem</option>
                      <option value="aws">AWS / EKS</option>
                      <option value="gcp">GCP / GKE</option>
                      <option value="azure">Azure / AKS</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Region</label>
                    <input
                      value={form.region}
                      onChange={e => setForm(f => ({ ...f, region: e.target.value }))}
                      placeholder="us-east-1"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Environment</label>
                    <select
                      value={form.environment}
                      onChange={e => setForm(f => ({ ...f, environment: e.target.value }))}
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
                    >
                      {['production', 'staging', 'development', 'lab'].map(e => (
                        <option key={e} value={e}>{e}</option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-surface-400 mb-1">Description</label>
                    <input
                      value={form.description}
                      onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Optional — e.g. Primary production cluster"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                    />
                  </div>
                </div>
                <p className="text-xs text-surface-500 mt-3">
                  The K8s API URL will be probed to verify connectivity and fetch version/node count.
                </p>
                <div className="flex items-center gap-2 mt-4">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    {saving ? 'Probing & Saving…' : 'Add Cluster'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAdding(false); setError(null) }}
                    className="px-4 py-2 bg-surface-800 hover:bg-surface-700 text-surface-300 rounded-lg text-sm transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Cluster list */}
        {loading ? (
          <div className="flex items-center justify-center py-20 text-surface-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading clusters…
          </div>
        ) : clusters.length === 0 ? (
          <div className="text-center py-20 text-surface-400">
            <Server className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No clusters registered yet.</p>
            <p className="text-xs mt-1">Click <strong>Add Cluster</strong> to get started.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {clusters.map(cluster => (
              <motion.div
                key={cluster.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
              >
                {/* ── Edit form (inline, expands below card) ── */}
                <AnimatePresence>
                  {editTarget?.id === cluster.id && editForm && (
                    <motion.form
                      key="edit-form"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      onSubmit={handleSaveEdit}
                      className="overflow-hidden mb-1"
                    >
                      <div className="bg-surface-800 border border-brand-500/30 rounded-xl p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                            <Pencil className="w-3.5 h-3.5 text-brand-400" /> Edit “{editTarget.name}”
                          </h3>
                          <button type="button" onClick={() => { setEditTarget(null); setEditForm(null); setError(null) }}
                            className="p-1 rounded-lg hover:bg-surface-700 text-surface-400 hover:text-white transition-colors">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {([
                            ['name',            'Cluster Name',     'my-prod-cluster',       true],
                            ['k8sUrl',          'K8s API URL',      'http://10.0.0.1:8001',  true],
                            ['promUrl',         'Prometheus URL',   'http://prometheus:9090', false],
                            ['alertmanagerUrl', 'Alertmanager URL', 'http://alertmanager:9093', false],
                            ['lokiUrl',         'Loki URL',         'http://loki:3100',       false],
                            ['jaegerUrl',       'Jaeger URL',       'http://jaeger:16686',    false],
                            ['grafanaUrl',      'Grafana URL',      'http://grafana:3000',     false],
                            ['description',     'Description',      'Optional — e.g. Production cluster', false],
                          ] as [keyof typeof editForm, string, string, boolean][]).map(([key, label, ph, req]) => (
                            <div key={key}>
                              <label className="block text-xs text-surface-400 mb-1">
                                {label} {req && <span className="text-red-400">*</span>}
                              </label>
                              <input
                                value={editForm[key]}
                                onChange={ev => setEditForm(f => f ? { ...f, [key]: ev.target.value } : f)}
                                placeholder={ph}
                                required={req}
                                className="w-full px-3 py-2 bg-surface-900 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                              />
                            </div>
                          ))}
                          <div>
                            <label className="block text-xs text-surface-400 mb-1">Provider</label>
                            <select
                              value={editForm.provider}
                              onChange={ev => setEditForm(f => f ? { ...f, provider: ev.target.value } : f)}
                              className="w-full px-3 py-2 bg-surface-900 border border-surface-700 rounded-lg text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
                            >
                              {['on-prem','aws','gcp','azure','oracle','digitalocean','other'].map(p => (
                                <option key={p} value={p}>{p}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-surface-400 mb-1">Region</label>
                            <input
                              value={editForm.region}
                              onChange={ev => setEditForm(f => f ? { ...f, region: ev.target.value } : f)}
                              placeholder="us-east-1"
                              className="w-full px-3 py-2 bg-surface-900 border border-surface-700 rounded-lg text-sm text-white placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-surface-400 mb-1">Environment</label>
                            <select
                              value={editForm.environment}
                              onChange={ev => setEditForm(f => f ? { ...f, environment: ev.target.value } : f)}
                              className="w-full px-3 py-2 bg-surface-900 border border-surface-700 rounded-lg text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
                            >
                              {['production', 'staging', 'development', 'lab'].map(e => (
                                <option key={e} value={e}>{e}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <p className="text-xs text-surface-500">Changing the K8s URL will re-probe to update version &amp; node count.</p>
                        <div className="flex items-center gap-2">
                          <button type="submit" disabled={saving}
                            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {saving ? 'Saving…' : 'Save Changes'}
                          </button>
                          <button type="button" onClick={() => { setEditTarget(null); setEditForm(null); setError(null) }}
                            className="px-4 py-2 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded-lg text-sm transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    </motion.form>
                  )}
                </AnimatePresence>

                {/* ── Cluster card ── */}
                <div
                  className={cn(
                    'bg-surface-900 border rounded-xl p-4 transition-all',
                    activeCluster?.id === cluster.id
                      ? 'border-brand-500/40 shadow-[0_0_0_1px_rgba(99,102,241,0.15)]'
                      : 'border-surface-700 hover:border-surface-600',
                  )}
                >
                  <div className="flex items-start gap-4">
                    {/* Status dot */}
                    <div className="mt-0.5">
                      <span className={cn('block w-2.5 h-2.5 rounded-full', STATUS_DOT[cluster.status] ?? STATUS_DOT.unknown)} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-white text-sm">{cluster.name}</span>
                        <span className={cn('text-2xs px-1.5 py-0.5 rounded border', STATUS_BADGE[cluster.status] ?? STATUS_BADGE.unknown)}>
                          {cluster.status}
                        </span>
                        {activeCluster?.id === cluster.id && (
                          <span className="text-2xs px-1.5 py-0.5 rounded border text-brand-400 bg-brand-500/10 border-brand-500/30">
                            active
                          </span>
                        )}
                        {cluster.environment && (
                          <span className={cn('text-2xs px-1.5 py-0.5 rounded border',
                            cluster.environment === 'production'  ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                            cluster.environment === 'staging'     ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' :
                            cluster.environment === 'development' ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' :
                                                                    'text-surface-400 bg-surface-500/10 border-surface-500/20'
                          )}>{cluster.environment}</span>
                        )}
                      </div>

                      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs text-surface-400">
                        <span className="flex items-center gap-1">
                          <Globe className="w-3 h-3" />
                          {cluster.provider} · {cluster.region || '—'}
                        </span>
                        <span className="flex items-center gap-1">
                          <Activity className="w-3 h-3" />
                          v{cluster.version}
                        </span>
                        <span className="flex items-center gap-1">
                          <Cpu className="w-3 h-3" />
                          {cluster.nodeCount} node{cluster.nodeCount !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1">
                          <Hash className="w-3 h-3" />
                          {cluster.namespaceCount} namespace{cluster.namespaceCount !== 1 ? 's' : ''}
                        </span>
                      </div>

                      {cluster.k8sUrl && (
                        <div className="mt-1.5 text-xs text-surface-500 flex items-center gap-1 truncate">
                          <ExternalLink className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{cluster.k8sUrl}</span>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Default badge / Set-default button */}
                      {cluster.isDefault ? (
                        <span className="text-2xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20 select-none">
                          default
                        </span>
                      ) : (
                        <button
                          onClick={() => handleSetDefault(cluster.id)}
                          title="Make this the server-side default cluster"
                          className="px-2 py-1 text-xs rounded-lg border border-surface-600 text-surface-400 hover:text-white hover:bg-surface-800 transition-colors"
                        >
                          Set Default
                        </button>
                      )}
                      {activeCluster?.id !== cluster.id && (
                        <button
                          onClick={() => setActiveCluster(cluster)}
                          className="px-3 py-1.5 text-xs bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 text-brand-400 rounded-lg transition-colors"
                        >
                          Switch
                        </button>
                      )}
                      <button
                        onClick={() => handleProbe(cluster.id, cluster.name)}
                        disabled={probing === cluster.id}
                        className="p-1.5 rounded-lg text-surface-500 hover:text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-40"
                        title="Re-probe live stats"
                      >
                        {probing === cluster.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => editTarget?.id === cluster.id ? (setEditTarget(null), setEditForm(null)) : openEdit(cluster)}
                        className={cn(
                          'p-1.5 rounded-lg transition-colors',
                          editTarget?.id === cluster.id
                            ? 'text-brand-400 bg-brand-500/10'
                            : 'text-surface-500 hover:text-brand-400 hover:bg-brand-500/10',
                        )}
                        title="Edit cluster"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(cluster.id, cluster.name)}
                        disabled={deleting === cluster.id}
                        className="p-1.5 rounded-lg text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                        title="Remove cluster"
                      >
                        {deleting === cluster.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />
                        }
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* Help text */}
        {clusters.length > 0 && (
          <p className="mt-6 text-xs text-surface-500">
            The <strong className="text-surface-400">active</strong> cluster is used for all K8s API calls in the dashboard.
            Switch clusters here or from the top header dropdown.
          </p>
        )}
      </div>
        </div>
      </div>
    </div>
  )
}

export default function ClustersPage() {
  return (
    <Suspense>
      <ClustersPageContent />
    </Suspense>
  )
}

