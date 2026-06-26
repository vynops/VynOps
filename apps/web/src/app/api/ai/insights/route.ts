import { NextResponse } from 'next/server'
import { readConfig as readRuntimeConfig, appendNotifLog } from '@/app/api/settings/config/shared'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

const SLACK = (process.env.SLACK_WEBHOOK_URL      ?? '')
const PD_KEY= (process.env.PAGERDUTY_ROUTING_KEY  ?? '')

// Module-level cooldown tracker (in-process, resets on server restart)
// key = event type + optional fingerprint?
const notifCooldown = new Map<string, number>()
function shouldFire(key: string, cooldownMs: number): boolean {
  const last = notifCooldown.get(key) ?? 0
  if (Date.now() - last < cooldownMs) return false
  notifCooldown.set(key, Date.now())
  return true
}

// Known false-positive alerts on k3d/k3s (control plane not scrape-able)
const K3D_FALSE_POSITIVES = new Set(['KubeControllerManagerDown', 'KubeProxyDown', 'KubeSchedulerDown', 'KubeEtcdDown'])

async function slackNotify(text: string, fields?: { title: string; value: string }[]) {
  if (!SLACK) return
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text } }]
  if (fields?.length) {
    blocks.push({ type: 'section', fields: fields.map(f => ({ type: 'mrkdwn', text: `*${f.title}*\n${f.value}` })) })
  }
  try {
    await fetch(SLACK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocks }), signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
  } catch { /* non-critical */ }
}

async function pdNotify(summary: string, severity: 'critical' | 'error' | 'warning' | 'info' = 'critical') {
  if (!PD_KEY) return
  try {
    await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routing_key:  PD_KEY,
        event_action: 'trigger',
        dedup_key:    `vynops-${Date.now()}`,
        payload: { summary, severity, source: 'VynOps Insights' },
      }),
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
  } catch { /* non-critical */ }
}

async function k8s(path: string) {
  const K8S = await resolveK8sUrl()
  if (!K8S) return null
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), cache: 'no-store' })
    return r.ok ? r.json() : null
  } catch { return null }
}

async function prom(path: string) {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), cache: 'no-store' })
    return r.ok ? r.json() : null
  } catch { return null }
}

async function promQ(q: string): Promise<number> {
  const j = await prom(`/api/v1/query?query=${encodeURIComponent(q)}`)
  return parseFloat(j?.data?.result?.[0]?.value?.[1] ?? '0') || 0
}

async function promQAll(q: string): Promise<{ metric: Record<string, string>; value: number }[]> {
  const j = await prom(`/api/v1/query?query=${encodeURIComponent(q)}`)
  return (j?.data?.result ?? []).map((x: any) => ({ metric: x.metric, value: parseFloat(x.value[1]) }))
}

