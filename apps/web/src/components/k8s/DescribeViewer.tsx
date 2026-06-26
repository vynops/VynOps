'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, FileSearch, RefreshCw, Copy, Check, ChevronDown, ChevronRight, AlertTriangle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getClusterHeaders } from '@/store'

interface DescribeViewerProps {
  kind: string
  namespace: string
  name: string
  onClose: () => void
}

function age(ts: string) {
  if (!ts) return '—'
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-2 py-1.5 border-b border-surface-800 last:border-0 items-start">
      <span className="text-2xs text-surface-500 font-semibold uppercase tracking-wide">{label}</span>
      <div className="text-2xs text-surface-200 break-all min-w-0">{value ?? <span className="text-surface-600">—</span>}</div>
    </div>
  )
}

function Section({ title, children, defaultOpen = true }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-surface-800 rounded-lg overflow-hidden mb-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-surface-900 hover:bg-surface-800 text-left"
      >
        <span className="text-2xs font-semibold text-surface-300 uppercase tracking-wider">{title}</span>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-surface-500" /> : <ChevronRight className="w-3.5 h-3.5 text-surface-500" />}
      </button>
      {open && <div className="px-4 py-3">{children}</div>}
    </div>
  )
}

function Labels({ labels }: { labels: Record<string, string> }) {
  const entries = Object.entries(labels ?? {})
  if (!entries.length) return <span className="text-surface-600">none</span>
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="bg-brand-500/10 text-brand-300 font-mono text-2xs px-1.5 py-0.5 rounded">{k}={v}</span>
      ))}
    </div>
  )
}

function Conditions({ conditions }: { conditions: any[] }) {
  if (!conditions?.length) return <span className="text-surface-600 text-2xs">none</span>
  return (
    <div className="space-y-1.5">
      {conditions.map((c, i) => (
        <div key={i} className="flex items-start gap-3 text-2xs">
          <span className={cn('w-14 flex-shrink-0 font-semibold',
            c.status === 'True' ? 'text-success' : c.status === 'False' ? 'text-danger' : 'text-warning'
          )}>{c.status}</span>
          <span className="text-surface-300 font-semibold w-36 flex-shrink-0">{c.type}</span>
          <span className="text-surface-500">{c.reason ?? ''}</span>
          {c.message && <span className="text-surface-600 truncate min-w-0" title={c.message}>{c.message}</span>}
        </div>
      ))}
    </div>
  )
}

