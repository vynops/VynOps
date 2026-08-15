import { streamText, tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { auth } from '@/lib/auth'
import { createRateLimiter } from '@/lib/rate-limit'
import { resolveK8sUrl, resolvePromUrl, resolveAlertmanagerUrl, resolveClusterMeta, K8S_TIMEOUT_MS } from '@/lib/cluster'

const USAGE_FILE  = join(process.cwd(), 'data', 'ai-usage.jsonl')
const DATA_DIR    = join(process.cwd(), 'data')
const CONFIG_FILE = join(process.cwd(), 'config.runtime.json')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

// 20 requests per 60 s per user
const checkRateLimit = createRateLimiter(20, 60_000)

const BASE = (process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')

// ── Live data helpers ─────────────────────────────────────────
async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  if (!K8S) return null
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), cache: 'no-store' })
    if (!r.ok) return null
    return r.json()
  } catch { return null }
}

async function k8sGetText(path: string): Promise<string | null> {
  const K8S = await resolveK8sUrl()
  if (!K8S) return null
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(10000), cache: 'no-store' })
    if (!r.ok) return null
    return r.text()
  } catch { return null }
}

async function promGet(path: string) {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), cache: 'no-store' })
    if (!r.ok) return null
    return r.json()
  } catch { return null }
}

async function promQuery(q: string): Promise<number> {
  const j = await promGet(`/api/v1/query?query=${encodeURIComponent(q)}`)
  return parseFloat(j?.data?.result?.[0]?.value?.[1] ?? '0') || 0
}

async function promQueryAll(q: string): Promise<{ metric: Record<string, string>; value: number }[]> {
  const j = await promGet(`/api/v1/query?query=${encodeURIComponent(q)}`)
  return (j?.data?.result ?? []).map((x: any) => ({ metric: x.metric, value: parseFloat(x.value[1]) }))
}

async function apiGet(path: string) {
  try {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), cache: 'no-store' })
    if (!r.ok) return null
    return r.json()
  } catch { return null }
}

// ── Provider selection: runtime settings override environment variables ─
function getModel(): any {
  let provider = process.env.AI_PROVIDER ?? 'groq'
  let apiKey = process.env.AI_API_KEY ?? process.env.GROQ_API_KEY ?? ''
  let model = process.env.AI_MODEL ?? process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile'
  let baseUrl = process.env.AI_BASE_URL ?? ''
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (cfg.ai_provider) provider = cfg.ai_provider
    if (cfg.ai_api_key) apiKey = cfg.ai_api_key
    if (cfg.ai_model) model = cfg.ai_model
    if (cfg.ai_base_url) baseUrl = cfg.ai_base_url
    if (provider === 'groq') {
      apiKey = cfg.ai_api_key ?? cfg.groq_api_key ?? apiKey
      model = cfg.ai_model ?? cfg.groq_model ?? model
    }
  } catch {}
  if (provider === 'google') return createGoogleGenerativeAI({ apiKey })(model)
  if (provider === 'anthropic') return createAnthropic({ apiKey })(model)
  const openai = createOpenAI({ apiKey, baseURL: baseUrl || (provider === 'groq' ? 'https://api.groq.com/openai/v1' : undefined) })
  return openai(model, { parallelToolCalls: false })
}

// ── System prompt ─────────────────────────────────────────────
async function buildSystemPrompt(): Promise<string> {
  const meta = await resolveClusterMeta()
  const clusterCtx = meta ? `cluster: ${meta.name}, ${meta.provider} ${meta.region}`.trim().replace(/,\s*$/, '') : 'cluster: unknown'
  return `You are VynOps AI — a Level 5 SRE Copilot for VynOps (${clusterCtx}). ALWAYS call tools before answering. Never fabricate metrics or resource names.

CLUSTER CONTEXT: k3d/k3s embeds the control plane — KubeControllerManagerDown, KubeProxyDown, KubeSchedulerDown alerts are FALSE POSITIVES (components not scrape-able). Treat these as INFO, not critical.

TOOL CHAINS — follow automatically:
- Investigate: get_cluster_health → get_alerts → multi_layer_correlate
- Pod RCA: get_pod_status → get_events → correlate_pod_issue → suggest_remediation
- Predict: predict_failures → predict_sla_breach → forecast_capacity
- Cost/Scale: recommend_cost_optimization → recommend_scaling
- Security: recommend_security
- Fix: get_alerts → multi_layer_correlate → generate_workflow

RESPONSE: Concise, SRE-audience. **bold** severity, \`code\` for resources/commands. Always -n NAMESPACE in kubectl. Predictions: include confidence %. After generate_workflow: tell user to click Execute buttons for approval-gated steps. NEVER output raw function call syntax like <function=...> — always invoke tools directly.`
}