export async function GET() {
  const [
    nodeData, podData, deployData, alertData, eventData,
    cpuVal, memVal, diskVal,
    restartTrend, oomData, cpuThrottle, memPressure,
  ] = await Promise.all([
    k8s('/api/v1/nodes'),
    k8s('/api/v1/pods'),
    k8s('/apis/apps/v1/deployments'),
    prom('/api/v1/alerts'),
    k8s('/api/v1/events?fieldSelector=type=Warning&limit=50'),
    promQ('sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100'),
    promQ('(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100'),
    promQ('(1 - avg(node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) * 100'),
    promQAll('topk(5, increase(kube_pod_container_status_restarts_total[6h]))'),
    promQAll('kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}'),
    promQAll('topk(5, rate(container_cpu_cfs_throttled_seconds_total{container!=""}[5m]) / rate(container_cpu_cfs_periods_total{container!=""}[5m]) * 100)'),
    promQAll('topk(5, container_memory_working_set_bytes{container!=""} / container_spec_memory_limit_bytes{container!=""} * 100 > 85)'),
  ])

  const nodes       = nodeData?.items ?? []
  const pods        = podData?.items  ?? []
  const deploys     = deployData?.items ?? []
  const firingAlerts = (alertData?.data?.alerts ?? []).filter((a: any) => a.state === 'firing')

  const readyNodes   = nodes.filter((n: any) => n.status?.conditions?.find((c: any) => c.type === 'Ready' && c.status === 'True'))
  const crashLoops   = pods.filter((p: any) => p.status?.containerStatuses?.some((c: any) => c.state?.waiting?.reason === 'CrashLoopBackOff'))
  const failedPods   = pods.filter((p: any) => p.status?.phase === 'Failed')
  const pendingPods  = pods.filter((p: any) => p.status?.phase === 'Pending')
  const oomPods      = pods.filter((p: any) => p.status?.containerStatuses?.some((c: any) => c.lastState?.terminated?.reason === 'OOMKilled'))
  const degradedDeps = deploys.filter((d: any) => (d.status?.readyReplicas ?? 0) < (d.spec?.replicas ?? 1))

  const insights: any[] = []
  let idCounter = 1
  const id = () => `ins-${idCounter++}`

  // ?? Prediction insights ?????????????????????????????????????????????????
  for (const r of restartTrend) {
    if (r.value > 5) {
      insights.push({
        id: id(), kind: 'prediction', severity: r.value > 15 ? 'critical' : 'high',
        title: `High restart rate: ${r.metric.pod ?? r.metric.container ?? 'unknown'}`,
        summary: `${r.value.toFixed(0)} restarts in 6h ? failure imminent without intervention`,
        confidence: Math.min(95, Math.round(40 + r.value * 4)),
        metric: `${r.value.toFixed(0)} restarts`,
        evidence: [`Container: ${r.metric.container ?? '?'}`, `Namespace: ${r.metric.namespace ?? '?'}`, `Rate: ${r.value.toFixed(0)} restarts/6h`],
        suggestedAction: 'Investigate logs and recent deployments',
        suggestedPrompt: `Correlate pod issue for ${r.metric.pod ?? 'pod'} in namespace ${r.metric.namespace ?? 'default'} ? high restart rate detected`,
      })
    }
  }

  for (const r of oomData) {
    if (r.value > 0) {
      insights.push({
        id: id(), kind: 'prediction', severity: 'high',
        title: `OOMKilled: ${r.metric.pod ?? 'unknown pod'}`,
        summary: 'Container was killed by OOM ? will repeat unless memory limit increased',
        confidence: 87,
        metric: 'OOMKilled',
        evidence: [`Namespace: ${r.metric.namespace ?? '?'}`, `Container: ${r.metric.container ?? '?'}`, 'Last termination: OOMKilled'],
        suggestedAction: 'Increase memory limit or investigate memory leak',
        suggestedPrompt: `Recommend memory right-sizing and explain OOMKill for ${r.metric.pod ?? 'pod'} in ${r.metric.namespace ?? 'default'}`,
      })
    }
  }

  if (cpuVal > 78) {
    insights.push({
      id: id(), kind: 'prediction', severity: cpuVal > 90 ? 'critical' : 'high',
      title: `Cluster CPU at ${cpuVal.toFixed(1)}% ? capacity risk`,
      summary: `At this rate, CPU saturation will impact scheduling and latency within hours`,
      confidence: 82, metric: `${cpuVal.toFixed(1)}%`,
      evidence: [`Cluster CPU: ${cpuVal.toFixed(1)}%`, 'Threshold: 80%', 'Risk: scheduling delays, throttling'],
      suggestedAction: 'Scale workloads or add nodes',
      suggestedPrompt: 'Forecast CPU capacity exhaustion and recommend scaling actions',
    })
  }

  if (memVal > 80) {
    insights.push({
      id: id(), kind: 'prediction', severity: memVal > 90 ? 'critical' : 'high',
      title: `Memory pressure at ${memVal.toFixed(1)}% ? OOM eviction risk`,
      summary: 'High memory utilisation increases risk of pod evictions and OOM kills cluster-wide',
      confidence: 78, metric: `${memVal.toFixed(1)}%`,
      evidence: [`Cluster memory: ${memVal.toFixed(1)}%`, 'Risk: OOM evictions, cascading failures'],
      suggestedPrompt: 'Predict memory exhaustion timeline and identify top memory consumers',
    })
  }

  // ?? RCA insights ????????????????????????????????????????????????????????
  for (const p of crashLoops.slice(0, 3)) {
    const ns = p.metadata.namespace
    const name = p.metadata.name
    insights.push({
      id: id(), kind: 'rca', severity: 'critical',
      title: `CrashLoopBackOff: ${name}`,
      summary: `Pod in ${ns} is crash-looping ? active incident requires immediate investigation`,
      confidence: 95, metric: 'CrashLoop',
      evidence: [`Namespace: ${ns}`, `Node: ${p.spec?.nodeName ?? 'unknown'}`, 'Status: CrashLoopBackOff'],
      suggestedAction: 'Run multi-layer RCA to identify root cause',
      suggestedPrompt: `Run 7-layer causal analysis for CrashLoopBackOff pod ${name} in namespace ${ns}`,
    })
  }

  const criticalAlerts = firingAlerts.filter((a: any) => a.labels?.severity === 'critical')
  const realCritical    = criticalAlerts.filter((a: any) => !K3D_FALSE_POSITIVES.has(a.labels?.alertname ?? ''))
  const falsePosAlerts  = criticalAlerts.filter((a: any) =>  K3D_FALSE_POSITIVES.has(a.labels?.alertname ?? ''))
  if (realCritical.length > 0) {
    insights.push({
      id: id(), kind: 'rca', severity: 'critical',
      title: `${realCritical.length} critical Prometheus alert(s) firing`,
      summary: realCritical.slice(0, 2).map((a: any) => a.labels?.alertname).join(', '),
      confidence: 99, metric: `${realCritical.length} alerts`,
      evidence: realCritical.slice(0, 3).map((a: any) => `${a.labels?.alertname}: ${a.annotations?.summary ?? ''}`),
      suggestedAction: 'Investigate root cause and generate remediation workflow',
      suggestedPrompt: `Investigate the ${realCritical.length} firing critical alerts and perform multi-layer RCA`,
    })
  }
  if (falsePosAlerts.length > 0) {
    insights.push({
      id: id(), kind: 'rca', severity: 'info',
      title: `${falsePosAlerts.length} k3d false-positive alert(s) ? safe to silence`,
      summary: falsePosAlerts.map((a: any) => a.labels?.alertname).join(', '),
      confidence: 99, metric: `${falsePosAlerts.length} alerts`,
      evidence: [
        'These alerts fire on k3d/k3s because the control-plane components are embedded and not scrape-able by Prometheus.',
        'This is expected behavior ? not a real incident.',
        'Silence them: ask the AI copilot to ?silence KubeControllerManagerDown for 30 days?',
      ],
      suggestedAction: 'Silence these alerts ? they are k3d false positives',
      suggestedPrompt: `Silence the k3d false-positive alerts: ${falsePosAlerts.map((a: any) => a.labels?.alertname).join(', ')}`,
    })
  }

  if (readyNodes.length < nodes.length) {
    const notReady = nodes.length - readyNodes.length
    insights.push({
      id: id(), kind: 'rca', severity: 'critical',
      title: `${notReady} node(s) NotReady ? infrastructure failure`,
      summary: 'Node failures are the most common root cause of cascading pod and service failures',
      confidence: 99, metric: `${notReady} NotReady`,
      evidence: [`Total nodes: ${nodes.length}`, `Ready: ${readyNodes.length}`, `NotReady: ${notReady}`],
      suggestedPrompt: `Perform full infrastructure RCA for the ${notReady} NotReady node(s) ? identify root cause and blast radius`,
    })
  }

  // ?? Optimization insights ????????????????????????????????????????????????
  for (const r of cpuThrottle) {
    if (r.value > 50) {
      insights.push({
        id: id(), kind: 'optimization', severity: 'medium',
        title: `CPU throttling: ${r.metric.container ?? r.metric.pod ?? 'container'} at ${r.value.toFixed(0)}%`,
        summary: 'Severe CPU throttling degrading performance ? CPU limit may be too low',
        confidence: 88, metric: `${r.value.toFixed(0)}% throttled`,
        evidence: [`Throttle rate: ${r.value.toFixed(1)}%`, `Pod: ${r.metric.pod ?? '?'}`, `Namespace: ${r.metric.namespace ?? '?'}`],
        suggestedPrompt: `Recommend CPU limit right-sizing for ${r.metric.pod ?? 'pod'} in ${r.metric.namespace ?? 'default'} ? ${r.value.toFixed(0)}% throttled`,
      })
    }
  }

  if (diskVal > 70) {
    insights.push({
      id: id(), kind: 'optimization', severity: diskVal > 85 ? 'high' : 'medium',
      title: `Disk usage at ${diskVal.toFixed(1)}% ? storage optimization needed`,
      summary: 'High disk utilisation detected. Clean old images, compact logs, or expand PVCs',
      confidence: 91, metric: `${diskVal.toFixed(1)}%`,
      evidence: [`Avg disk usage: ${diskVal.toFixed(1)}%`, 'Risk: disk full causes pod evictions'],
      suggestedPrompt: 'Identify which pods are consuming the most disk space and recommend cleanup actions',
    })
  }

  // ?? Security insights ???????????????????????????????????????????????????
  const privPods = pods.filter((p: any) =>
    p.spec?.containers?.some((c: any) => c.securityContext?.privileged === true),
  )
  if (privPods.length > 0) {
    insights.push({
      id: id(), kind: 'security', severity: 'high',
      title: `${privPods.length} container(s) running privileged`,
      summary: 'Privileged containers can escape to host ? critical security misconfiguration',
      confidence: 99, metric: `${privPods.length} privileged`,
      evidence: privPods.slice(0, 3).map((p: any) => `${p.metadata.namespace}/${p.metadata.name}`),
      suggestedPrompt: 'Run a full cluster security scan and identify all privilege escalation risks',
    })
  }

  const noLimitPods = pods.filter((p: any) =>
    p.spec?.containers?.some((c: any) => !c.resources?.limits?.cpu || !c.resources?.limits?.memory),
  )
  if (noLimitPods.length > 5) {
    insights.push({
      id: id(), kind: 'security', severity: 'medium',
      title: `${noLimitPods.length} pods without resource limits`,
      summary: 'Missing limits enable noisy-neighbour OOM and CPU saturation attacks',
      confidence: 99, metric: `${noLimitPods.length} pods`,
      evidence: [`${noLimitPods.length} pods lack CPU/memory limits`, 'Risk: resource exhaustion by single workload'],
      suggestedPrompt: 'Scan the cluster for security misconfigurations and generate remediation plan with YAML patches',
    })
  }

  // ?? Autonomous insights ?????????????????????????????????????????????????
  if (degradedDeps.length > 0) {
    insights.push({
      id: id(), kind: 'autonomous', severity: degradedDeps.length > 3 ? 'critical' : 'high',
      title: `${degradedDeps.length} deployment(s) below desired replicas`,
      summary: 'Workloads running under capacity. Auto-remediation workflow can restore availability.',
      confidence: 96, metric: `${degradedDeps.length} degraded`,
      evidence: degradedDeps.slice(0, 3).map((d: any) =>
        `${d.metadata.namespace}/${d.metadata.name}: ${d.status?.readyReplicas ?? 0}/${d.spec?.replicas} ready`,
      ),
      suggestedAction: 'Generate autonomous remediation workflow',
      suggestedPrompt: `Generate an autonomous remediation workflow for the ${degradedDeps.length} degraded deployment(s) ? step by step with approval gates`,
    })
  }

  // Sort: critical first, then by confidence
  insights.sort((a, b) => {
    const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const s = (sevOrder[a.severity] ?? 4) - (sevOrder[b.severity] ?? 4)
    return s !== 0 ? s : b.confidence - a.confidence
  })

  const cluster = {
    name:         'k3d-vynops',
    nodes:        nodes.length,
    notReady:     nodes.length - readyNodes.length,
    pods:         pods.length,
    running:      pods.filter((p: any) => p.status?.phase === 'Running').length,
    failed:       failedPods.length,
    crashLoop:    crashLoops.length,
    pending:      pendingPods.length,
    oomKilled:    oomPods.length,
    firingAlerts: firingAlerts.length,
    criticalAlerts: criticalAlerts.length,
    cpu:          `${cpuVal.toFixed(1)}%`,
    memory:       `${memVal.toFixed(1)}%`,
    disk:         `${diskVal.toFixed(1)}%`,
    degradedDeploys: degradedDeps.length,
    healthScore:  Math.max(0, Math.min(100, Math.round(
      100
      - (nodes.length - readyNodes.length) * 20
      - crashLoops.length * 8
      - failedPods.length * 3
      - (cpuVal > 85 ? 15 : cpuVal > 70 ? 7 : 0)
      - (memVal > 85 ? 15 : memVal > 70 ? 7 : 0)
      - criticalAlerts.length * 10,
    ))),
  }

  const counts = {
    prediction:   insights.filter(i => i.kind === 'prediction').length,
    rca:          insights.filter(i => i.kind === 'rca').length,
    optimization: insights.filter(i => i.kind === 'optimization').length,
    security:     insights.filter(i => i.kind === 'security').length,
    autonomous:   insights.filter(i => i.kind === 'autonomous').length,
    critical:     insights.filter(i => i.severity === 'critical').length,
    total:        insights.length,
  }

  // ?? Self-healing: auto-restart persistent crash loops (20+ restarts, 30-min cooldown) ??
  const autoHealed: { action: string; namespace: string; deployment: string; pod: string; reason: string; ts: string }[] = []
  const K8S = await resolveK8sUrl()
  if (K8S) {
    for (const pod of crashLoops.slice(0, 2)) {
      const podNs = pod.metadata.namespace
      const restarts = (pod.status?.containerStatuses ?? []).reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0)
      if (restarts < 20) continue // Only auto-heal persistent crash loops

      // Trace pod ? ReplicaSet ? Deployment
      const rsRef = pod.metadata.ownerReferences?.find((r: any) => r.kind === 'ReplicaSet')
      if (!rsRef) continue
      const rsData = await k8s(`/apis/apps/v1/namespaces/${podNs}/replicasets/${rsRef.name}`)
      const depRef = rsData?.metadata?.ownerReferences?.find((r: any) => r.kind === 'Deployment')
      if (!depRef) continue

      const depData = await k8s(`/apis/apps/v1/namespaces/${podNs}/deployments/${depRef.name}`)
      const lastHeal = depData?.metadata?.annotations?.['vynops.ai/last-auto-heal']
      if (lastHeal && Date.now() - new Date(lastHeal).getTime() < 30 * 60 * 1000) continue // 30-min cooldown

      try {
        const r = await fetch(`${K8S}/apis/apps/v1/namespaces/${podNs}/deployments/${depRef.name}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
          body: JSON.stringify({
            metadata: { annotations: { 'vynops.ai/last-auto-heal': new Date().toISOString() } },
            spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } },
          }),
          signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
        })
        if (r.ok) autoHealed.push({ action: 'restart_deployment', namespace: podNs, deployment: depRef.name, pod: pod.metadata.name, reason: `${restarts} restarts in CrashLoopBackOff ? auto-healed`, ts: new Date().toISOString() })
      } catch { /* ignore ? non-critical path */ }
    }
  }

  // ?? Slack + PagerDuty notifications (dedup + routing + delivery log) ???
  const rtCfg   = readRuntimeConfig()
  const on      = rtCfg.notify_on ?? {}
  const cooldownMs = (rtCfg.notify_cooldown_minutes ?? 30) * 60_000
  const routing    = rtCfg.alert_routing ?? { critical: ['pagerduty', 'slack'], warning: ['slack'], info: ['slack'] }

  const fire = async (
    eventKey:  string,
    severity:  'critical' | 'error' | 'warning' | 'info',
    slackText: string,
    pdSummary: string,
    fields?:   { title: string; value: string }[],
  ) => {
    const channels = routing[severity] ?? routing['warning'] ?? ['slack']
    const fired: string[] = []
    try {
      if (channels.includes('slack'))     { await slackNotify(slackText, fields); fired.push('slack') }
      if (channels.includes('pagerduty')) { await pdNotify(pdSummary, severity);  fired.push('pagerduty') }
      appendNotifLog({ ts: new Date().toISOString(), event: eventKey, channels: fired, summary: pdSummary, ok: true })
    } catch {
      appendNotifLog({ ts: new Date().toISOString(), event: eventKey, channels: fired, summary: pdSummary, ok: false })
    }
  }

  // Auto-heal ? always fires, no cooldown suppression
  if (autoHealed.length > 0) {
    await fire('auto_heal', 'warning',
      `?? *VynOps Auto-Healed ${autoHealed.length} deployment(s)*`,
      `VynOps auto-healed ${autoHealed.length} deployment(s): ${autoHealed.map(h => h.deployment).join(', ')}`,
      autoHealed.map(h => ({ title: `${h.namespace}/${h.deployment}`, value: h.reason })),
    )
  }

  if (on.critical_incidents !== false && cluster.healthScore < 60 && realCritical.length > 0
      && shouldFire('critical_incidents', cooldownMs)) {
    await fire('critical_incidents', 'critical',
      `?? *VynOps ? Critical Incidents ? Health ${cluster.healthScore}/100*`,
      `VynOps: health ${cluster.healthScore}/100 ? ${realCritical.length} critical: ${realCritical.slice(0, 2).map((a: any) => a.labels?.alertname ?? '?').join(', ')}`,
      realCritical.slice(0, 3).map((a: any) => ({ title: a.labels?.alertname ?? 'Alert', value: a.annotations?.summary ?? 'firing' })),
    )
  }

  if (on.deployment_failures !== false && degradedDeps.length > 0
      && shouldFire('deployment_failures', cooldownMs)) {
    await fire('deployment_failures', 'error',
      `?? *VynOps ? ${degradedDeps.length} Deployment(s) Degraded*`,
      `VynOps: ${degradedDeps.length} degraded: ${degradedDeps.slice(0, 3).map((d: any) => `${d.metadata.namespace}/${d.metadata.name}`).join(', ')}`,
      degradedDeps.slice(0, 3).map((d: any) => ({ title: `${d.metadata.namespace}/${d.metadata.name}`, value: `${d.status?.readyReplicas ?? 0}/${d.spec?.replicas ?? 1} ready` })),
    )
  }

  const notReadyNodes = nodes.filter((n: any) => !n.status?.conditions?.find((c: any) => c.type === 'Ready' && c.status === 'True'))
  if (on.node_not_ready !== false && notReadyNodes.length > 0
      && shouldFire('node_not_ready', cooldownMs)) {
    await fire('node_not_ready', 'critical',
      `?? *VynOps ? ${notReadyNodes.length} Node(s) Not Ready*`,
      `VynOps: ${notReadyNodes.length} node(s) not ready: ${notReadyNodes.map((n: any) => n.metadata.name).join(', ')}`,
      notReadyNodes.slice(0, 3).map((n: any) => ({ title: n.metadata.name, value: n.status?.conditions?.find((c: any) => c.type === 'Ready')?.message ?? 'Not Ready' })),
    )
  }

  const highRestarts = restartTrend.filter(r => r.value > 15)
  if (on.high_restart_rate !== false && highRestarts.length > 0
      && shouldFire(`high_restart_rate:${highRestarts[0]?.metric.pod ?? '?'}`, cooldownMs)) {
    await fire('high_restart_rate', 'warning',
      `?? *VynOps ? High Restart Rate on ${highRestarts.length} container(s)*`,
      `VynOps: high restarts ? ${highRestarts.slice(0, 2).map(r => `${r.metric.pod ?? r.metric.container}: ${r.value.toFixed(0)}/6h`).join(', ')}`,
      highRestarts.slice(0, 3).map(r => ({ title: r.metric.pod ?? r.metric.container ?? 'unknown', value: `${r.value.toFixed(0)} restarts in 6h` })),
    )
  }

  if (on.storage_full !== false && diskVal > 80
      && shouldFire('storage_full', cooldownMs)) {
    await fire('storage_full', diskVal > 90 ? 'critical' : 'warning',
      `?? *VynOps ? Disk Usage Critical: ${diskVal.toFixed(1)}%*`,
      `VynOps: disk at ${diskVal.toFixed(1)}% on / ? storage full risk`,
      [{ title: 'Mount: /', value: `${diskVal.toFixed(1)}% used` }],
    )
  }

  if (on.sla_breaches !== false && cluster.healthScore >= 60 && cluster.healthScore < 70 && counts.critical > 0
      && shouldFire('sla_breaches', cooldownMs)) {
    await fire('sla_breaches', 'warning',
      `?? *VynOps ? SLA at Risk ? Health ${cluster.healthScore}/100*`,
      `VynOps: SLA breach risk ? health ${cluster.healthScore}/100 with ${counts.critical} critical insight(s)`,
      [{ title: 'Health Score', value: `${cluster.healthScore}/100` }, { title: 'Critical Insights', value: `${counts.critical}` }],
    )
  }

  return NextResponse.json({ insights: insights.slice(0, 12), cluster, counts, autoHealed })
}
