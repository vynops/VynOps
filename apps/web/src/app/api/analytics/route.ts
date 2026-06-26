import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const SKIP_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

const SLO_TARGETS_FILE = join(process.cwd(), 'data', 'slo-targets.json')
function loadSloTargets(): Record<string, number> {
  try {
    if (existsSync(SLO_TARGETS_FILE)) return JSON.parse(readFileSync(SLO_TARGETS_FILE, 'utf8'))
  } catch {}
  return {}
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function promRange(
  query: string, minutes: number, step: number,
): Promise<{ ts: number; value: number }[]> {
  const PROM = await resolvePromUrl()
  try {
    const now   = Math.floor(Date.now() / 1000)
    const start = now - minutes * 60
    const url   = `${PROM}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${now}&step=${step}`
    const r     = await fetch(url, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } } as RequestInit)
    const j     = await r.json()
    const vals: [number, string][] = j.data?.result?.[0]?.values ?? []
    return vals.map(([t, v]) => ({ ts: t * 1000, value: parseFloat(parseFloat(v).toFixed(2)) }))
  } catch { return [] }
}

async function promInstant(query: string): Promise<number> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 },
    } as RequestInit)
    const j = await r.json()
    return parseFloat(j.data?.result?.[0]?.value?.[1] ?? '0')
  } catch { return 0 }
}

async function promQuery(query: string): Promise<any[]> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 },
    } as RequestInit)
    const j = await r.json()
    return j.data?.result ?? []
  } catch { return [] }
}

async function promRangeAll(
  query: string, minutes: number, step: number,
): Promise<Array<{ metric: Record<string, string>; values: { ts: number; value: number }[] }>> {
  const PROM = await resolvePromUrl()
  try {
    const now   = Math.floor(Date.now() / 1000)
    const start = now - minutes * 60
    const url   = `${PROM}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${now}&step=${step}`
    const r     = await fetch(url, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } } as RequestInit)
    const j     = await r.json()
    return (j.data?.result ?? []).map((res: any) => ({
      metric: res.metric as Record<string, string>,
      values: (res.values ?? []).map(([t, v]: [number, string]) => ({
        ts: t * 1000, value: parseFloat(parseFloat(v).toFixed(3))
      }))
    }))
  } catch { return [] }
}

async function k8sGet(path: string): Promise<any> {
  const K8S = await resolveK8sUrl()
  try {
    const r = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 },
    } as RequestInit)
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

// Linear regression forecast
function linearForecast(
  points: { ts: number; value: number }[],
  horizonH: number,
  stepH: number = 1,
): { ts: number; value: number; forecast: boolean }[] {
  if (points.length < 3) return []
  const xs = points.map(p => p.ts / 3_600_000) // hours
  const ys = points.map(p => p.value)
  const n  = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  const ssXX  = xs.reduce((s, x) => s + (x - meanX) ** 2, 0)
  const ssXY  = xs.reduce((s, x, i) => s + (x - meanX) * (ys[i] - meanY), 0)
  const slope = ssXX !== 0 ? ssXY / ssXX : 0
  const intercept = meanY - slope * meanX
  const lastH = xs[xs.length - 1]
  const out: { ts: number; value: number; forecast: boolean }[] = []
  for (let h = stepH; h <= horizonH; h += stepH) {
    const tsH = lastH + h
    const val = Math.max(0, Math.min(100, intercept + slope * tsH))
    out.push({ ts: Math.round(tsH * 3_600_000), value: parseFloat(val.toFixed(2)), forecast: true })
  }
  return out
}

// Days until value crosses threshold (returns null if never in 90d)
function daysToSaturation(points: { ts: number; value: number }[], threshold = 80): number | null {
  if (points.length < 3) return null
  const current = points[points.length - 1].value
  if (current >= threshold) return 0
  const fc = linearForecast(points, 90 * 24, 24)
  const hit = fc.find(p => p.value >= threshold)
  if (!hit) return null
  return Math.round((hit.ts - points[points.length - 1].ts) / 86_400_000)
}