function ContainerBlock({ c, runtimeStatus }: { c: any; runtimeStatus?: any }) {
  const [open, setOpen] = useState(true)
  const stateObj = runtimeStatus?.state ?? c.state ?? {}
  const stateKey = Object.keys(stateObj)[0] ?? 'unknown'
  const stateDetail = stateObj[stateKey] ?? {}

  return (
    <div className="border border-surface-800 rounded-lg mb-2 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 bg-surface-900/50 hover:bg-surface-800 text-left"
      >
        <span className="text-2xs font-semibold text-white font-mono">{c.name}</span>
        <div className="flex items-center gap-3">
          {runtimeStatus && (
            <span className={cn('text-2xs font-semibold capitalize',
              stateKey === 'running' ? 'text-success' : stateKey === 'terminated' ? 'text-danger' : 'text-warning'
            )}>{stateKey}</span>
          )}
          {open ? <ChevronDown className="w-3 h-3 text-surface-500" /> : <ChevronRight className="w-3 h-3 text-surface-500" />}
        </div>
      </button>
      {open && (
        <div className="px-3 py-2">
          <Row label="Image" value={<span className="font-mono">{c.image}</span>} />
          {c.imagePullPolicy && <Row label="Pull Policy" value={c.imagePullPolicy} />}
          {stateDetail.reason && <Row label="Reason" value={<span className="text-warning">{stateDetail.reason}</span>} />}
          {stateDetail.message && <Row label="Message" value={<span className="text-danger">{stateDetail.message}</span>} />}
          {stateDetail.exitCode !== undefined && (
            <Row label="Exit Code" value={
              <span className={stateDetail.exitCode === 0 ? 'text-success font-semibold' : 'text-danger font-semibold'}>{stateDetail.exitCode}</span>
            } />
          )}
          {runtimeStatus?.restartCount !== undefined && (
            <Row label="Restarts" value={
              <span className={runtimeStatus.restartCount > 5 ? 'text-danger font-bold' : runtimeStatus.restartCount > 0 ? 'text-warning' : 'text-surface-400'}>
                {runtimeStatus.restartCount}
              </span>
            } />
          )}
          {(c.ports ?? []).length > 0 && (
            <Row label="Ports" value={
              <div className="flex flex-wrap gap-1">
                {(c.ports ?? []).map((p: any, i: number) => (
                  <span key={i} className="font-mono bg-surface-800 px-1.5 py-0.5 rounded text-surface-300">
                    {p.containerPort}/{p.protocol ?? 'TCP'}{p.name ? ` (${p.name})` : ''}
                  </span>
                ))}
              </div>
            } />
          )}
          {(c.resources?.requests || c.resources?.limits) && (
            <Row label="Resources" value={
              <div className="space-y-0.5 font-mono">
                {c.resources.requests && <div className="text-surface-400">Req: cpu={c.resources.requests.cpu ?? '—'} mem={c.resources.requests.memory ?? '—'}</div>}
                {c.resources.limits && <div className="text-surface-400">Lim: cpu={c.resources.limits.cpu ?? '—'} mem={c.resources.limits.memory ?? '—'}</div>}
              </div>
            } />
          )}
          {(c.env ?? []).length > 0 && (
            <Row label={`Env (${c.env.length})`} value={
              <div className="space-y-0.5 max-h-32 overflow-y-auto font-mono">
                {(c.env ?? []).map((e: any, i: number) => (
                  <div key={i} className="text-surface-500">
                    <span className="text-brand-300">{e.name}</span>=
                    {e.value ?? (e.valueFrom?.fieldRef ? `fieldRef(${e.valueFrom.fieldRef.fieldPath})` : e.valueFrom ? '<ref>' : '—')}
                  </div>
                ))}
              </div>
            } />
          )}
          {(c.volumeMounts ?? []).length > 0 && (
            <Row label="Mounts" value={
              <div className="space-y-0.5 font-mono">
                {(c.volumeMounts ?? []).map((m: any, i: number) => (
                  <div key={i} className="text-surface-400">
                    {m.mountPath} <span className="text-surface-600">← {m.name}{m.readOnly ? ' (ro)' : ''}</span>
                  </div>
                ))}
              </div>
            } />
          )}
        </div>
      )}
    </div>
  )
}

function EventsTable({ events }: { events: any[] }) {
  if (!events.length) return <p className="text-2xs text-surface-600">No events recorded.</p>
  return (
    <div className="space-y-1.5">
      {events.map((e, i) => (
        <div key={i} className={cn(
          'rounded-lg px-3 py-2 text-2xs',
          e.type === 'Warning'
            ? 'bg-warning/5 border border-warning/20'
            : 'bg-surface-900 border border-surface-800'
        )}>
          <div className="flex items-center gap-2">
            {e.type === 'Warning'
              ? <AlertTriangle className="w-3 h-3 text-warning flex-shrink-0" />
              : <Info className="w-3 h-3 text-surface-500 flex-shrink-0" />}
            <span className={cn('font-semibold', e.type === 'Warning' ? 'text-warning' : 'text-surface-400')}>
              {e.reason}
            </span>
            <span className="text-surface-600 ml-auto tabular-nums">×{e.count} · {age(e.lastTime)}</span>
          </div>
          <p className="text-surface-400 pl-5 mt-0.5 leading-relaxed">{e.message}</p>
          {e.source && <p className="text-surface-600 pl-5 font-mono">{e.source}</p>}
        </div>
      ))}
    </div>
  )
}