// ── Tools ─────────────────────────────────────────────────────
const tools = {

  get_cluster_health: tool({
    description: 'Real-time cluster health: nodes, CPU%, memory%, pod counts, health score. Call first for any diagnostic question.',
    parameters: z.object({}),
    execute: async () => {
      const [nodeData, cpuVal, memVal, podData] = await Promise.all([
        k8sGet('/api/v1/nodes'),
        promQuery('sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100'),
        promQuery('(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100'),
        k8sGet('/api/v1/pods'),
      ])
      if (!nodeData) return { source: 'unavailable', error: 'K8S_API_URL not configured or unreachable' }

      const nodes    = nodeData.items ?? []
      const pods     = podData?.items ?? []
      const ready    = nodes.filter((n: any) => n.status?.conditions?.find((c: any) => c.type === 'Ready' && c.status === 'True'))
      const failed   = pods.filter((p: any) => p.status?.phase === 'Failed').length
      const pending  = pods.filter((p: any) => p.status?.phase === 'Pending').length
      const running  = pods.filter((p: any) => p.status?.phase === 'Running').length

      let score = 100
      score -= (nodes.length - ready.length) * 15
      if (cpuVal > 85) score -= 20; else if (cpuVal > 70) score -= 10
      if (memVal > 85) score -= 20; else if (memVal > 70) score -= 10
      if (failed > 0) score -= Math.min(failed * 3, 15)
      score = Math.max(0, Math.min(100, Math.round(score)))

      const meta = await resolveClusterMeta()
      return {
        source: 'live', overallScore: score,
        cluster: meta?.name ?? 'unknown', region: meta ? `${meta.provider} ${meta.region}`.trim() : 'unknown',
        nodes: { total: nodes.length, ready: ready.length, notReady: nodes.length - ready.length },
        pods:  { total: pods.length, running, failed, pending },
        cpu:   `${cpuVal.toFixed(1)}%`, memory: `${memVal.toFixed(1)}%`,
        nodeList: ready.slice(0, 5).map((n: any) => ({
          name:    n.metadata.name,
          version: n.status?.nodeInfo?.kubeletVersion,
          os:      n.status?.nodeInfo?.osImage,
        })),
      }
    },
  }),

  get_pod_status: tool({
    description: 'List pods by phase/namespace. Finds CrashLoopBackOff, Pending, Failed pods.',
    parameters: z.object({
      phase:     z.enum(['Running', 'Pending', 'Failed', 'Succeeded', 'Unknown', 'all']).optional().default('all'),
      namespace: z.string().optional().describe('Filter by namespace. Omit for all namespaces.'),
      limit:     z.number().min(1).max(50).optional().default(20),
    }),
    execute: async ({ phase, namespace, limit }) => {
      const ns   = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''
      const data = await k8sGet(`/api/v1${ns}/pods`)
      if (!data) return { source: 'unavailable', pods: [] }

      const pods = (data.items ?? [])
        .filter((p: any) => phase === 'all' || p.status?.phase === phase)
        .slice(0, limit)
        .map((p: any) => {
          const cs       = p.status?.containerStatuses ?? []
          const restarts = cs.reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0)
          return {
            name: p.metadata.name, namespace: p.metadata.namespace,
            phase: p.status?.phase ?? 'Unknown', node: p.spec?.nodeName ?? 'unscheduled',
            restarts, ready: `${cs.filter((c: any) => c.ready).length}/${cs.length}`,
            age: p.metadata.creationTimestamp,
            containers: p.spec?.containers?.map((c: any) => ({
              name: c.name, image: c.image,
              state: Object.keys(cs.find((s: any) => s.name === c.name)?.state ?? { running: {} })[0],
            })) ?? [],
          }
        })
      return { source: 'live', count: pods.length, pods }
    },
  }),

  get_node_status: tool({
    description: 'Node CPU/memory usage, conditions, taints, pod counts.',
    parameters: z.object({}),
    execute: async () => {
      const [nodeData, cpuData, memData, podData] = await Promise.all([
        k8sGet('/api/v1/nodes'),
        promQueryAll('sum by (node) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum by (node) (rate(node_cpu_seconds_total[5m])) * 100'),
        promQueryAll('(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100'),
        k8sGet('/api/v1/pods'),
      ])
      if (!nodeData) return { source: 'unavailable', nodes: [] }

      const cpuMap: Record<string, number> = {}
      for (const r of cpuData) { if (r.metric.node) cpuMap[r.metric.node] = r.value }
      const memMap: Record<string, number> = {}
      for (const r of memData) { if (r.metric.node) memMap[r.metric.node] = r.value }
      const podMap: Record<string, number> = {}
      for (const p of (podData?.items ?? [])) {
        const n = p.spec?.nodeName
        if (n) podMap[n] = (podMap[n] ?? 0) + 1
      }

      return {
        source: 'live',
        nodes: (nodeData.items ?? []).map((n: any) => {
          const name  = n.metadata.name
          const ready = n.status?.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True'
          return {
            name, status: ready ? 'Ready' : 'NotReady',
            roles: Object.keys(n.metadata.labels ?? {})
              .filter((k: string) => k.startsWith('node-role.kubernetes.io/'))
              .map((k: string) => k.replace('node-role.kubernetes.io/', '')),
            kubeletVersion: n.status?.nodeInfo?.kubeletVersion,
            cpu: cpuMap[name] != null ? `${cpuMap[name].toFixed(1)}%` : 'n/a',
            memory: memMap[name] != null ? `${memMap[name].toFixed(1)}%` : 'n/a',
            podCount: podMap[name] ?? 0,
            taints: n.spec?.taints?.map((t: any) => `${t.key}:${t.effect}`) ?? [],
          }
        }),
      }
    },
  }),

  get_incidents: tool({
    description: 'Active incidents from Prometheus alerts. Use for outage and SLA questions.',
    parameters: z.object({
      severity: z.enum(['critical', 'high', 'medium', 'low', 'all']).optional().default('all'),
      state:    z.enum(['open', 'investigating', 'resolved', 'all']).optional().default('open'),
    }),
    execute: async ({ severity, state }) => {
      const data = await apiGet('/api/incidents')
      if (!data) return { source: 'unavailable', incidents: [] }

      let list = data.incidents ?? []
      if (severity !== 'all') list = list.filter((i: any) => i.severity === severity)
      if (state    !== 'all') list = list.filter((i: any) => i.state    === state)

      return {
        source: data.source ?? 'api', metrics: data.metrics, count: list.length,
        incidents: list.slice(0, 15).map((i: any) => ({
          id: i.id, title: i.title, severity: i.severity, state: i.state,
          service: i.service, description: i.description, createdAt: i.createdAt,
          affectedServices: i.blastRadius?.affectedServices ?? [],
          rca: i.rca ? { rootCause: i.rca.rootCause, confidence: i.rca.confidence } : null,
        })),
      }
    },
  }),

  get_alerts: tool({
    description: 'Firing Prometheus alerts filtered by severity.',
    parameters: z.object({
      severity: z.enum(['critical', 'warning', 'info', 'all']).optional().default('all'),
      limit:    z.number().min(1).max(30).optional().default(15),
    }),
    execute: async ({ severity, limit }) => {
      const data = await promGet('/api/v1/alerts')
      if (!data) return { source: 'unavailable', alerts: [] }

      let alerts = (data.data?.alerts ?? []).filter((a: any) => a.state === 'firing')
      if (severity !== 'all') alerts = alerts.filter((a: any) =>
        (a.labels?.severity ?? '').toLowerCase() === severity,
      )

      return {
        source: 'prometheus-live', total: alerts.length,
        alerts: alerts.slice(0, limit).map((a: any) => ({
          name: a.labels?.alertname, severity: a.labels?.severity ?? 'unknown',
          namespace: a.labels?.namespace, pod: a.labels?.pod, job: a.labels?.job,
          summary: a.annotations?.summary ?? a.annotations?.description,
          firedAt: a.activeAt, labels: a.labels,
        })),
      }
    },
  }),

  get_events: tool({
    description: 'K8s Warning events: OOMKill, BackOff, scheduling failures, image pull errors.',
    parameters: z.object({
      namespace: z.string().optional().describe('Filter by namespace.'),
      reason:    z.string().optional().describe('Filter by reason e.g. OOMKilled, BackOff, FailedScheduling'),
      limit:     z.number().min(1).max(30).optional().default(20),
    }),
    execute: async ({ namespace, reason, limit }) => {
      const ns   = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''
      const data = await k8sGet(`/api/v1${ns}/events?fieldSelector=type=Warning`)
      if (!data) return { source: 'unavailable', events: [] }

      const events = (data.items ?? [])
        .filter((e: any) => !reason || (e.reason ?? '').toLowerCase().includes(reason.toLowerCase()))
        .sort((a: any, b: any) => new Date(b.lastTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? 0).getTime())
        .slice(0, limit)
        .map((e: any) => ({
          namespace: e.metadata.namespace, reason: e.reason, message: e.message,
          object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
          count: e.count ?? 1, lastTime: e.lastTimestamp,
        }))
      return { source: 'live', count: events.length, events }
    },
  }),

  get_service_metrics: tool({
    description: 'Deployment availability and restart rates for SLO analysis.',
    parameters: z.object({
      service:   z.string().optional().describe('Filter by deployment name (partial match)'),
      namespace: z.string().optional().describe('Filter by namespace'),
    }),
    execute: async ({ service, namespace }) => {
      const ns   = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''
      const data = await k8sGet(`/apis/apps/v1${ns}/deployments`)
      if (!data) return { source: 'unavailable', services: [] }

      const restartData = await promQueryAll('sum by (namespace) (increase(kube_pod_container_status_restarts_total[1h]))')
      const restartByNs: Record<string, number> = {}
      for (const r of restartData) { if (r.metric.namespace) restartByNs[r.metric.namespace] = r.value }

      let deploys = (data.items ?? []) as any[]
      if (service)   deploys = deploys.filter((d: any) => d.metadata.name.toLowerCase().includes(service.toLowerCase()))
      if (namespace) deploys = deploys.filter((d: any) => d.metadata.namespace === namespace)

      return {
        source: 'live', count: deploys.length,
        services: deploys.slice(0, 25).map((d: any) => {
          const desired = d.spec.replicas ?? 1
          const ready   = d.status.readyReplicas ?? 0
          const avail   = desired > 0 ? (ready / desired) * 100 : 0
          return {
            name: d.metadata.name, namespace: d.metadata.namespace,
            ready: `${ready}/${desired}`, availability: `${avail.toFixed(1)}%`,
            status: avail >= 100 ? 'healthy' : avail > 0 ? 'degraded' : 'critical',
            restartsLastHour: Math.round(restartByNs[d.metadata.namespace] ?? 0),
          }
        }),
      }
    },
  }),

  run_prometheus_query: tool({
    description: 'Execute a custom PromQL query against live Prometheus.',
    parameters: z.object({
      query:       z.string().describe('Valid PromQL expression'),
      description: z.string().describe('What this query measures'),
    }),
    execute: async ({ query, description }) => {
      const data = await promGet(`/api/v1/query?query=${encodeURIComponent(query)}`)
      if (!data) return { source: 'unavailable', description, results: [] }
      return {
        source: 'prometheus-live', description, query,
        results: (data.data?.result ?? []).slice(0, 20).map((r: any) => ({
          labels: r.metric, value: parseFloat(r.value[1]),
        })),
      }
    },
  }),

  query_logs: tool({
    description: 'Fetch and analyze pod logs. Detects errors, exceptions, stack traces, OOM kills. Essential for RCA — always call this when investigating a crashloop or unknown failure.',
    parameters: z.object({
      namespace: z.string().describe('Kubernetes namespace'),
      pod:       z.string().describe('Pod name'),
      container: z.string().optional().describe('Container name — omit to use the default container'),
      tailLines: z.number().default(100).describe('Number of log lines to fetch (max 200)'),
      previous:  z.boolean().default(false).describe('true = fetch logs from previous crashed container instance — use for CrashLoopBackOff'),
    }),
    execute: async ({ namespace, pod, container, tailLines, previous }) => {
      const params = new URLSearchParams({ tailLines: String(Math.min(tailLines, 200)), timestamps: 'true' })
      if (container) params.set('container', container)
      if (previous)  params.set('previous', 'true')
      const logText = await k8sGetText(`/api/v1/namespaces/${namespace}/pods/${pod}/log?${params}`)
      if (!logText) return { source: 'unavailable', pod, namespace, error: 'Could not fetch logs — pod may not exist, not running, or container name is wrong. Try without specifying container.' }
      const lines = logText.split('\n').filter(Boolean)
      const errorLines = lines.filter(l => /\b(error|exception|fatal|panic|killed|oom|crash|failed|timeout|refused|denied)\b/i.test(l))
      const warnLines  = lines.filter(l => /\b(warn|warning|deprecated)\b/i.test(l))
      const stackStart = lines.findIndex(l => /exception|traceback|panic:|goroutine\s+\d+|at\s+\S+\.\w+\(/i.test(l))
      const stackTrace = stackStart >= 0 ? lines.slice(stackStart, stackStart + 15) : []
      return {
        source: 'live', pod, namespace,
        container: container ?? 'default', previous,
        totalLines: lines.length,
        analysis: {
          errorCount: errorLines.length,
          warnCount: warnLines.length,
          hasStackTrace: stackTrace.length > 0,
          recentErrors: errorLines.slice(-5),
          stackTrace,
        },
        recentLines: lines.slice(-50),
        hint: previous ? 'Showing logs from the crashed container instance' : 'Tip: set previous:true to see logs from the last crashed container',
      }
    },
  }),

  correlate_pod_issue: tool({
    description: 'Deep RCA for a specific pod using Prometheus history, K8s events, and restart trends.',
    parameters: z.object({
      namespace:     z.string().describe('Kubernetes namespace'),
      pod:           z.string().describe('Pod name'),
      windowMinutes: z.number().default(60).describe('Time window in minutes'),
    }),
    execute: async ({ namespace, pod, windowMinutes }) => {
      try {
        const r = await fetch(
          `${BASE}/api/k8s/correlate?namespace=${encodeURIComponent(namespace)}&pod=${encodeURIComponent(pod)}&window=${windowMinutes * 60}`,
          { signal: AbortSignal.timeout(12000) },
        )
        if (!r.ok) return { error: `Correlation API returned ${r.status}` }
        return { source: 'live', ...(await r.json()) }
      } catch (e) { return { error: String(e) } }
    },
  }),

  predict_failures: tool({
    description: 'Failure risk scores per workload using restart trends, OOM events, CPU throttling, memory pressure.',
    parameters: z.object({
      namespace:     z.string().optional().describe('Limit analysis to namespace. Omit for cluster-wide.'),
      lookbackHours: z.number().default(6).describe('History window in hours'),
    }),
    execute: async ({ namespace, lookbackHours }) => {
      const win  = `${lookbackHours}h`
      const nsF  = namespace ? `namespace="${namespace}",` : ''
      const [restarts, oomData, throttle, memPressure, podData] = await Promise.all([
        promQueryAll(`topk(10, increase(kube_pod_container_status_restarts_total{${nsF}}[${win}]))`),
        promQueryAll(`kube_pod_container_status_last_terminated_reason{reason="OOMKilled",${nsF}}`),
        promQueryAll(`topk(10, rate(container_cpu_cfs_throttled_seconds_total{container!="",${nsF}}[5m]) / (rate(container_cpu_cfs_periods_total{container!="",${nsF}}[5m]) + 0.001) * 100)`),
        promQueryAll(`topk(10, container_memory_working_set_bytes{container!="",${nsF}} / (container_spec_memory_limit_bytes{container!="",${nsF}} + 1) * 100 > 85)`),
        namespace ? k8sGet(`/api/v1/namespaces/${namespace}/pods`) : k8sGet('/api/v1/pods'),
      ])
      const risks: any[] = []
      for (const r of restarts) {
        if (r.value > 3) risks.push({ workload: r.metric.pod ?? 'unknown', namespace: r.metric.namespace ?? namespace ?? '?', container: r.metric.container, riskFactor: 'high_restart_rate', value: `${r.value.toFixed(0)} restarts in ${lookbackHours}h`, probability: Math.min(0.95, 0.4 + r.value * 0.05), severity: r.value > 15 ? 'critical' : r.value > 7 ? 'high' : 'medium' })
      }
      for (const r of oomData) {
        if (r.value > 0) {
          // Probability scales with OOM recurrence: 1 event→0.74, 3→0.82, 5+→0.90
          const prob = Math.min(0.96, 0.70 + r.value * 0.04)
          risks.push({ workload: r.metric.pod ?? 'unknown', namespace: r.metric.namespace ?? namespace ?? '?', container: r.metric.container, riskFactor: 'oom_killed', value: 'Recently OOM killed', probability: prob, severity: 'high' })
        }
      }
      for (const r of throttle) {
        if (r.value > 70) {
          // CPU throttle probability: linear scale 70%→0.72, 85%→0.81, 100%→0.90
          const prob = Math.min(0.90, 0.30 + (r.value / 100) * 0.60)
          risks.push({ workload: r.metric.pod ?? 'unknown', namespace: r.metric.namespace ?? namespace ?? '?', container: r.metric.container, riskFactor: 'cpu_throttling', value: `${r.value.toFixed(1)}% CPU throttled`, probability: prob, severity: 'medium' })
        }
      }
      for (const r of memPressure) {
        if (r.value > 85) {
          // Memory pressure sigmoid: 85%→0.50, 90%→0.66, 95%→0.81, 100%→0.97
          const prob = Math.min(0.97, 0.50 + (r.value - 85) / 15 * 0.47)
          risks.push({ workload: r.metric.pod ?? 'unknown', namespace: r.metric.namespace ?? namespace ?? '?', container: r.metric.container, riskFactor: 'memory_pressure', value: `${r.value.toFixed(1)}% of memory limit`, probability: prob, severity: r.value > 95 ? 'critical' : 'high' })
        }
      }
      for (const p of (podData?.items ?? []).filter((p: any) => p.status?.phase === 'Pending').slice(0, 5)) {
        const cond = p.status?.conditions?.find((c: any) => c.type === 'PodScheduled' && c.status === 'False')
        risks.push({ workload: p.metadata.name, namespace: p.metadata.namespace, riskFactor: 'unschedulable', value: cond?.message ?? 'Cannot be scheduled', probability: 0.7, severity: 'high' })
      }
      const unique = risks.filter((r, i, a) => i === a.findIndex((x) => x.workload === r.workload && x.riskFactor === r.riskFactor)).sort((a, b) => b.probability - a.probability)
      return { source: 'live', analyzedWindow: `${lookbackHours}h`, totalRisks: unique.length, criticalCount: unique.filter((r) => r.severity === 'critical').length, highCount: unique.filter((r) => r.severity === 'high').length, risks: unique.slice(0, 15), summary: unique.length === 0 ? 'No imminent failure risks detected.' : `${unique.filter((r) => r.severity === 'critical').length} critical, ${unique.filter((r) => r.severity === 'high').length} high-risk workloads detected.` }
    },
  }),

  forecast_capacity: tool({
    description: 'Forecast CPU/memory/disk/pod exhaustion date via Prometheus linear regression.',
    parameters: z.object({
      forecastDays: z.number().default(7).describe('Days to forecast ahead'),
    }),
    execute: async ({ forecastDays }) => {
      const secs = forecastDays * 86400
      const [cpuNow, memNow, diskNow, podCount, nodeData, diskForecast, cpuForecast, memForecast] = await Promise.all([
        promQuery('sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100'),
        promQuery('(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100'),
        promQuery('(1 - avg(node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) * 100'),
        promQuery('count(kube_pod_info)'),
        k8sGet('/api/v1/nodes'),
        promQueryAll(`node_filesystem_avail_bytes{mountpoint="/"} + predict_linear(node_filesystem_avail_bytes{mountpoint="/"}[6h], ${secs})`),
        // Linear regression on CPU trend over last 6h (Prometheus subquery)
        promQuery(`clamp_max(clamp_min(predict_linear((sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100)[6h:5m], ${secs}), 0), 100)`),
        // Linear regression on memory trend over last 6h
        promQuery(`clamp_max(clamp_min(predict_linear(((1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100)[6h:5m], ${secs}), 0), 100)`),
      ])
      const nodeCount = (nodeData?.items ?? []).length
      const podCap = 110 * nodeCount
      const diskIssues = diskForecast.filter((r: any) => r.value < 0).map((r: any) => ({ node: r.metric.instance ?? r.metric.node ?? 'unknown', willExhaustIn: `${forecastDays}d` }))
      const grade = (pct: number) => pct > 90 ? 'critical' : pct > 75 ? 'warning' : 'healthy'
      // Use forecast if Prometheus returned a valid value, else fall back to current
      const cpuFuture = (cpuForecast > 0 && cpuForecast < 101) ? cpuForecast : cpuNow
      const memFuture = (memForecast > 0 && memForecast < 101) ? memForecast : memNow
      const cpuTrend = cpuFuture > cpuNow + 8 ? 'growing ▲' : cpuFuture < cpuNow - 5 ? 'declining ▼' : 'stable →'
      const memTrend = memFuture > memNow + 8 ? 'growing ▲' : memFuture < memNow - 5 ? 'declining ▼' : 'stable →'
      return {
        source: 'live', forecastWindow: `${forecastDays} days`,
        current: { cpu: `${cpuNow.toFixed(1)}%`, memory: `${memNow.toFixed(1)}%`, disk: `${diskNow.toFixed(1)}%`, pods: `${Math.round(podCount)}/${podCap} (${((podCount / Math.max(1, podCap)) * 100).toFixed(1)}%)` },
        projected: { cpu: `${cpuFuture.toFixed(1)}%`, memory: `${memFuture.toFixed(1)}%`, cpuTrend, memTrend },
        cpuRisk: grade(Math.max(cpuNow, cpuFuture)), memoryRisk: grade(Math.max(memNow, memFuture)), diskRisk: diskIssues.length > 0 ? 'critical' : grade(diskNow), podRisk: grade((podCount / Math.max(1, podCap)) * 100),
        diskAtRisk: diskIssues,
        recommendations: [
          ...(Math.max(cpuNow, cpuFuture) > 75 ? [`CPU at ${cpuNow.toFixed(1)}% trending to ${cpuFuture.toFixed(1)}% in ${forecastDays}d — add nodes or reduce CPU requests`] : []),
          ...(Math.max(memNow, memFuture) > 80 ? [`Memory at ${memNow.toFixed(1)}% trending to ${memFuture.toFixed(1)}% in ${forecastDays}d — check OOMKilled pods, enable VPA`] : []),
          ...(diskIssues.length > 0 ? [`${diskIssues.length} node(s) disk will fill in ${forecastDays}d — run: crictl rmi --prune`] : []),
          ...((podCount / Math.max(1, podCap)) > 0.8 ? ['Pod density >80% of node limit — add nodes'] : []),
        ],
        overallRisk: (Math.max(cpuNow, cpuFuture) > 80 || Math.max(memNow, memFuture) > 85 || diskIssues.length > 0) ? 'critical' : (Math.max(cpuNow, cpuFuture) > 65 || Math.max(memNow, memFuture) > 70) ? 'warning' : 'healthy',
      }
    },
  }),

  predict_sla_breach: tool({
    description: 'SLO breach risk per service using availability, error rates, restart trends.',
    parameters: z.object({
      namespace: z.string().optional().describe('Target namespace. Omit for cluster-wide.'),
    }),
    execute: async ({ namespace }) => {
      const nsP = namespace ? `/namespaces/${namespace}` : ''
      const nsF = namespace ? `namespace="${namespace}",` : ''
      const [deploys, errorRates, restarts] = await Promise.all([
        k8sGet(`/apis/apps/v1${nsP}/deployments`),
        promQueryAll(`sum by (namespace, job) (rate(http_requests_total{${nsF}code=~"5.."}[5m])) / sum by (namespace, job) (rate(http_requests_total{${nsF}}[5m])) * 100`),
        promQueryAll(`sum by (namespace) (rate(kube_pod_container_status_restarts_total[30m])) * 60`),
      ])
      const restartMap: Record<string, number> = {}
      for (const r of restarts) if (r.metric.namespace) restartMap[r.metric.namespace] = r.value
      const sloTarget = 99.9
      const analysis = (deploys?.items ?? []).map((d: any) => {
        const desired = d.spec.replicas ?? 1; const ready = d.status.readyReplicas ?? 0
        const avail = desired > 0 ? (ready / desired) * 100 : 0
        const errEntry = errorRates.find((e: any) => e.metric.job?.includes(d.metadata.name))
        const errPct = errEntry?.value ?? 0; const rpm = restartMap[d.metadata.namespace] ?? 0
        const budgetUsed = avail < 100 ? Math.min(100, Math.round(((100 - avail) / (100 - sloTarget)) * 100)) : Math.max(0, Math.round(errPct * 10))
        const risk = avail < 50 ? 'breached' : avail < 100 ? 'at_risk' : rpm > 1 ? 'at_risk' : errPct > 1 ? 'degraded' : 'healthy'
        return { service: d.metadata.name, namespace: d.metadata.namespace, availability: `${avail.toFixed(2)}%`, errorRate: errPct > 0 ? `${errPct.toFixed(2)}%` : 'no data', restartsPerMin: rpm.toFixed(2), readyReplicas: `${ready}/${desired}`, errorBudgetUsed: `${budgetUsed}%`, sloTarget: `${sloTarget}%`, breachRisk: risk }
      }).filter((s: any) => s.breachRisk !== 'healthy').sort((a: any, b: any) => { const o: Record<string, number> = { breached: 0, at_risk: 1, degraded: 2 }; return (o[a.breachRisk] ?? 3) - (o[b.breachRisk] ?? 3) })
      const breached = analysis.filter((s: any) => s.breachRisk === 'breached').length
      const atRisk = analysis.filter((s: any) => s.breachRisk === 'at_risk').length
      return { source: 'live', summary: `${breached} SLO breached, ${atRisk} at risk`, breachedCount: breached, atRiskCount: atRisk, services: analysis.slice(0, 15), recommendation: breached > 0 ? 'Immediate action required. Trigger incident response and notify on-call.' : atRisk > 0 ? 'Services approaching SLO boundary. Investigate before error budget exhausted.' : 'All monitored services within SLO targets.' }
    },
  }),

  analyze_blast_radius: tool({
    description: 'Impact map for a failing resource: affected pods, services, ingresses, HPAs, user impact.',
    parameters: z.object({
      namespace:    z.string().describe('Kubernetes namespace'),
      resourceName: z.string().describe('Failing resource name'),
      resourceKind: z.enum(['Deployment', 'Service', 'Pod', 'Node']).default('Deployment'),
    }),
    execute: async ({ namespace, resourceName, resourceKind }) => {
      const [pods, svcs, ingresses, hpas, events] = await Promise.all([
        k8sGet(`/api/v1/namespaces/${namespace}/pods`),
        k8sGet(`/api/v1/namespaces/${namespace}/services`),
        k8sGet(`/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses`),
        k8sGet(`/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers`),
        k8sGet(`/api/v1/namespaces/${namespace}/events?fieldSelector=type=Warning`),
      ])
      const allPods = (pods?.items ?? []).filter((p: any) => p.metadata.name.includes(resourceName) || p.metadata.labels?.app === resourceName || p.metadata.labels?.['app.kubernetes.io/name'] === resourceName)
      const affectedSvcs = (svcs?.items ?? []).filter((s: any) => { const sel = s.spec.selector ?? {}; return Object.entries(sel).some(([k, v]) => allPods.some((p: any) => p.metadata.labels?.[k] === v)) })
      const affectedIngs = (ingresses?.items ?? []).filter((ing: any) => (ing.spec.rules ?? []).some((r: any) => r.http?.paths?.some((path: any) => affectedSvcs.some((s: any) => s.metadata.name === path.backend?.service?.name))))
      const affectedHPAs = (hpas?.items ?? []).filter((h: any) => h.spec.scaleTargetRef?.name === resourceName)
      const relEvents = (events?.items ?? []).filter((e: any) => e.involvedObject?.name?.includes(resourceName) || allPods.some((p: any) => e.involvedObject?.name === p.metadata.name)).slice(0, 5).map((e: any) => ({ reason: e.reason, message: e.message, count: e.count }))
      const severity = allPods.length > 10 ? 'critical' : allPods.length > 3 ? 'high' : allPods.length > 0 ? 'medium' : 'low'
      return { source: 'live', rootResource: { kind: resourceKind, name: resourceName, namespace }, severity, blastRadius: { pods: allPods.length, services: affectedSvcs.length, ingresses: affectedIngs.length, hpas: affectedHPAs.length }, affected: { pods: allPods.slice(0, 10).map((p: any) => ({ name: p.metadata.name, phase: p.status.phase, restarts: (p.status.containerStatuses ?? []).reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0) })), services: affectedSvcs.map((s: any) => ({ name: s.metadata.name, type: s.spec.type })), ingresses: affectedIngs.map((i: any) => ({ name: i.metadata.name, hosts: (i.spec.rules ?? []).map((r: any) => r.host).filter(Boolean) })) }, recentEvents: relEvents, userImpact: affectedIngs.length > 0 ? `⚠️ EXTERNAL TRAFFIC AFFECTED — ${affectedIngs.length} ingress route(s) lead to degraded services` : affectedSvcs.length > 0 ? `Internal traffic degraded across ${affectedSvcs.length} service(s)` : 'No external traffic impact detected' }
    },
  }),

  multi_layer_correlate: tool({
    description: '7-layer causal chain (L1 infra → L7 app) to find true root cause of an incident.',
    parameters: z.object({
      namespace:     z.string().optional().describe('Focus namespace — omit for cluster-wide'),
      focusResource: z.string().optional().describe('Optional resource name to center on'),
    }),
    execute: async ({ namespace }) => {
      const nsP = namespace ? `/namespaces/${namespace}` : ''
      const [pods, nodes, events, deploys, alerts, cpuData, memData, diskData] = await Promise.all([
        k8sGet(`/api/v1${nsP}/pods`),
        k8sGet('/api/v1/nodes'),
        k8sGet(`/api/v1${nsP}/events?fieldSelector=type=Warning`),
        k8sGet(`/apis/apps/v1${nsP}/deployments`),
        promGet('/api/v1/alerts'),
        promQueryAll('sum by (node) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum by (node) (rate(node_cpu_seconds_total[5m])) * 100'),
        promQueryAll('(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100'),
        promQueryAll('(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100'),
      ])
      const allPods = pods?.items ?? []; const allNodes = nodes?.items ?? []; const allEvents = events?.items ?? []
      const firing = (alerts?.data?.alerts ?? []).filter((a: any) => a.state === 'firing')
      const cpuMap: Record<string, number> = {}; for (const r of cpuData) cpuMap[r.metric.node ?? r.metric.instance ?? ''] = r.value
      const memMap: Record<string, number> = {}; for (const r of memData) memMap[r.metric.node ?? r.metric.instance ?? ''] = r.value
      const dskMap: Record<string, number> = {}; for (const r of diskData) dskMap[r.metric.node ?? r.metric.instance ?? ''] = r.value
      const crashLoops  = allPods.filter((p: any) => p.status?.containerStatuses?.some((c: any) => c.state?.waiting?.reason === 'CrashLoopBackOff'))
      const oomPods     = allPods.filter((p: any) => p.status?.containerStatuses?.some((c: any) => c.lastState?.terminated?.reason === 'OOMKilled'))
      const pendingPods = allPods.filter((p: any) => p.status?.phase === 'Pending')
      const degradedDeps = (deploys?.items ?? []).filter((d: any) => (d.status?.readyReplicas ?? 0) < (d.spec?.replicas ?? 1))
      const pressuredNodes = allNodes.filter((n: any) => n.status?.conditions?.some((c: any) => ['MemoryPressure', 'DiskPressure', 'PIDPressure'].includes(c.type) && c.status === 'True'))
      const notReadyNodes  = allNodes.filter((n: any) => !n.status?.conditions?.find((c: any) => c.type === 'Ready' && c.status === 'True'))
      const diskWarnNodes  = Object.entries(dskMap).filter(([, v]) => v > 80)
      const netEvents      = allEvents.filter((e: any) => ['NetworkNotReady', 'FailedCreatePodSandBox'].includes(e.reason ?? ''))
      type Layer = { layer: string; severity: string; finding: string; resources: string[]; causalDirection: string }
      const chain: Layer[] = []
      if (notReadyNodes.length > 0 || pressuredNodes.length > 0) chain.push({ layer: 'L1 Infrastructure', severity: 'critical', finding: `${notReadyNodes.length} NotReady nodes, ${pressuredNodes.length} under pressure`, resources: notReadyNodes.map((n: any) => n.metadata.name), causalDirection: '⬆ causes all higher-layer failures' })
      if (diskWarnNodes.length > 0) chain.push({ layer: 'L2 Storage', severity: diskWarnNodes.some(([, v]) => v > 90) ? 'critical' : 'warning', finding: `${diskWarnNodes.length} node(s) disk >80%`, resources: diskWarnNodes.map(([n]) => n), causalDirection: '⬆ causes OOM events and pod evictions' })
      if (netEvents.length > 0) chain.push({ layer: 'L4 Network', severity: 'high', finding: `${netEvents.length} network warning events`, resources: netEvents.slice(0, 3).map((e: any) => e.involvedObject?.name ?? ''), causalDirection: '⬆ causes pod sandbox failures' })
      if (pendingPods.length > 0) chain.push({ layer: 'L5 Scheduling', severity: pendingPods.length > 5 ? 'critical' : 'high', finding: `${pendingPods.length} pods cannot be scheduled`, resources: pendingPods.slice(0, 5).map((p: any) => `${p.metadata.namespace}/${p.metadata.name}`), causalDirection: '⬆ causes service under-capacity' })
      if (crashLoops.length > 0 || oomPods.length > 0) chain.push({ layer: 'L5 Container', severity: 'critical', finding: `${crashLoops.length} CrashLoopBackOff, ${oomPods.length} OOMKilled`, resources: [...crashLoops, ...oomPods].slice(0, 5).map((p: any) => `${p.metadata.namespace}/${p.metadata.name}`), causalDirection: '⬆ causes service unavailability' })
      if (degradedDeps.length > 0) chain.push({ layer: 'L6 Service', severity: 'high', finding: `${degradedDeps.length} deployments below desired replicas`, resources: degradedDeps.slice(0, 5).map((d: any) => `${d.metadata.namespace}/${d.metadata.name}`), causalDirection: '⬆ causes SLO breach' })
      if (firing.length > 0) chain.push({ layer: 'L7 Application', severity: firing.some((a: any) => a.labels?.severity === 'critical') ? 'critical' : 'high', finding: `${firing.length} Prometheus alerts firing`, resources: firing.slice(0, 5).map((a: any) => a.labels?.alertname ?? ''), causalDirection: 'observable symptom' })
      const rootCause = chain[0] ?? null
      const overall = chain.some((c) => c.severity === 'critical') ? 'critical' : chain.some((c) => c.severity === 'high') ? 'high' : chain.length > 0 ? 'medium' : 'healthy'
      // Weighted confidence: each layer adds weight; critical layers and cross-layer correlation add bonuses
      const _lw: Record<string, number> = { 'L1 Infrastructure': 0.18, 'L2 Storage': 0.10, 'L4 Network': 0.09, 'L5 Scheduling': 0.08, 'L5 Container': 0.11, 'L6 Service': 0.07, 'L7 Application': 0.04 }
      const _conf = chain.length === 0 ? 0.95 : Math.round(Math.min(0.97, 0.50 + chain.reduce((s, c) => s + (_lw[c.layer] ?? 0.05), 0) + (chain.length >= 3 ? 0.07 : chain.length >= 2 ? 0.03 : 0) + Math.min(0.10, chain.filter(c => c.severity === 'critical').length * 0.04)) * 100) / 100
      return { source: 'live', namespace: namespace ?? 'cluster-wide', overallSeverity: overall, rootCause: rootCause ? `${rootCause.layer}: ${rootCause.finding}` : 'No root cause — cluster is healthy', confidence: _conf, causalChain: chain, layersSummary: { 'L7 Application': firing.length, 'L6 Service': degradedDeps.length, 'L5 Container': crashLoops.length + oomPods.length + pendingPods.length, 'L4 Network': netEvents.length, 'L3 Node': notReadyNodes.length + pressuredNodes.length, 'L2 Storage': diskWarnNodes.length, 'L1 Infrastructure': notReadyNodes.length + pressuredNodes.length }, recommendedFirstAction: rootCause ? `Address ${rootCause.layer} first — this is the root cause, not a symptom.` : 'No critical issues found in any layer.' }
    },
  }),

  recommend_cost_optimization: tool({
    description: 'Over-provisioned workloads and $/month savings from right-sizing via Prometheus usage vs requests.',
    parameters: z.object({
      namespace: z.string().optional(),
      threshold: z.number().default(30).describe('Utilization % below which workloads are over-provisioned'),
    }),
    execute: async ({ namespace, threshold }) => {
      const nsP = namespace ? `/namespaces/${namespace}` : ''
      const nsF = namespace ? `namespace="${namespace}",` : ''
      const [deploys, cpuUsage, memUsage, cpuReq, memReq] = await Promise.all([
        k8sGet(`/apis/apps/v1${nsP}/deployments`),
        promQueryAll(`sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD",${nsF}}[5m]))`),
        promQueryAll(`sum by (namespace, pod) (container_memory_working_set_bytes{container!="",container!="POD",${nsF}})`),
        promQueryAll(`sum by (namespace, pod) (kube_pod_container_resource_requests{resource="cpu",${nsF}})`),
        promQueryAll(`sum by (namespace, pod) (kube_pod_container_resource_requests{resource="memory",${nsF}})`),
      ])
      const cpuUsageMap: Record<string, number> = {}; for (const r of cpuUsage) cpuUsageMap[`${r.metric.namespace}/${r.metric.pod}`] = r.value
      const memUsageMap: Record<string, number> = {}; for (const r of memUsage) memUsageMap[`${r.metric.namespace}/${r.metric.pod}`] = r.value
      const cpuReqMap:   Record<string, number> = {}; for (const r of cpuReq)   cpuReqMap[`${r.metric.namespace}/${r.metric.pod}`] = r.value
      const memReqMap:   Record<string, number> = {}; for (const r of memReq)   memReqMap[`${r.metric.namespace}/${r.metric.pod}`] = r.value
      const CPU_COST = 7.2; const MEM_COST = 1.08
      const opps: any[] = []
      for (const d of (deploys?.items ?? [])) {
        const ns = d.metadata.namespace; const name = d.metadata.name; const replicas = d.spec.replicas ?? 1
        const key = Object.keys(cpuReqMap).find((k) => k.includes(name) && k.startsWith(ns))
        if (!key) continue
        const cpuR = cpuReqMap[key] ?? 0; const memR = memReqMap[key] ?? 0; const cpuU = cpuUsageMap[key] ?? 0; const memU = memUsageMap[key] ?? 0
        if (cpuR <= 0 && memR <= 0) continue
        const cpuUtil = cpuR > 0 ? (cpuU / cpuR) * 100 : 100; const memUtil = memR > 0 ? (memU / memR) * 100 : 100
        if (cpuUtil < threshold || memUtil < threshold) {
          const newCpu = Math.max(0.01, cpuU * 1.25); const newMem = Math.max(64 * 1024 * 1024, memU * 1.25)
          const savings = Math.max(0, (cpuR - newCpu) * replicas * CPU_COST + ((memR - newMem) / 1073741824) * replicas * MEM_COST)
          opps.push({ workload: name, namespace: ns, replicas, currentCpu: `${(cpuR * 1000).toFixed(0)}m`, actualCpu: `${(cpuU * 1000).toFixed(0)}m`, cpuUtil: `${cpuUtil.toFixed(1)}%`, currentMem: `${(memR / 1048576).toFixed(0)}Mi`, actualMem: `${(memU / 1048576).toFixed(0)}Mi`, memUtil: `${memUtil.toFixed(1)}%`, recommendedCpu: `${(newCpu * 1000).toFixed(0)}m`, recommendedMem: `${(newMem / 1048576).toFixed(0)}Mi`, estimatedMonthlySavings: `$${savings.toFixed(2)}`, savingsAmount: savings, priority: savings > 50 ? 'high' : savings > 10 ? 'medium' : 'low' })
        }
      }
      opps.sort((a, b) => b.savingsAmount - a.savingsAmount)
      const total = opps.reduce((s, o) => s + o.savingsAmount, 0)
      return { source: 'live', namespace: namespace ?? 'all', threshold: `${threshold}%`, totalOpportunities: opps.length, estimatedMonthlySavings: `$${total.toFixed(2)}`, estimatedAnnualSavings: `$${(total * 12).toFixed(2)}`, opportunities: opps.slice(0, 15), quickWin: opps[0] ?? null, summary: opps.length === 0 ? `All workloads efficiently provisioned (>${threshold}% utilization).` : `${opps.length} over-provisioned workload(s). Potential: $${total.toFixed(2)}/month, $${(total * 12).toFixed(2)}/year.` }
    },
  }),

  recommend_scaling: tool({
    description: 'High-utilization workloads needing more replicas or HPA; SPOF single-replica deployments.',
    parameters: z.object({
      namespace: z.string().optional(),
    }),
    execute: async ({ namespace }) => {
      const nsP = namespace ? `/namespaces/${namespace}` : ''
      const nsF = namespace ? `namespace="${namespace}",` : ''
      const [deploys, hpas, cpuUtil, memUtil] = await Promise.all([
        k8sGet(`/apis/apps/v1${nsP}/deployments`),
        k8sGet(`/apis/autoscaling/v2${nsP}/horizontalpodautoscalers`),
        promQueryAll(`avg by (namespace, deployment) (rate(container_cpu_usage_seconds_total{container!="",${nsF}}[5m])) / (avg by (namespace, deployment) (kube_pod_container_resource_requests{resource="cpu",${nsF}}) + 0.001) * 100`),
        promQueryAll(`avg by (namespace, deployment) (container_memory_working_set_bytes{container!="",${nsF}}) / (avg by (namespace, deployment) (kube_pod_container_resource_requests{resource="memory",${nsF}}) + 1) * 100`),
      ])
      const hpaSet = new Set((hpas?.items ?? []).map((h: any) => `${h.metadata.namespace}/${h.spec.scaleTargetRef.name}`))
      const cpuMap: Record<string, number> = {}; for (const r of cpuUtil) cpuMap[`${r.metric.namespace}/${r.metric.deployment}`] = r.value
      const memMap: Record<string, number> = {}; for (const r of memUtil) memMap[`${r.metric.namespace}/${r.metric.deployment}`] = r.value
      const recs: any[] = []
      for (const d of (deploys?.items ?? [])) {
        const ns = d.metadata.namespace; const name = d.metadata.name; const key = `${ns}/${name}`
        const desired = d.spec.replicas ?? 1; const ready = d.status.readyReplicas ?? 0; const hasHPA = hpaSet.has(key)
        const cu = cpuMap[key] ?? 0; const mu = memMap[key] ?? 0
        if (cu > 70 || mu > 80) {
          const sug = Math.ceil(desired * Math.max(cu, mu) / 65)
          recs.push({ workload: name, namespace: ns, type: 'scale_up', currentReplicas: desired, suggestedReplicas: sug, cpuUtil: cu > 0 ? `${cu.toFixed(1)}%` : 'no data', memUtil: mu > 0 ? `${mu.toFixed(1)}%` : 'no data', hasHPA, priority: (cu > 90 || mu > 95) ? 'critical' : 'high', command: hasHPA ? `kubectl get hpa -n ${ns} ${name}` : `kubectl scale deployment/${name} --replicas=${sug} -n ${ns}`, hpaCommand: !hasHPA ? `kubectl autoscale deployment/${name} -n ${ns} --cpu-percent=70 --min=${desired} --max=${Math.max(sug * 2, desired * 3)}` : null })
        }
        if (desired === 1 && ready === 1 && !hasHPA) recs.push({ workload: name, namespace: ns, type: 'availability_risk', currentReplicas: 1, suggestedReplicas: 2, reason: 'Single replica is a SPOF — any restart causes downtime', priority: 'medium', command: `kubectl scale deployment/${name} --replicas=2 -n ${ns}` })
      }
      return { source: 'live', namespace: namespace ?? 'all', totalRecommendations: recs.length, criticalCount: recs.filter((r) => r.priority === 'critical').length, recommendations: recs.sort((a, b) => { const o: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }; return (o[a.priority] ?? 3) - (o[b.priority] ?? 3) }).slice(0, 15), summary: recs.length === 0 ? 'All workloads appropriately scaled.' : `${recs.filter((r) => r.priority === 'critical').length} critical, ${recs.length} total scaling recommendations.` }
    },
  }),

  recommend_security: tool({
    description: 'Security scan: privileged containers, root UID, missing limits, :latest tags, hostPID/Network/IPC, missing NetworkPolicies.',
    parameters: z.object({
      namespace: z.string().optional().describe('Limit scan to namespace. Omit for cluster-wide.'),
    }),
    execute: async ({ namespace }) => {
      const nsP = namespace ? `/namespaces/${namespace}` : ''
      const [pods, netpols] = await Promise.all([
        k8sGet(`/api/v1${nsP}/pods`),
        k8sGet(`/apis/networking.k8s.io/v1${nsP}/networkpolicies`),
      ])
      const findings: any[] = []
      const nsPolicies = new Set((netpols?.items ?? []).map((n: any) => n.metadata.namespace))
      const nsSet = new Set<string>()
      for (const pod of (pods?.items ?? [])) {
        const ns = pod.metadata.namespace; const name = pod.metadata.name; nsSet.add(ns)
        for (const c of (pod.spec?.containers ?? [])) {
          const sc = c.securityContext ?? {}
          if (sc.privileged) findings.push({ severity: 'critical', category: 'Privilege Escalation', resource: `${ns}/${name}`, container: c.name, finding: 'privileged: true', remediation: 'Remove securityContext.privileged' })
          if (sc.runAsUser === 0) findings.push({ severity: 'high', category: 'Root Access', resource: `${ns}/${name}`, container: c.name, finding: 'Runs as root (UID 0)', remediation: 'Set runAsNonRoot: true, runAsUser: 1000' })
          if (!c.resources?.limits?.cpu || !c.resources?.limits?.memory) findings.push({ severity: 'medium', category: 'Resource Management', resource: `${ns}/${name}`, container: c.name, finding: 'No CPU/memory limits', remediation: 'Set resources.limits.cpu and .memory' })
          if (c.image?.endsWith(':latest') || (!c.image?.includes(':') && c.image)) findings.push({ severity: 'medium', category: 'Image Hygiene', resource: `${ns}/${name}`, container: c.name, finding: `:latest tag (${c.image})`, remediation: 'Pin to semver or digest' })
          if (sc.allowPrivilegeEscalation !== false) findings.push({ severity: 'medium', category: 'Privilege Escalation', resource: `${ns}/${name}`, container: c.name, finding: 'allowPrivilegeEscalation not false', remediation: 'Set allowPrivilegeEscalation: false' })
        }
        if (pod.spec?.hostPID)     findings.push({ severity: 'critical', category: 'Host Namespace', resource: `${ns}/${name}`, container: 'pod', finding: 'hostPID: true',     remediation: 'Remove hostPID' })
        if (pod.spec?.hostNetwork) findings.push({ severity: 'high',     category: 'Host Namespace', resource: `${ns}/${name}`, container: 'pod', finding: 'hostNetwork: true', remediation: 'Remove unless required' })
        if (pod.spec?.hostIPC)     findings.push({ severity: 'high',     category: 'Host Namespace', resource: `${ns}/${name}`, container: 'pod', finding: 'hostIPC: true',     remediation: 'Remove hostIPC' })
      }
      const skipNs = new Set(['kube-system', 'kube-public', 'kube-node-lease'])
      for (const ns of nsSet) {
        if (!nsPolicies.has(ns) && !skipNs.has(ns)) findings.push({ severity: 'medium', category: 'Network Policy', resource: ns, container: 'namespace', finding: `No NetworkPolicy in "${ns}"`, remediation: `Apply default-deny NetworkPolicy to ${ns}` })
      }
      const deduped = findings.reduce((acc: any[], f: any) => { const key = `${f.category}|${f.resource}|${f.finding}`; if (!acc.find((x: any) => `${x.category}|${x.resource}|${x.finding}` === key)) acc.push(f); return acc }, []).sort((a: any, b: any) => { const o: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }; return (o[a.severity] ?? 3) - (o[b.severity] ?? 3) }).slice(0, 40)
      const crit = deduped.filter((f) => f.severity === 'critical').length
      const high = deduped.filter((f) => f.severity === 'high').length
      const med  = deduped.filter((f) => f.severity === 'medium').length
      return { source: 'live', namespace: namespace ?? 'cluster-wide', totalFindings: deduped.length, critical: crit, high, medium: med, riskScore: Math.min(100, crit * 20 + high * 10 + med * 3), findings: deduped, topIssue: deduped[0] ?? null, summary: `${crit} critical, ${high} high, ${med} medium security findings across ${nsSet.size} namespace(s).` }
    },
  }),

  suggest_remediation: tool({
    description: 'Targeted remediation steps for a problem — detects crash loop, OOM, image pull, and pending failures from live pod state.',
    parameters: z.object({
      problem:   z.string().describe('Problem description'),
      namespace: z.string().optional(),
      resource:  z.string().optional().describe('Target deployment name'),
    }),
    execute: async ({ problem, namespace, resource }) => {
      const [podData, deployData, eventData] = await Promise.all([
        namespace ? k8sGet(`/api/v1/namespaces/${namespace}/pods`) : k8sGet('/api/v1/pods?limit=100'),
        namespace ? k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments`) : null,
        namespace ? k8sGet(`/api/v1/namespaces/${namespace}/events?fieldSelector=type=Warning`) : null,
      ])
      const allPods     = podData?.items ?? []
      const deployNames = (deployData?.items ?? []).map((d: any) => d.metadata.name)
      const ns  = namespace ?? '<namespace>'
      const res = resource ?? deployNames[0] ?? '<resource>'

      // Categorize by real container state reason
      const crashPods   = allPods.filter((p: any) => p.status?.containerStatuses?.some((c: any) => c.state?.waiting?.reason === 'CrashLoopBackOff'))
      const oomPods     = allPods.filter((p: any) => p.status?.containerStatuses?.some((c: any) => c.lastState?.terminated?.reason === 'OOMKilled'))
      const imagePods   = allPods.filter((p: any) => p.status?.containerStatuses?.some((c: any) => ['ImagePullBackOff', 'ErrImagePull'].includes(c.state?.waiting?.reason ?? '')))
      const pendingPods = allPods.filter((p: any) => p.status?.phase === 'Pending')
      const failedPods  = allPods.filter((p: any) => p.status?.phase !== 'Running' && p.status?.phase !== 'Succeeded')

      const isCrash   = crashPods.length > 0   || /crash|backoff|restart/i.test(problem)
      const isOOM     = oomPods.length > 0      || /oom|memory|killed/i.test(problem)
      const isImage   = imagePods.length > 0   || /image|pull|registry/i.test(problem)
      const isPending = pendingPods.length > 0  || /pending|schedul/i.test(problem)
      const primaryPod = crashPods[0]?.metadata.name ?? oomPods[0]?.metadata.name ?? failedPods[0]?.metadata.name
      const recentEvents = ((eventData?.items ?? []) as any[]).slice(0, 5).map((e: any) => e.message).filter(Boolean)

      const steps: any[] = [
        { priority: 1, action: 'Check pod status', command: `kubectl get pods -n ${ns} --sort-by=.status.phase -o wide` },
        { priority: 2, action: 'Recent warning events', command: `kubectl get events -n ${ns} --field-selector=type=Warning --sort-by=.lastTimestamp | tail -20` },
      ]
      if (isCrash && primaryPod) {
        steps.push({ priority: 3, action: 'Fetch crash logs (previous container)', command: `kubectl logs -n ${ns} ${primaryPod} --previous --tail=150` })
        steps.push({ priority: 4, action: 'Describe crashlooping pod', command: `kubectl describe pod ${primaryPod} -n ${ns}` })
        steps.push({ priority: 5, action: 'Check deployment rollout history', command: `kubectl rollout history deployment/${res} -n ${ns}` })
        steps.push({ priority: 6, action: 'Rolling restart', command: `kubectl rollout restart deployment/${res} -n ${ns}` })
        steps.push({ priority: 7, action: 'Watch rollout', command: `kubectl rollout status deployment/${res} -n ${ns} --timeout=120s` })
      } else if (isOOM && primaryPod) {
        steps.push({ priority: 3, action: 'Check current memory usage', command: `kubectl top pods -n ${ns} --containers` })
        steps.push({ priority: 4, action: 'OOMKill details', command: `kubectl describe pod ${primaryPod} -n ${ns} | grep -A10 "Last State"` })
        steps.push({ priority: 5, action: 'Increase memory limit (+50%)', command: `kubectl set resources deployment/${res} -n ${ns} --limits=memory=512Mi --requests=memory=256Mi` })
        steps.push({ priority: 6, action: 'Restart after limit change', command: `kubectl rollout restart deployment/${res} -n ${ns}` })
      } else if (isImage && imagePods.length > 0) {
        const imgPod = imagePods[0].metadata.name
        steps.push({ priority: 3, action: 'Get image pull error details', command: `kubectl describe pod ${imgPod} -n ${ns} | grep -A5 "Failed\\|pull\\|Error"` })
        steps.push({ priority: 4, action: 'List image pull secrets', command: `kubectl get secret -n ${ns} | grep -i docker` })
        steps.push({ priority: 5, action: 'Show current image tag', command: `kubectl get pod ${imgPod} -n ${ns} -o jsonpath='{.spec.containers[*].image}'` })
      } else if (isPending && pendingPods.length > 0) {
        const ppod = pendingPods[0].metadata.name
        steps.push({ priority: 3, action: 'Scheduling failure reason', command: `kubectl describe pod ${ppod} -n ${ns} | grep -A10 "Events:"` })
        steps.push({ priority: 4, action: 'Node resource availability', command: `kubectl describe nodes | grep -A5 "Allocated resources"` })
        steps.push({ priority: 5, action: 'Check namespace quota', command: `kubectl describe resourcequota -n ${ns}` })
      } else {
        steps.push({ priority: 3, action: 'Inspect logs', command: primaryPod ? `kubectl logs -n ${ns} ${primaryPod} --tail=100 --previous` : `kubectl logs -n ${ns} -l app=${res} --tail=100` })
        steps.push({ priority: 4, action: 'Describe resource', command: `kubectl describe deployment/${res} -n ${ns}` })
        steps.push({ priority: 5, action: 'Rolling restart', command: `kubectl rollout restart deployment/${res} -n ${ns}` })
        steps.push({ priority: 6, action: 'Check resource quotas', command: `kubectl describe resourcequota -n ${ns}` })
      }
      const failureType = isCrash ? 'crash_loop' : isOOM ? 'oom_killed' : isImage ? 'image_pull_error' : isPending ? 'scheduling_failure' : 'general'
      return {
        problem, namespace: ns, failureType,
        liveContext: { failedPods: failedPods.slice(0, 5).map((p: any) => p.metadata.name), crashPods: crashPods.slice(0, 3).map((p: any) => p.metadata.name), oomPods: oomPods.slice(0, 3).map((p: any) => p.metadata.name), recentEvents, deployments: deployNames.slice(0, 5) },
        steps,
        escalation: problem.toLowerCase().includes('critical') || problem.toLowerCase().includes('down')
          ? 'Page on-call SRE immediately. Check PagerDuty for active escalation policies.'
          : 'Monitor for 15 minutes after applying fixes. Open P2 ticket if unresolved.',
      }
    },
  }),

  generate_workflow: tool({
    description: 'Multi-phase remediation workflow with approval gates, risk ratings, rollback commands.',
    parameters: z.object({
      problem:   z.string().describe('Problem description — be specific'),
      namespace: z.string().optional(),
      resource:  z.string().optional().describe('Target deployment or resource name'),
    }),
    execute: async ({ problem, namespace, resource }) => {
      const [podData, deployData] = await Promise.all([
        namespace ? k8sGet(`/api/v1/namespaces/${namespace}/pods`) : null,
        namespace ? k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments`) : null,
      ])
      const failedPods = (podData?.items ?? []).filter((p: any) => p.status?.phase !== 'Running').map((p: any) => p.metadata.name)
      const allDeploys = (deployData?.items ?? []).map((d: any) => d.metadata.name)
      const ns     = namespace ?? '<namespace>'
      const target = resource ?? allDeploys[0] ?? '<deployment>'
      const isOOM   = /oom|memory|killed/i.test(problem)
      const isCrash = /crash|backoff|restart/i.test(problem)
      type Step = { id: string; order: number; phase: string; action: string; command: string; description: string; risk: string; requiresApproval: boolean; dryRunSafe: boolean; rollbackCommand?: string }
      const steps: Step[] = [
        { id: 'diagnose-1', order: 1, phase: 'Diagnose', action: 'Assess current pod state', command: `kubectl get pods -n ${ns} --sort-by=.status.phase -o wide`, description: 'Overview of all pod health in the namespace', risk: 'none', requiresApproval: false, dryRunSafe: true },
        { id: 'diagnose-2', order: 2, phase: 'Diagnose', action: 'Inspect recent warning events', command: `kubectl get events -n ${ns} --field-selector=type=Warning --sort-by=.lastTimestamp | tail -30`, description: 'Timeline of warning events for root cause clues', risk: 'none', requiresApproval: false, dryRunSafe: true },
      ]
      if (failedPods.length > 0) steps.push({ id: 'diagnose-3', order: 3, phase: 'Diagnose', action: 'Fetch failing pod logs', command: `kubectl logs -n ${ns} ${failedPods[0]} --tail=100 --previous 2>/dev/null || kubectl logs -n ${ns} ${failedPods[0]} --tail=100`, description: `Collect logs from ${failedPods[0]}`, risk: 'none', requiresApproval: false, dryRunSafe: true })
      steps.push(
        { id: 'remediate-1', order: steps.length + 1, phase: 'Remediate', action: 'Rolling restart deployment', command: `kubectl rollout restart deployment/${target} -n ${ns}`, description: `Trigger rolling restart of ${target}. Zero-downtime via rolling update strategy.`, risk: 'low', requiresApproval: true, dryRunSafe: false, rollbackCommand: `kubectl rollout undo deployment/${target} -n ${ns}` },
        { id: 'verify-1', order: steps.length + 2, phase: 'Verify', action: 'Monitor rollout progress', command: `kubectl rollout status deployment/${target} -n ${ns} --timeout=120s`, description: 'Wait for rollout to complete', risk: 'none', requiresApproval: false, dryRunSafe: true },
        { id: 'verify-2', order: steps.length + 3, phase: 'Verify', action: 'Confirm all pods healthy', command: `kubectl get pods -n ${ns} -l app=${target}`, description: 'Verify new pods are Running and ready', risk: 'none', requiresApproval: false, dryRunSafe: true },
      )
      if (isOOM)   steps.push({ id: 'optimize-1', order: steps.length + 1, phase: 'Optimize', action: 'Increase memory limits', command: `kubectl set resources deployment/${target} -n ${ns} --limits=memory=512Mi --requests=memory=256Mi`, description: 'Increase memory limit to prevent OOMKill recurrence', risk: 'medium', requiresApproval: true, dryRunSafe: false, rollbackCommand: `kubectl rollout undo deployment/${target} -n ${ns}` })
      if (isCrash) steps.push({ id: 'optimize-2', order: steps.length + 1, phase: 'Optimize', action: 'Add readiness probe backoff', command: `kubectl patch deployment/${target} -n ${ns} -p '{"spec":{"template":{"spec":{"containers":[{"name":"${target}","readinessProbe":{"initialDelaySeconds":30,"periodSeconds":10,"failureThreshold":6}}]}}}}'`, description: 'Increase restart tolerance to break crash loop', risk: 'low', requiresApproval: true, dryRunSafe: false })
      steps.forEach((s, i) => { s.order = i + 1 })
      return { source: 'live', problem, workflow: { id: `wf-${Date.now()}`, title: `Remediation: ${problem.slice(0, 60)}`, namespace: ns, targetResource: target, estimatedDuration: `${steps.length * 2}–${steps.length * 5} minutes`, riskLevel: steps.some((s) => s.risk === 'high') ? 'high' : steps.some((s) => s.risk === 'medium') ? 'medium' : 'low', requiresApproval: steps.some((s) => s.requiresApproval), steps, phases: ['Diagnose', 'Remediate', 'Verify', 'Optimize'], rollbackPlan: `kubectl rollout undo deployment/${target} -n ${ns}`, liveContext: { failedPods: failedPods.slice(0, 5), availableDeployments: allDeploys.slice(0, 5) } } }
    },
  }),

  silence_alert: tool({
    description: 'Silence a Prometheus alert in Alertmanager for a specified duration. Use for known false positives like k3d control-plane alerts.',
    parameters: z.object({
      alertname:     z.string().describe('Alert name to silence (e.g. KubeControllerManagerDown)'),
      durationHours: z.number().default(168).describe('Silence duration in hours (default 7 days)'),
      reason:        z.string().describe('Reason for silencing — will appear in Alertmanager UI'),
      namespace:     z.string().optional().describe('Optional: also match on namespace label'),
    }),
    execute: async ({ alertname, durationHours, reason, namespace }) => {
      const AM = await resolveAlertmanagerUrl()
      if (!AM) return { source: 'unavailable', error: 'ALERTMANAGER_URL not set in .env.local — add it pointing to your Alertmanager (default port 9093)' }
      const now = new Date()
      const end = new Date(now.getTime() + durationHours * 60 * 60 * 1000)
      const matchers: any[] = [{ name: 'alertname', value: alertname, isRegex: false, isEqual: true }]
      if (namespace) matchers.push({ name: 'namespace', value: namespace, isRegex: false, isEqual: true })
      try {
        const r = await fetch(`${AM}/api/v2/silences`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchers, startsAt: now.toISOString(), endsAt: end.toISOString(), createdBy: 'nativeops-ai', comment: reason }),
          signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
        })
        if (!r.ok) return { source: 'error', error: `Alertmanager ${r.status}: ${(await r.text()).slice(0, 200)}` }
        const data = await r.json()
        return { source: 'live', status: 'silenced', alertname, durationHours, silenceId: data.silenceID, endsAt: end.toISOString(), reason, message: `✅ ${alertname} silenced for ${durationHours}h — expires ${end.toLocaleDateString()}` }
      } catch (e: any) { return { source: 'error', alertname, error: e.message } }
    },
  }),

  execute_remediation: tool({
    description: 'K8s operation (restart/scale/delete/cordon). Dry-run by default; set dryRun:false for live execution.',
    parameters: z.object({
      action:   z.enum(['restart_deployment', 'scale_deployment', 'delete_pod', 'cordon_node', 'uncordon_node']),
      namespace: z.string().optional(),
      name:      z.string().describe('Resource name'),
      replicas:  z.number().optional().describe('For scale_deployment'),
      dryRun:    z.boolean().default(true).describe('Set false only when user explicitly approves'),
    }),
    execute: async ({ action, namespace, name, replicas, dryRun }) => {
      const K8S = await resolveK8sUrl()
      const ns = namespace ?? 'default'
      const dryP = dryRun ? '?dryRun=All' : ''
      const t0 = Date.now()
      let endpoint = ''; let method = 'PATCH'; let body: object | null = null
      switch (action) {
        case 'restart_deployment':  endpoint = `/apis/apps/v1/namespaces/${ns}/deployments/${name}`;       body = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } }; break
        case 'scale_deployment':    if (!replicas) return { source: 'error', error: 'replicas required' }; endpoint = `/apis/apps/v1/namespaces/${ns}/deployments/${name}/scale`; body = { spec: { replicas } }; break
        case 'delete_pod':          endpoint = `/api/v1/namespaces/${ns}/pods/${name}`; method = 'DELETE'; body = null; break
        case 'cordon_node':         endpoint = `/api/v1/nodes/${name}`; body = { spec: { unschedulable: true } }; break
        case 'uncordon_node':       endpoint = `/api/v1/nodes/${name}`; body = { spec: { unschedulable: false } }; break
        default:                    return { source: 'error', error: `Unknown action: ${action}` }
      }
      try {
        const r = await fetch(`${K8S}${endpoint}${dryP}`, { method, headers: body ? { 'Content-Type': 'application/strategic-merge-patch+json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) })
        const latency = Date.now() - t0
        if (r.ok) return { source: 'live', status: dryRun ? 'dry_run_success' : 'executed', action, name, namespace: ns, dryRun, latencyMs: latency, message: dryRun ? '✅ Dry-run succeeded — command is valid. Click Execute in the workflow card to run live.' : `✅ ${action} executed successfully on ${name} in ${ns}` }
        return { source: 'live', status: 'failed', action, name, namespace: ns, dryRun, httpStatus: r.status, error: (await r.text()).slice(0, 200) }
      } catch (e: any) { return { source: 'error', action, name, namespace: ns, dryRun, error: e.message } }
    },
  }),
}