// ── GET ───────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const windowParam = searchParams.get('window') ?? '24h'

  const windowConfig: Record<string, { minutes: number; step: number; label: string }> = {
    '1h':  { minutes: 60,    step: 60,    label: '1 Hour'   },
    '6h':  { minutes: 360,   step: 300,   label: '6 Hours'  },
    '24h': { minutes: 1440,  step: 3600,  label: '24 Hours' },
    '7d':  { minutes: 10080, step: 21600, label: '7 Days'   },
    '30d': { minutes: 43200, step: 86400, label: '30 Days'  },
  }
  const wc = windowConfig[windowParam] ?? windowConfig['24h']

  // Always use 7d for DORA frequency regardless of display window
  const dora7dStart = Math.floor(Date.now() / 1000) - 7 * 86400

  try {
    const [
      cpuHist, memHist, podHist,
      deplAvailData, deplDesiredData, restartData,
      rsData, deploysData,
      avail1hData, avail6hData, avail30dData, availHistAllData,
    ] = await Promise.all([
      promRange('sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100', wc.minutes, wc.step),
      promRange('(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100', wc.minutes, wc.step),
      promRange('sum(kube_pod_info)', wc.minutes, wc.step),
      promQuery('kube_deployment_status_replicas_available'),
      promQuery('kube_deployment_spec_replicas'),
      promQuery('sum by (namespace,pod) (increase(kube_pod_container_status_restarts_total[24h]))'),
      k8sGet('/apis/apps/v1/replicasets'),
      k8sGet('/apis/apps/v1/deployments'),
      promQuery('avg_over_time(kube_deployment_status_replicas_available[1h]) / avg_over_time(kube_deployment_spec_replicas[1h]) * 100'),
      promQuery('avg_over_time(kube_deployment_status_replicas_available[6h]) / avg_over_time(kube_deployment_spec_replicas[6h]) * 100'),
      promQuery('avg_over_time(kube_deployment_status_replicas_available[30d]) / avg_over_time(kube_deployment_spec_replicas[30d]) * 100'),
      promRangeAll('avg_over_time(kube_deployment_status_replicas_available[1d]) / avg_over_time(kube_deployment_spec_replicas[1d]) * 100', 30*24*60, 86400),
    ])

    // ── Infrastructure ────────────────────────────────────────────────────
    const cpuValues  = cpuHist.map(p => p.value).filter(v => v > 0)
    const memValues  = memHist.map(p => p.value).filter(v => v > 0)
    const podValues  = podHist.map(p => p.value).filter(v => v > 0)

    const cpuCurrent = cpuValues[cpuValues.length - 1] ?? 0
    const memCurrent = memValues[memValues.length - 1] ?? 0
    const podCurrent = podValues[podValues.length - 1] ?? 0

    const cpuAvg  = cpuValues.length  ? cpuValues.reduce((a, b) => a + b, 0)  / cpuValues.length  : 0
    const memAvg  = memValues.length  ? memValues.reduce((a, b) => a + b, 0)  / memValues.length  : 0
    const cpuPeak = cpuValues.length  ? Math.max(...cpuValues) : 0
    const memPeak = memValues.length  ? Math.max(...memValues) : 0

    const restarts24h = (restartData as any[]).reduce((s, r) => s + Math.round(parseFloat(r.value?.[1] ?? '0')), 0)

    // ── DORA ─────────────────────────────────────────────────────────────
    const now7 = new Date()
    const cutoff7 = new Date(now7.getTime() - 7 * 86_400_000)
    const userRS = ((rsData.items ?? []) as any[]).filter(
      (rs: any) => !SKIP_NS.has(rs.metadata.namespace) &&
        new Date(rs.metadata.creationTimestamp) > cutoff7
    )

    // Deployment history by day (last 7)
    const deployByDay: Record<string, number> = {}
    for (let d = 6; d >= 0; d--) {
      const dt = new Date(now7)
      dt.setDate(dt.getDate() - d)
      deployByDay[dt.toISOString().slice(0, 10)] = 0
    }
    for (const rs of userRS) {
      const day = rs.metadata.creationTimestamp.slice(0, 10)
      if (day in deployByDay) deployByDay[day]++
    }
    const deployFrequencyHistory = Object.entries(deployByDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }))

    const deployFrequency7d = parseFloat((userRS.length / 7).toFixed(2))
    const band =
      deployFrequency7d >= 3   ? 'elite' :
      deployFrequency7d >= 1   ? 'high' :
      deployFrequency7d >= 1/7 ? 'medium' :
                                  'low'

    // Change Failure Rate: deployments with unavailable replicas
    const allDeploys = ((deploysData.items ?? []) as any[]).filter(
      (d: any) => !SKIP_NS.has(d.metadata.namespace)
    )
    const failedDeploys = allDeploys.filter(
      (d: any) => (d.status?.unavailableReplicas ?? 0) > 0
    ).length
    const cfr = allDeploys.length > 0
      ? parseFloat(((failedDeploys / allDeploys.length) * 100).toFixed(1))
      : 0
    const successRate = parseFloat((100 - cfr).toFixed(1))

    // ── SLA per deployment ────────────────────────────────────────────────
    const availMap: Record<string, number> = {}
    for (const r of (deplAvailData as any[])) {
      const key = `${r.metric.namespace}/${r.metric.deployment}`
      availMap[key] = parseFloat(r.value?.[1] ?? '0')
    }
    const desiredMap: Record<string, number> = {}
    for (const r of (deplDesiredData as any[])) {
      const key = `${r.metric.namespace}/${r.metric.deployment}`
      desiredMap[key] = parseFloat(r.value?.[1] ?? '0')
    }

    const SLA_TARGET_DEFAULT = 99.9
    const BUDGET_WINDOW_MINS = 30 * 24 * 60  // 30-day rolling window
    const sloTargets = loadSloTargets()

    // Build per-deployment lookup maps from multi-window Prometheus queries
    function makeAvailMap(data: any[]): Record<string, number> {
      const m: Record<string, number> = {}
      for (const r of data) {
        const key = `${r.metric.namespace}/${r.metric.deployment}`
        const val = parseFloat(r.value?.[1] ?? '100')
        if (!isNaN(val)) m[key] = Math.min(100, Math.max(0, parseFloat(val.toFixed(3))))
      }
      return m
    }
    const avail1hMap  = makeAvailMap(avail1hData  as any[])
    const avail6hMap  = makeAvailMap(avail6hData  as any[])
    const avail30dMap = makeAvailMap(avail30dData as any[])

    // Per-deployment 30d daily sparkline history
    const availHistMap: Record<string, { ts: number; value: number }[]> = {}
    for (const r of (availHistAllData as any[])) {
      const key = `${r.metric.namespace}/${r.metric.deployment}`
      availHistMap[key] = r.values
    }

    const slaServices = allDeploys.map((d: any) => {
      const key     = `${d.metadata.namespace}/${d.metadata.name}`
      const desired = desiredMap[key] ?? d.spec?.replicas ?? 1
      const avail   = availMap[key]   ?? d.status?.availableReplicas ?? 0
      const pct        = desired > 0 ? parseFloat(((avail / desired) * 100).toFixed(2)) : 100
      const slaTarget   = sloTargets[key] ?? SLA_TARGET_DEFAULT
      const errBudgRate = Math.max((100 - slaTarget) / 100, 0.0001)  // guard div-by-zero
      const allowedDown = errBudgRate * BUDGET_WINDOW_MINS

      // Multi-window availability (fall back to current if Prometheus has no data)
      const avail1h  = avail1hMap[key]  ?? pct
      const avail6h  = avail6hMap[key]  ?? pct
      const avail30d = avail30dMap[key] ?? pct

      // Status is driven by 30d rolling availability, not instantaneous replica snapshot
      const status = avail30d >= slaTarget ? 'healthy' : avail30d >= slaTarget - 0.5 ? 'at-risk' : 'breached'

      // Burn rates: error rate in window vs steady-state error budget rate
      // burn_rate = 1 → normal consumption; >14.4 in 1h → exhausts 30d budget in 1h
      const burnRate1h = avail1h < 100
        ? parseFloat(((1 - avail1h / 100) / errBudgRate).toFixed(2))
        : 0
      const burnRate6h = avail6h < 100
        ? parseFloat(((1 - avail6h / 100) / errBudgRate).toFixed(2))
        : 0

      // Error budget remaining in minutes (30d rolling)
      const actualDownMins30d   = (1 - avail30d / 100) * BUDGET_WINDOW_MINS
      const budgetRemainingMins = parseFloat((allowedDown - actualDownMins30d).toFixed(1))
      const budgetUsedPct       = Math.min(200, Math.max(0, Math.round((actualDownMins30d / allowedDown) * 100)))

      // Burn classification (Google SRE thresholds)
      const fastBurn = burnRate1h > 14.4 || burnRate6h > 6
      const slowBurn = !fastBurn && (burnRate1h > 3 || burnRate6h > 1.5)

      return {
        name:               d.metadata.name as string,
        namespace:          d.metadata.namespace as string,
        desired,
        available:          Math.round(avail),
        availability:       pct,
        slaTarget:          slaTarget,
        slaStatus:          status,
        budgetUsedPct,
        budgetRemainingMins,
        updatedAt:          d.metadata.creationTimestamp as string,
        avail1h:            parseFloat(avail1h.toFixed(3)),
        avail6h:            parseFloat(avail6h.toFixed(3)),
        avail30d:           parseFloat(avail30d.toFixed(3)),
        burnRate1h,
        burnRate6h,
        fastBurn,
        slowBurn,
        historyPts:         availHistMap[key] ?? [],
      }
    })

    // ── Capacity forecasting ──────────────────────────────────────────────
    // Capacity forecasting: always use ≥24h of history for meaningful regression
    // For short display windows (1h / 6h), fetch a separate 24h series for the model
    const forecastMinutes = Math.max(wc.minutes, 1440)
    const forecastStep    = forecastMinutes === wc.minutes ? wc.step : 3600
    const [cpuHistFc, memHistFc] = forecastMinutes === wc.minutes
      ? [cpuHist, memHist]
      : await Promise.all([
          promRange('sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])) * 100', forecastMinutes, forecastStep),
          promRange('(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100', forecastMinutes, forecastStep),
        ])

    const cpuForecast = linearForecast(cpuHistFc, 48, forecastMinutes === 1440 ? 2 : 12)
    const memForecast = linearForecast(memHistFc, 48, forecastMinutes === 1440 ? 2 : 12)
    const cpuEta = daysToSaturation(cpuHistFc, 80)
    const memEta = daysToSaturation(memHistFc, 80)

    return NextResponse.json({
      window: windowParam,
      windowLabel: wc.label,
      infra: {
        cpu: {
          current:  parseFloat(cpuCurrent.toFixed(1)),
          avg:      parseFloat(cpuAvg.toFixed(1)),
          peak:     parseFloat(cpuPeak.toFixed(1)),
          history:  cpuHist,
          forecast: cpuForecast,
          etaDays:  cpuEta,
        },
        memory: {
          current:  parseFloat(memCurrent.toFixed(1)),
          avg:      parseFloat(memAvg.toFixed(1)),
          peak:     parseFloat(memPeak.toFixed(1)),
          history:  memHist,
          forecast: memForecast,
          etaDays:  memEta,
        },
        pods: {
          current: Math.round(podCurrent),
          history: podHist,
        },
        restarts24h,
      },
      dora: {
        deployFrequency7d,
        band,
        successRate,
        changeFailureRate: cfr,
        failedDeploys,
        totalDeploys7d: userRS.length,
        activeDeploys: allDeploys.length,
        deployFrequencyHistory,
      },
      sla: slaServices,
      source: 'live',
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}