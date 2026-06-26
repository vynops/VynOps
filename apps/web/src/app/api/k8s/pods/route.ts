import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

export const dynamic = 'force-dynamic'


function formatProbe(p: any): string {
  if (!p) return ''
  if (p.httpGet) return `HTTP GET :${p.httpGet.port}${p.httpGet.path ?? ''}`
  if (p.tcpSocket) return `TCP :${p.tcpSocket.port}`
  if (p.exec) return `exec: ${(p.exec.command ?? []).join(' ')}`
  return 'configured'
}

function labelsMatch(selector: Record<string, string>, podLabels: Record<string, string>): boolean {
  return Object.entries(selector).every(([k, v]) => podLabels[k] === v)
}

async function k8sGet(path: string): Promise<any> {
  const K8S  = await resolveK8sUrl()
  if (!K8S) throw new Error('K8S_API_URL not configured')
  const r = await fetch(`${K8S}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    next: { revalidate: 0 },
  })
  if (!r.ok) throw new Error(`K8s API returned ${r.status} for ${path}`)
  return r.json()
}

// Optional fetch — returns fallback on any error (for enrichment-only APIs like PDBs)
async function k8sGetOpt(path: string): Promise<any> {
  try { return await k8sGet(path) } catch { return { items: [] } }
}

async function promResults(query: string): Promise<any[]> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    const j = await r.json()
    return j.data?.result ?? []
  } catch { return [] }
}

function buildContainer(c: any, cs: any | undefined, isInit = false) {
  const state: 'running' | 'waiting' | 'terminated' =
    cs?.state?.running ? 'running' : cs?.state?.terminated ? 'terminated' : 'waiting'
  const lastTermReason: string | undefined = cs?.lastState?.terminated?.reason
  const curTermReason:  string | undefined = cs?.state?.terminated?.reason
  return {
    name: c.name,
    image: c.image ?? '',
    ready:    cs?.ready   ?? false,
    started:  cs?.started ?? false,
    restarts: cs?.restartCount ?? 0,
    state,
    stateReason: cs?.state?.waiting?.reason ?? curTermReason,
    lastTerminatedReason: lastTermReason,  // e.g. "OOMKilled"
    isInit,
    cpuRequest:  c.resources?.requests?.cpu,
    cpuLimit:    c.resources?.limits?.cpu,
    memRequest:  c.resources?.requests?.memory,
    memLimit:    c.resources?.limits?.memory,
    ports: (c.ports ?? []).map((p: any) => ({
      name: p.name,
      containerPort: p.containerPort,
      protocol: p.protocol ?? 'TCP',
    })),
    env: (c.env ?? []).slice(0, 20).map((e: any) => ({
      name: e.name,
      value: e.value,
      valueFrom: e.valueFrom ? Object.keys(e.valueFrom)[0] : undefined,
    })),
    volumeMounts: (c.volumeMounts ?? []).map((v: any) => ({
      name: v.name,
      mountPath: v.mountPath,
      readOnly: v.readOnly ?? false,
    })),
    livenessProbe:  formatProbe(c.livenessProbe),
    readinessProbe: formatProbe(c.readinessProbe),
    startupProbe:   formatProbe(c.startupProbe),
  }
}

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const [podsData, pdbsData, failSchedEvents, restartSpikes, podCpuResults, podMemResults] = await Promise.all([
      k8sGet('/api/v1/pods'),
      k8sGetOpt('/apis/policy/v1/poddisruptionbudgets'),
      k8sGetOpt('/api/v1/events?fieldSelector=reason=FailedScheduling'),
      promResults('round(increase(kube_pod_container_status_restarts_total[10m]),1)'),
      promResults('sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[2m])) by (pod, namespace)'),
      promResults('sum(container_memory_working_set_bytes{container!="",container!="POD"}) by (pod, namespace)'),
    ])

    // Build PDB lookup: namespace -> list of {name, selector, status}
    const pdbsByNs: Record<string, { name: string; selector: Record<string, string>; minAvailable?: number | string; maxUnavailable?: number | string; currentHealthy: number; desiredHealthy: number }[]> = {}
    for (const pdb of (pdbsData.items ?? [])) {
      const ns = pdb.metadata?.namespace ?? 'default'
      if (!pdbsByNs[ns]) pdbsByNs[ns] = []
      pdbsByNs[ns].push({
        name:          pdb.metadata.name,
        selector:      pdb.spec?.selector?.matchLabels ?? {},
        minAvailable:  pdb.spec?.minAvailable,
        maxUnavailable: pdb.spec?.maxUnavailable,
        currentHealthy: pdb.status?.currentHealthy ?? 0,
        desiredHealthy: pdb.status?.desiredHealthy ?? 0,
      })
    }

    // Build FailedScheduling reason lookup: namespace/pod -> message
    const schedFailMap: Record<string, string> = {}
    for (const ev of (failSchedEvents.items ?? [])) {
      const podNs   = ev.involvedObject?.namespace ?? ''
      const podName = ev.involvedObject?.name ?? ''
      schedFailMap[`${podNs}/${podName}`] = ev.message ?? ''
    }

    // Build restart spike lookup: namespace/pod -> max spike
    const spikeMap: Record<string, number> = {}
    for (const r of restartSpikes) {
      const pod = r.metric?.pod ?? ''
      const ns  = r.metric?.namespace ?? ''
      const v   = parseFloat(r.value?.[1] ?? '0')
      if (v > 0) {
        const key = `${ns}/${pod}`
        spikeMap[key] = Math.max(spikeMap[key] ?? 0, v)
      }
    }

    // Build per-pod CPU / memory usage lookups from Prometheus
    const cpuUsageMap: Record<string, number> = {}
    for (const r of podCpuResults) {
      const key = `${r.metric?.namespace ?? ''}/${r.metric?.pod ?? ''}`
      const v   = parseFloat(r.value?.[1] ?? '0')
      if (!isNaN(v)) cpuUsageMap[key] = v
    }
    const memUsageMap: Record<string, number> = {}
    for (const r of podMemResults) {
      const key = `${r.metric?.namespace ?? ''}/${r.metric?.pod ?? ''}`
      const v   = parseFloat(r.value?.[1] ?? '0')
      if (!isNaN(v)) memUsageMap[key] = v
    }

    const podsByNode: Record<string, any[]> = {}
    const pods: any[] = []

    for (const pod of (podsData.items ?? [])) {
      const nodeName: string          = pod.spec?.nodeName ?? '__unscheduled__'
      const podNs: string             = pod.metadata.namespace ?? ''
      const podName: string           = pod.metadata.name ?? ''
      const podLabels: Record<string, string> = pod.metadata.labels ?? {}
      const containerStatuses: any[]  = pod.status?.containerStatuses ?? []
      const initStatuses: any[]       = pod.status?.initContainerStatuses ?? []
      const allStatuses               = [...containerStatuses, ...initStatuses]

      const totalContainers = pod.spec?.containers?.length ?? 0
      const readyCount      = containerStatuses.filter((c: any) => c.ready).length
      const restarts        = allStatuses.reduce((sum: number, c: any) => sum + (c.restartCount ?? 0), 0)

      // ── Status detection (OOMKilled > waiting reason > phase) ─────────────
      const phase: string  = pod.status?.phase  ?? 'Unknown'
      const podReason: string | undefined = pod.status?.reason  // e.g. 'Evicted'
      let status = phase
      if (podReason === 'Evicted') status = 'Evicted'
      else if (phase === 'Running') {
        const allReady = containerStatuses.length > 0 && containerStatuses.every((c: any) => c.ready)
        if (!allReady) status = 'Degraded'
      }
      // Check current terminated reason first (OOMKilled takes priority)
      let oomKilled = false
      for (const cs of containerStatuses) {
        if (cs.state?.terminated?.reason === 'OOMKilled' || cs.lastState?.terminated?.reason === 'OOMKilled') {
          oomKilled = true
          break
        }
      }
      if (oomKilled) {
        status = 'OOMKilled'
      } else {
        for (const cs of containerStatuses) {
          if (cs.state?.waiting?.reason) { status = cs.state.waiting.reason; break }
        }
        // Fallback: if still Degraded and container is in terminated state mid-crash
        if (status === 'Degraded') {
          for (const cs of containerStatuses) {
            if (cs.state?.terminated) {
              // restartCount > 0 + terminated → caught between CrashLoop cycles
              status = cs.restartCount > 0 ? 'CrashLoopBackOff' : (cs.state.terminated.reason ?? 'Error')
              break
            }
          }
        }
      }

      // ── Init container failures ────────────────────────────────────────────
      for (const is of initStatuses) {
        if (is.state?.waiting?.reason && is.state.waiting.reason !== 'PodInitializing') {
          if (status === 'Running' || status === 'Pending') status = `Init:${is.state.waiting.reason}`
          break
        }
      }

      // ── PDB coverage ──────────────────────────────────────────────────────
      const matchedPdb = (pdbsByNs[podNs] ?? []).find(pdb =>
        Object.keys(pdb.selector).length > 0 && labelsMatch(pdb.selector, podLabels)
      )

      // ── Build container lists ─────────────────────────────────────────────
      const containers = (pod.spec?.containers ?? []).map((c: any) => {
        const cs = containerStatuses.find((s: any) => s.name === c.name)
        return buildContainer(c, cs, false)
      })

      const initContainers = (pod.spec?.initContainers ?? []).map((c: any) => {
        const cs = initStatuses.find((s: any) => s.name === c.name)
        return buildContainer(c, cs, true)
      })

      // ── Scheduling failure reason ─────────────────────────────────────────
      const schedulingFailureReason = phase === 'Pending'
        ? (schedFailMap[`${podNs}/${podName}`] ?? null)
        : null

      // ── Restart spike (restarts in last 10 min) ───────────────────────────
      const restartsLast10m = spikeMap[`${podNs}/${podName}`] ?? 0

      // ── Topology: node → zone (no zones in k3d, fallback to node) ─────────
      const nodeZone = nodeName // will be enriched client-side if needed

      const podObj = {
        name: podName,
        namespace: podNs,
        status,
        oomKilled,
        ready:    `${readyCount}/${totalContainers}`,
        restarts,
        restartsLast10m,
        age:      pod.metadata.creationTimestamp,
        nodeName,
        nodeZone,
        containers,
        initContainers,
        labels:   podLabels,
        podIP:    pod.status?.podIP,
        qosClass: pod.status?.qosClass,
        pdbName:  matchedPdb?.name ?? null,
        schedulingFailureReason,
        topologySpreadConstraints: (pod.spec?.topologySpreadConstraints ?? []).map((t: any) => ({
          maxSkew:           t.maxSkew,
          topologyKey:       t.topologyKey,
          whenUnsatisfiable: t.whenUnsatisfiable,
          labelSelector:     t.labelSelector?.matchLabels,
        })),
        reason: podReason,
        conditions: (pod.status?.conditions ?? []).map((c: any) => ({
          type:               c.type,
          status:             c.status,
          reason:             c.reason,
          message:            c.message,
          lastTransitionTime: c.lastTransitionTime,
        })),
        cpuUsageCores: cpuUsageMap[`${podNs}/${podName}`] ?? null,
        memUsageBytes: memUsageMap[`${podNs}/${podName}`] ?? null,
        tolerations: (pod.spec?.tolerations ?? []).map((t: any) => ({
          key:      t.key,
          operator: t.operator ?? 'Equal',
          value:    t.value,
          effect:   t.effect,
        })),
        nodeSelector: pod.spec?.nodeSelector ?? null,
      }

      if (!podsByNode[nodeName]) podsByNode[nodeName] = []
      podsByNode[nodeName].push(podObj)
      pods.push(podObj)
    }

    for (const nodeName of Object.keys(podsByNode)) {
      podsByNode[nodeName].sort((a, b) => {
        if (a.status === 'Running' && b.status !== 'Running') return -1
        if (a.status !== 'Running' && b.status === 'Running') return 1
        return a.name.localeCompare(b.name)
      })
    }

    pods.sort((a, b) => {
      if (a.status === 'Running' && b.status !== 'Running') return -1
      if (a.status !== 'Running' && b.status === 'Running') return 1
      return a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)
    })

    return NextResponse.json({ podsByNode, pods })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const isConnErr = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('abort')
    return NextResponse.json(
      { error: isConnErr ? `Cannot reach kubectl proxy at ${K8S}: ${msg}` : msg, pods: [], podsByNode: {} },
      { status: isConnErr ? 503 : 502 }
    )
  }
}