export function DescribeViewer({ kind, namespace, name, onClose }: DescribeViewerProps) {
  const [resource, setResource] = useState<any>(null)
  const [events, setEvents] = useState<any[]>([])
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    setEventsError(null)
    const params = new URLSearchParams({ kind, namespace, name })
    try {
      const r = await fetch(`/api/k8s/describe?${params}`, { headers: getClusterHeaders() })
      const j = await r.json()
      if (j.error) { setError(j.error); return }
      setResource(j.resource)
      setEvents(j.events ?? [])
      if (j.eventsError) setEventsError(j.eventsError)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [kind, namespace, name])

  useEffect(() => { fetchData() }, [fetchData])

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify({ resource, events }, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const meta   = resource?.metadata ?? {}
  const spec   = resource?.spec ?? {}
  const status = resource?.status ?? {}

  const labels = meta.labels ?? {}
  // Filter out kubectl.io/last-applied which is very noisy
  const annotations = Object.fromEntries(
    Object.entries(meta.annotations ?? {}).filter(([k]) => !k.includes('last-applied-configuration'))
  )
  const hasWarnings = events.some(e => e.type === 'Warning')

  return (
    <div className="fixed inset-y-0 right-0 w-[760px] bg-surface-950 border-l border-surface-700 z-50 flex flex-col shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-800">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <FileSearch className="w-4 h-4 text-brand-400" />
            <span className="text-surface-400 font-normal text-xs">{kind}</span>
            <span className="font-mono">{name}</span>
          </h3>
          {namespace && (
            <p className="text-2xs text-surface-500 mt-0.5">namespace: <span className="font-mono">{namespace}</span></p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleCopy} className="flex items-center gap-1 text-2xs text-surface-400 hover:text-white px-2 py-1 rounded bg-surface-800 hover:bg-surface-700">
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />} Copy
          </button>
          <button onClick={fetchData} disabled={loading} className="flex items-center gap-1 text-2xs text-surface-400 hover:text-white px-2 py-1 rounded bg-surface-800 hover:bg-surface-700 disabled:opacity-40">
            <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} /> Refresh
          </button>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-700 text-surface-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && !resource && <p className="text-surface-500 text-2xs animate-pulse">Loading…</p>}
        {error && (
          <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-danger text-xs">{error}</div>
        )}

        {resource && (
          <>
            {/* ── Metadata ── */}
            <Section title="Metadata">
              <Row label="Name"      value={<span className="font-mono">{meta.name}</span>} />
              {namespace && <Row label="Namespace" value={<span className="font-mono">{meta.namespace}</span>} />}
              <Row label="Created" value={
                meta.creationTimestamp
                  ? `${new Date(meta.creationTimestamp).toLocaleString()} (${age(meta.creationTimestamp)} ago)`
                  : null
              } />
              <Row label="UID" value={<span className="font-mono text-surface-500">{meta.uid}</span>} />
              {Object.keys(labels).length > 0 && <Row label="Labels" value={<Labels labels={labels} />} />}
              {Object.keys(annotations).length > 0 && (
                <Row label={`Annotations (${Object.keys(annotations).length})`} value={
                  <div className="space-y-0.5 font-mono max-h-28 overflow-y-auto">
                    {Object.entries(annotations).map(([k, v]) => (
                      <div key={k} className="text-surface-500">
                        <span className="text-brand-300">{k}</span>=<span className="break-all">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                } />
              )}
            </Section>

            {/* ── Pod ── */}
            {kind === 'Pod' && (<>
              <Section title="Status">
                <Row label="Phase" value={
                  <span className={cn('font-semibold', status.phase === 'Running' ? 'text-success' : status.phase === 'Failed' ? 'text-danger' : 'text-warning')}>
                    {status.phase}
                  </span>
                } />
                <Row label="Pod IP"   value={<span className="font-mono">{status.podIP}</span>} />
                <Row label="Host IP"  value={<span className="font-mono">{status.hostIP}</span>} />
                <Row label="Node"     value={<span className="font-mono">{spec.nodeName}</span>} />
                <Row label="QoS"      value={status.qosClass} />
                <Row label="Service Account" value={<span className="font-mono">{spec.serviceAccountName}</span>} />
                {status.startTime && (
                  <Row label="Started" value={`${new Date(status.startTime).toLocaleString()} (${age(status.startTime)} ago)`} />
                )}
              </Section>

              {(status.conditions ?? []).length > 0 && (
                <Section title="Conditions">
                  <Conditions conditions={status.conditions} />
                </Section>
              )}

              {(spec.initContainers ?? []).length > 0 && (
                <Section title={`Init Containers (${spec.initContainers.length})`}>
                  {spec.initContainers.map((c: any) => {
                    const rs = (status.initContainerStatuses ?? []).find((s: any) => s.name === c.name)
                    return <ContainerBlock key={c.name} c={c} runtimeStatus={rs} />
                  })}
                </Section>
              )}

              {(spec.containers ?? []).length > 0 && (
                <Section title={`Containers (${spec.containers.length})`}>
                  {spec.containers.map((c: any) => {
                    const rs = (status.containerStatuses ?? []).find((s: any) => s.name === c.name)
                    return <ContainerBlock key={c.name} c={c} runtimeStatus={rs} />
                  })}
                </Section>
              )}

              {(spec.volumes ?? []).length > 0 && (
                <Section title={`Volumes (${spec.volumes.length})`} defaultOpen={false}>
                  <div className="space-y-1">
                    {spec.volumes.map((v: any, i: number) => (
                      <div key={i} className="flex items-center gap-3 text-2xs">
                        <span className="text-brand-300 font-mono w-36 flex-shrink-0">{v.name}</span>
                        <span className="text-surface-500">{Object.keys(v).filter(k => k !== 'name')[0] ?? 'unknown'}</span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {(spec.tolerations ?? []).length > 0 && (
                <Section title="Tolerations" defaultOpen={false}>
                  <div className="space-y-1 font-mono">
                    {spec.tolerations.map((t: any, i: number) => (
                      <div key={i} className="text-2xs text-surface-400">
                        {t.key ?? '*'}{t.operator ? ` ${t.operator}` : ''}{t.value ? `=${t.value}` : ''}{t.effect ? ` [${t.effect}]` : ''}
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </>)}

            {/* ── Deployment ── */}
            {kind === 'Deployment' && (<>
              <Section title="Spec">
                <Row label="Replicas" value={`${status.readyReplicas ?? 0} ready / ${status.availableReplicas ?? 0} available / ${spec.replicas ?? 1} desired`} />
                <Row label="Strategy" value={spec.strategy?.type} />
                {spec.strategy?.rollingUpdate && (
                  <Row label="Rolling Update" value={
                    `maxSurge: ${spec.strategy.rollingUpdate.maxSurge ?? '—'}  maxUnavailable: ${spec.strategy.rollingUpdate.maxUnavailable ?? '—'}`
                  } />
                )}
                <Row label="Selector" value={<Labels labels={spec.selector?.matchLabels ?? {}} />} />
                <Row label="Min Ready" value={spec.minReadySeconds ? `${spec.minReadySeconds}s` : null} />
                <Row label="Revision History" value={spec.revisionHistoryLimit != null ? String(spec.revisionHistoryLimit) : null} />
              </Section>

              {(status.conditions ?? []).length > 0 && (
                <Section title="Conditions">
                  <Conditions conditions={status.conditions} />
                </Section>
              )}

              {(spec.template?.spec?.initContainers ?? []).length > 0 && (
                <Section title={`Init Containers (${spec.template.spec.initContainers.length})`}>
                  {spec.template.spec.initContainers.map((c: any) => <ContainerBlock key={c.name} c={c} />)}
                </Section>
              )}

              {(spec.template?.spec?.containers ?? []).length > 0 && (
                <Section title={`Pod Template Containers (${spec.template.spec.containers.length})`}>
                  {spec.template.spec.containers.map((c: any) => <ContainerBlock key={c.name} c={c} />)}
                </Section>
              )}
            </>)}

            {/* ── Service ── */}
            {kind === 'Service' && (
              <Section title="Spec">
                <Row label="Type"       value={spec.type} />
                <Row label="Cluster IP" value={<span className="font-mono">{spec.clusterIP}</span>} />
                <Row label="Session Affinity" value={spec.sessionAffinity} />
                {(spec.externalIPs ?? []).length > 0 && (
                  <Row label="External IPs" value={<span className="font-mono">{spec.externalIPs.join(', ')}</span>} />
                )}
                <Row label="Selector" value={<Labels labels={spec.selector ?? {}} />} />
                {(spec.ports ?? []).length > 0 && (
                  <Row label="Ports" value={
                    <div className="flex flex-wrap gap-1">
                      {spec.ports.map((p: any, i: number) => (
                        <span key={i} className="font-mono bg-surface-800 px-1.5 py-0.5 rounded text-surface-300 text-2xs">
                          {p.name ? `${p.name}: ` : ''}{p.port}→{p.targetPort}/{p.protocol ?? 'TCP'}
                        </span>
                      ))}
                    </div>
                  } />
                )}
                {(status.loadBalancer?.ingress ?? []).length > 0 && (
                  <Row label="Load Balancer" value={
                    <span className="font-mono">{(status.loadBalancer.ingress ?? []).map((i: any) => i.ip ?? i.hostname).join(', ')}</span>
                  } />
                )}
              </Section>
            )}

            {/* ── Node ── */}
            {kind === 'Node' && (<>
              <Section title="Info">
                <Row label="Addresses" value={
                  <div className="space-y-0.5 font-mono">
                    {(status.addresses ?? []).map((a: any, i: number) => (
                      <div key={i} className="text-surface-300">{a.type}: {a.address}</div>
                    ))}
                  </div>
                } />
                {spec.unschedulable && <Row label="Cordoned" value={<span className="text-warning font-semibold">Yes (unschedulable)</span>} />}
                {status.nodeInfo && (<>
                  <Row label="OS"            value={`${status.nodeInfo.operatingSystem} / ${status.nodeInfo.architecture}`} />
                  <Row label="OS Image"      value={status.nodeInfo.osImage} />
                  <Row label="Kernel"        value={<span className="font-mono">{status.nodeInfo.kernelVersion}</span>} />
                  <Row label="Container Runtime" value={<span className="font-mono">{status.nodeInfo.containerRuntimeVersion}</span>} />
                  <Row label="Kubelet"       value={<span className="font-mono">{status.nodeInfo.kubeletVersion}</span>} />
                </>)}
              </Section>

              {(status.conditions ?? []).length > 0 && (
                <Section title="Conditions">
                  <Conditions conditions={status.conditions} />
                </Section>
              )}

              <Section title="Capacity" defaultOpen={false}>
                {Object.entries(status.capacity ?? {}).map(([k, v]) => (
                  <Row key={k} label={k} value={<span className="font-mono">{String(v)}</span>} />
                ))}
              </Section>

              <Section title="Allocatable" defaultOpen={false}>
                {Object.entries(status.allocatable ?? {}).map(([k, v]) => (
                  <Row key={k} label={k} value={<span className="font-mono">{String(v)}</span>} />
                ))}
              </Section>
            </>)}

            {/* ── StatefulSet / DaemonSet ── */}
            {(kind === 'StatefulSet' || kind === 'DaemonSet') && (<>
              <Section title="Status">
                {kind === 'StatefulSet' && <>
                  <Row label="Replicas" value={`${status.readyReplicas ?? 0} ready / ${status.currentReplicas ?? 0} current / ${spec.replicas ?? 1} desired`} />
                  <Row label="Update Revision" value={<span className="font-mono">{status.updateRevision}</span>} />
                </>}
                {kind === 'DaemonSet' && <>
                  <Row label="Desired"   value={String(status.desiredNumberScheduled ?? 0)} />
                  <Row label="Ready"     value={String(status.numberReady ?? 0)} />
                  <Row label="Available" value={String(status.numberAvailable ?? 0)} />
                </>}
                <Row label="Selector" value={<Labels labels={spec.selector?.matchLabels ?? {}} />} />
              </Section>

              {(spec.template?.spec?.containers ?? []).length > 0 && (
                <Section title={`Pod Template Containers (${spec.template.spec.containers.length})`}>
                  {spec.template.spec.containers.map((c: any) => <ContainerBlock key={c.name} c={c} />)}
                </Section>
              )}
            </>)}

            {/* ── Events (all kinds) ── */}
            <Section title={`Events (${events.length})`} defaultOpen={hasWarnings || events.length > 0}>
              {eventsError && (
                <p className="text-2xs text-warning mb-2 font-mono bg-warning/5 border border-warning/20 rounded px-2 py-1.5">
                  Events query error: {eventsError}
                </p>
              )}
              <EventsTable events={events} />
            </Section>
          </>
        )}
      </div>
    </div>
  )
}
