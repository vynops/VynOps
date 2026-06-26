import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()
  if (!K8S) return { items: [] }
  try {
    const r = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    })
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

async function promQuery(q: string) {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()
  if (!PROM) return {}
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(4000), next: { revalidate: 0 },
    })
    const j = r.ok ? await r.json() : null
    return (j?.data?.result ?? []) as any[]
  } catch { return [] }
}

const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const [cmData, deployData, stsData, dsData, hpaData, jobData, cronData, pdbData,
           podMetrics, cpuResults, memResults] = await Promise.all([
      k8sGet('/api/v1/configmaps'),
      k8sGet('/apis/apps/v1/deployments'),
      k8sGet('/apis/apps/v1/statefulsets'),
      k8sGet('/apis/apps/v1/daemonsets'),
      k8sGet('/apis/autoscaling/v2/horizontalpodautoscalers'),
      k8sGet('/apis/batch/v1/jobs'),
      k8sGet('/apis/batch/v1/cronjobs'),
      k8sGet('/apis/policy/v1/poddisruptionbudgets').catch(() => ({ items: [] })),
      k8sGet('/apis/metrics.k8s.io/v1beta1/pods').catch(() => ({ items: [] })),
      promQuery('sum by(namespace,pod)(rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[5m]))'),
      promQuery('sum by(namespace,pod)(container_memory_working_set_bytes{container!="POD",container!=""})'),
    ])

    // Build pod metrics map: "namespace/pod" -> { cpuCores, memBytes }
    const podMetricMap: Record<string, { cpuCores: number; memBytes: number }> = {}
    for (const item of (podMetrics.items ?? [])) {
      const key = `${item.metadata.namespace}/${item.metadata.name}`
      const containers = item.containers ?? []
      let cpuNano = 0, memBytes = 0
      for (const c of containers) {
        const cpu = c.usage?.cpu ?? '0'
        const mem = c.usage?.memory ?? '0'
        cpuNano  += cpu.endsWith('n')  ? parseInt(cpu) : cpu.endsWith('m') ? parseInt(cpu) * 1e6 : parseFloat(cpu) * 1e9
        memBytes += mem.endsWith('Ki') ? parseInt(mem) * 1024 : mem.endsWith('Mi') ? parseInt(mem) * 1024 * 1024 : mem.endsWith('Gi') ? parseInt(mem) * 1024 * 1024 * 1024 : parseInt(mem)
      }
      podMetricMap[key] = { cpuCores: cpuNano / 1e9, memBytes }
    }

    // Fallback: Prometheus pod CPU/mem map
    const promCpuMap: Record<string, number>  = {}
    const promMemMap: Record<string, number>  = {}
    for (const r of (cpuResults as any[])) promCpuMap[`${r.metric.namespace}/${r.metric.pod}`] = parseFloat(r.value?.[1] ?? '0')
    for (const r of (memResults as any[])) promMemMap[`${r.metric.namespace}/${r.metric.pod}`] = parseFloat(r.value?.[1] ?? '0')

    // Get pod list to find which pods belong to which deployment
    const podListData = await k8sGet('/api/v1/pods?limit=500').catch(() => ({ items: [] }))
    // Map: replicaset name -> deployment name
    const rsToDeployMap: Record<string, string> = {}
    // Map: namespace/deploymentName -> sum of cpu/mem
    const deployUsage: Record<string, { cpu: number; mem: number; pods: number }> = {}
    for (const pod of (podListData.items ?? [])) {
      const ns   = pod.metadata.namespace
      const refs = pod.metadata.ownerReferences ?? []
      const rsRef = refs.find((r: any) => r.kind === 'ReplicaSet')
      if (!rsRef) continue
      const podKey = `${ns}/${pod.metadata.name}`
      const cpu = podMetricMap[podKey]?.cpuCores ?? promCpuMap[podKey] ?? 0
      const mem = podMetricMap[podKey]?.memBytes  ?? promMemMap[podKey]  ?? 0
      // rsRef.name -> deployment: stored in cacheMap
      if (!rsToDeployMap[rsRef.name]) {
        const ownerDeploy = (pod.metadata.ownerReferences ?? []).find((or: any) => or.kind === 'ReplicaSet')
        if (ownerDeploy) rsToDeployMap[rsRef.name] = rsRef.name // placeholder; real mapping below
      }
      const deployRef = `${ns}/${rsRef.name}` // approximate; joined later
      if (!deployUsage[deployRef]) deployUsage[deployRef] = { cpu: 0, mem: 0, pods: 0 }
      deployUsage[deployRef].cpu  += cpu
      deployUsage[deployRef].mem  += mem
      deployUsage[deployRef].pods += 1
    }

    const configmaps = (cmData.items ?? [])
      .filter((cm: any) => !SYSTEM_NS.has(cm.metadata.namespace) ||
        !['kube-root-ca.crt', 'kubernetes'].includes(cm.metadata.name))
      .map((cm: any) => ({
        name: cm.metadata.name, namespace: cm.metadata.namespace,
        keys: Object.keys(cm.data ?? {}).length + Object.keys(cm.binaryData ?? {}).length,
        createdAt: cm.metadata.creationTimestamp,
      }))
      .sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    const deployments = (deployData.items ?? []).map((d: any) => {
      const ann = d.metadata?.annotations ?? {}
      const selector = d.spec?.selector?.matchLabels ?? {}
      const ctnrs = d.spec?.template?.spec?.containers ?? []
      // Sum metrics across pods matching this deployment's pods (via RS usage map)
      // We approximate by finding RS names that belong to this deployment in ownerRef
      let actualCpu = 0, actualMem = 0
      for (const [rsKey, usage] of Object.entries(deployUsage)) {
        // rsKey is "ns/rsName" -- we can't directly map without fetching RSes here
        // Use Prometheus pod metrics by namespace/podName from deployments pods
      }
      return {
        name: d.metadata.name, namespace: d.metadata.namespace,
        ready:       d.status?.readyReplicas       ?? 0,
        desired:     d.spec?.replicas              ?? 0,
        available:   d.status?.availableReplicas   ?? 0,
        updated:     d.status?.updatedReplicas     ?? 0,
        unavailable: d.status?.unavailableReplicas ?? 0,
        image:     ctnrs[0]?.image ?? '',
        containerCount: ctnrs.length,
        createdAt: d.metadata.creationTimestamp,
        strategy:  d.spec?.strategy?.type ?? 'RollingUpdate',
        labels:    d.metadata.labels ?? {},
        selector,
        rollingOut: (d.status?.updatedReplicas ?? 0) < (d.spec?.replicas ?? 0)
                 || (d.status?.unavailableReplicas ?? 0) > 0,
        helmRelease: ann['meta.helm.sh/release-name']      ?? null,
        helmChart:   ann['helm.sh/chart']                  ?? null,
        helmNs:      ann['meta.helm.sh/release-namespace'] ?? null,
        conditions: (d.status?.conditions ?? []).map((c: any) => ({
          type: c.type, status: c.status, reason: c.reason, message: c.message,
        })),
        containers: ctnrs.map((c: any) => ({
          name: c.name, image: c.image ?? '',
          cpuRequest: c.resources?.requests?.cpu,    cpuLimit: c.resources?.limits?.cpu,
          memRequest: c.resources?.requests?.memory,  memLimit: c.resources?.limits?.memory,
        })),
      }
    }).sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    // Aggregate pod metrics by deployment selector (using pod labels)
    const deployIndex: Record<string, { ns: string; selector: Record<string, string> }> = {}
    for (const d of deployments) deployIndex[`${d.namespace}/${d.name}`] = { ns: d.namespace, selector: d.selector }
    const deployMetrics: Record<string, { cpu: number; mem: number }> = {}
    for (const pod of (podListData.items ?? [])) {
      const ns     = pod.metadata.namespace
      const labels = pod.metadata.labels ?? {}
      const podKey = `${ns}/${pod.metadata.name}`
      const cpu    = podMetricMap[podKey]?.cpuCores ?? promCpuMap[podKey] ?? 0
      const mem    = podMetricMap[podKey]?.memBytes  ?? promMemMap[podKey]  ?? 0
      if (!cpu && !mem) continue
      for (const [dk, info] of Object.entries(deployIndex)) {
        if (info.ns !== ns) continue
        const sel = info.selector
        if (Object.keys(sel).length === 0) continue
        if (Object.entries(sel).every(([k, v]) => labels[k] === v)) {
          if (!deployMetrics[dk]) deployMetrics[dk] = { cpu: 0, mem: 0 }
          deployMetrics[dk].cpu += cpu
          deployMetrics[dk].mem += mem
        }
      }
    }
    // Attach actualCpu/actualMem to deployments
    for (const d of deployments as any[]) {
      const key = `${d.namespace}/${d.name}`
      d.actualCpuCores = deployMetrics[key]?.cpu ?? null
      d.actualMemBytes = deployMetrics[key]?.mem ?? null
    }

    // Build STS + DS selector indexes for pod metric aggregation
    const stsIndex: Record<string, { ns: string; selector: Record<string, string> }> = {}
    for (const s of (stsData.items ?? [])) {
      const key = `${s.metadata.namespace}/${s.metadata.name}`
      stsIndex[key] = { ns: s.metadata.namespace, selector: s.spec?.selector?.matchLabels ?? {} }
    }
    const dsIndex: Record<string, { ns: string; selector: Record<string, string> }> = {}
    for (const ds of (dsData.items ?? [])) {
      const key = `${ds.metadata.namespace}/${ds.metadata.name}`
      dsIndex[key] = { ns: ds.metadata.namespace, selector: ds.spec?.selector?.matchLabels ?? {} }
    }
    const stsMetrics: Record<string, { cpu: number; mem: number }> = {}
    const dsMetrics:  Record<string, { cpu: number; mem: number }> = {}
    for (const pod of (podListData.items ?? [])) {
      const ns     = pod.metadata.namespace
      const labels = pod.metadata.labels ?? {}
      const podKey = `${ns}/${pod.metadata.name}`
      const cpu    = podMetricMap[podKey]?.cpuCores ?? promCpuMap[podKey] ?? 0
      const mem    = podMetricMap[podKey]?.memBytes  ?? promMemMap[podKey]  ?? 0
      if (!cpu && !mem) continue
      for (const [sk, info] of Object.entries(stsIndex)) {
        if (info.ns !== ns) continue
        if (Object.keys(info.selector).length === 0) continue
        if (Object.entries(info.selector).every(([k, v]) => labels[k] === (v as string))) {
          if (!stsMetrics[sk]) stsMetrics[sk] = { cpu: 0, mem: 0 }
          stsMetrics[sk].cpu += cpu; stsMetrics[sk].mem += mem
        }
      }
      for (const [dk, info] of Object.entries(dsIndex)) {
        if (info.ns !== ns) continue
        if (Object.keys(info.selector).length === 0) continue
        if (Object.entries(info.selector).every(([k, v]) => labels[k] === (v as string))) {
          if (!dsMetrics[dk]) dsMetrics[dk] = { cpu: 0, mem: 0 }
          dsMetrics[dk].cpu += cpu; dsMetrics[dk].mem += mem
        }
      }
    }

    const statefulsets = (stsData.items ?? []).map((s: any) => ({
      name:      s.metadata.name,
      namespace: s.metadata.namespace,
      ready:     s.status?.readyReplicas ?? 0,
      desired:   s.spec?.replicas ?? 0,
      image:     s.spec?.template?.spec?.containers?.[0]?.image ?? '',
      createdAt: s.metadata.creationTimestamp,
      selector:  s.spec?.selector?.matchLabels ?? {},
      rollingOut: (s.status?.updatedReplicas ?? 0) < (s.spec?.replicas ?? 1),
      updateStrategy:       s.spec?.updateStrategy?.type ?? 'RollingUpdate',
      podManagementPolicy:  s.spec?.podManagementPolicy ?? 'OrderedReady',
      volumeClaimTemplates: (s.spec?.volumeClaimTemplates ?? []).length,
      currentRevision: s.status?.currentRevision ?? null,
      updateRevision:  s.status?.updateRevision  ?? null,
      actualCpuCores: stsMetrics[`${s.metadata.namespace}/${s.metadata.name}`]?.cpu ?? null,
      actualMemBytes:  stsMetrics[`${s.metadata.namespace}/${s.metadata.name}`]?.mem ?? null,
    })).sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    const daemonsets = (dsData.items ?? []).map((ds: any) => ({
      name:        ds.metadata.name,
      namespace:   ds.metadata.namespace,
      desired:     ds.status?.desiredNumberScheduled ?? 0,
      ready:       ds.status?.numberReady            ?? 0,
      available:   ds.status?.numberAvailable        ?? 0,
      unavailable: ds.status?.numberUnavailable       ?? 0,
      misscheduled:ds.status?.numberMisscheduled      ?? 0,
      image:       ds.spec?.template?.spec?.containers?.[0]?.image ?? '',
      createdAt:   ds.metadata.creationTimestamp,
      updateStrategy: ds.spec?.updateStrategy?.type ?? 'RollingUpdate',
      conditions: (ds.status?.conditions ?? []).map((c: any) => ({
        type: c.type, status: c.status, reason: c.reason, message: c.message,
      })),
      actualCpuCores: dsMetrics[`${ds.metadata.namespace}/${ds.metadata.name}`]?.cpu ?? null,
      actualMemBytes:  dsMetrics[`${ds.metadata.namespace}/${ds.metadata.name}`]?.mem ?? null,
    })).sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    const hpas = (hpaData.items ?? []).map((h: any) => {
      const specMetrics   = h.spec?.metrics ?? []
      const statusMetrics = h.status?.currentMetrics ?? []
      const metrics = specMetrics.map((sm: any) => {
        const cur = statusMetrics.find((cm: any) =>
          cm.type === sm.type &&
          cm.resource?.name === sm.resource?.name &&
          cm.pods?.metric?.name === sm.pods?.metric?.name
        )
        return {
          type:         sm.type,
          resourceName: sm.resource?.name ?? sm.pods?.metric?.name ?? sm.external?.metric?.name ?? sm.type,
          targetAverageUtilization:  sm.resource?.target?.averageUtilization ?? null,
          currentAverageUtilization: cur?.resource?.current?.averageUtilization ?? null,
          targetAverageValue:  sm.resource?.target?.averageValue ?? sm.pods?.target?.averageValue ?? null,
          currentAverageValue: cur?.resource?.current?.averageValue ?? cur?.pods?.current?.averageValue ?? null,
        }
      })
      return {
        name: h.metadata.name, namespace: h.metadata.namespace,
        targetKind:      h.spec?.scaleTargetRef?.kind ?? 'Deployment',
        targetName:      h.spec?.scaleTargetRef?.name ?? '',
        minReplicas:     h.spec?.minReplicas ?? 1, maxReplicas: h.spec?.maxReplicas ?? 10,
        currentReplicas: h.status?.currentReplicas ?? 0,
        desiredReplicas: h.status?.desiredReplicas  ?? 0,
        lastScaleTime:   h.status?.lastScaleTime    ?? null,
        metrics,
        conditions: (h.status?.conditions ?? []).map((c: any) => ({
          type: c.type, status: c.status, reason: c.reason,
        })),
      }
    })

    const jobs = (jobData.items ?? [])
      .filter((j: any) => !SYSTEM_NS.has(j.metadata.namespace))
      .map((j: any) => {
        const succ  = j.status?.succeeded  ?? 0
        const fail  = j.status?.failed     ?? 0
        const act   = j.status?.active     ?? 0
        const comp  = j.spec?.completions  ?? 1
        const start = j.status?.startTime
        const end   = j.status?.completionTime
        const durSec = start ? Math.round((new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) / 1000) : null
        return {
          name: j.metadata.name, namespace: j.metadata.namespace,
          status: succ >= comp ? 'Complete' : fail > 0 ? 'Failed' : 'Running',
          succeeded: succ, failed: fail, active: act, completions: comp,
          backoffLimit: j.spec?.backoffLimit ?? null,
          image:     j.spec?.template?.spec?.containers?.[0]?.image ?? '',
          startTime: start, completionTime: end, durationSec: durSec,
          ownerKind: j.metadata.ownerReferences?.[0]?.kind ?? null,
          ownerName: j.metadata.ownerReferences?.[0]?.name ?? null,
        }
      })
      .sort((a: any, b: any) => new Date(b.startTime ?? 0).getTime() - new Date(a.startTime ?? 0).getTime())
      .slice(0, 30)

    const cronJobs = (cronData.items ?? [])
      .filter((c: any) => !SYSTEM_NS.has(c.metadata.namespace))
      .map((c: any) => ({
        name: c.metadata.name, namespace: c.metadata.namespace,
        schedule: c.spec?.schedule ?? '',
        lastSchedule: c.status?.lastScheduleTime ?? null,
        active: (c.status?.active ?? []).length,
        suspended: c.spec?.suspend ?? false,
        image: c.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]?.image ?? '',
        createdAt: c.metadata.creationTimestamp,
        concurrencyPolicy: c.spec?.concurrencyPolicy ?? 'Allow',
      }))
      .sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    const pdbs = (pdbData.items ?? [])
      .filter((p: any) => !SYSTEM_NS.has(p.metadata.namespace))
      .map((p: any) => ({
        name:                p.metadata.name,
        namespace:           p.metadata.namespace,
        minAvailable:        p.spec?.minAvailable        ?? null,
        maxUnavailable:      p.spec?.maxUnavailable      ?? null,
        currentHealthy:      p.status?.currentHealthy    ?? 0,
        desiredHealthy:      p.status?.desiredHealthy    ?? 0,
        expectedPods:        p.status?.expectedPods      ?? 0,
        disruptionsAllowed:  p.status?.disruptionsAllowed ?? 0,
        selector:            p.spec?.selector?.matchLabels ?? {},
      }))
      .sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    return NextResponse.json({ configmaps, deployments, statefulsets, daemonsets, hpas, jobs, cronJobs, pdbs })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}