// ── Route handler ─────────────────────────────────────────────
export async function POST(req: Request) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const session = await auth()
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Rate limit (20 req/min per user) ─────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rlKey = (session.user as any)?.email ?? (session.user as any)?.id ?? 'anon'
  const { ok: rlOk, retryAfterSecs } = checkRateLimit(rlKey)
  if (!rlOk) {
    return new Response(
      JSON.stringify({ error: `Rate limit exceeded. Try again in ${retryAfterSecs}s.` }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSecs) } },
    )
  }

  let configuredProvider = process.env.AI_PROVIDER ?? 'groq'
  let configuredKey = process.env.AI_API_KEY ?? process.env.GROQ_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? ''
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    configuredProvider = cfg.ai_provider ?? configuredProvider
    configuredKey = cfg.ai_api_key ?? (configuredProvider === 'groq' ? cfg.groq_api_key : configuredKey)
  } catch {}
  if (!configuredKey) {
    return new Response(
      JSON.stringify({ error: `No API key configured for ${configuredProvider}. Configure it in Settings → AI Provider or set the matching environment variable.` }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }
  try {
    const { messages } = await req.json() as { messages: unknown[] }

    // 1. Limit history to last 12 messages — supports 4-step tool chains (each step = 2 messages)
    const trimmedMessages = (messages as any[]).slice(-12) as Parameters<typeof streamText>[0]['messages']

    // 2. Null-safe params (Llama passes null for no-arg tools) + cap tool result size to ~1500 chars
    const MAX_RESULT = 1500
    const safeTools = Object.fromEntries(
      Object.entries(tools).map(([name, t]: [string, any]) => [
        name,
        {
          ...t,
          parameters: z.preprocess((v: unknown) => (v == null ? {} : v), t.parameters),
          execute: async (args: any) => {
            const res = await t.execute(args)
            const json = JSON.stringify(res)
            if (json.length <= MAX_RESULT) return res
            // Truncate arrays to top 3 items, keep scalar fields intact
            if (typeof res === 'object' && res !== null) {
              const out: any = {}
              for (const [k, v] of Object.entries(res)) {
                out[k] = Array.isArray(v) ? (v as any[]).slice(0, 8) : v
              }
              return { ...out, _note: `truncated (${json.length} chars)` }
            }
            return res
          },
        },
      ]),
    ) as typeof tools

    const systemPrompt = await buildSystemPrompt()
    const result = streamText({
      model: getModel() as any,
      system: systemPrompt,
      messages: trimmedMessages,
      tools: safeTools, maxSteps: 5, temperature: 0.1, maxTokens: 1500,
      onFinish: ({ usage }) => {
        try {
          const entry = {
            ts:               new Date().toISOString(),
            model:            process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
            promptTokens:     usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens:      usage.totalTokens,
          }
          appendFileSync(USAGE_FILE, JSON.stringify(entry) + '\n')
          // Trim to last 2000 entries
          try {
            const lines = require('fs').readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean)
            if (lines.length > 2000) require('fs').writeFileSync(USAGE_FILE, lines.slice(-2000).join('\n') + '\n')
          } catch {}
        } catch {}
      },
    })
    return result.toDataStreamResponse({
      getErrorMessage: (error) => {
        if (error instanceof Error) return error.message
        return String(error)
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[ai/chat] error:', msg)
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
