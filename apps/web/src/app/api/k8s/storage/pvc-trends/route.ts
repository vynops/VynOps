import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


function linearForecastDaysToFull(points: number[], capacityGiB: number, windowSeconds = 1800): number | null {
  if (points.length < 4 || capacityGiB <= 0) return null
  const n = points.length
  const xMean = (n - 1) / 2
  const yMean = points.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (points[i] - yMean)
    den += (i - xMean) ** 2
  }
  const slope = den === 0 ? 0 : num / den // GiB per 2-min step
  if (slope <= 0.0001) return null
  // R² gate: only forecast if the trend is clean (R² ≥ 0.75)
  const ssRes = points.reduce((acc, y, i) => acc + (y - (yMean + slope * (i - xMean))) ** 2, 0)
  const ssTot = points.reduce((acc, y) => acc + (y - yMean) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot
  if (r2 < 0.75) return null
  const current = points[points.length - 1]
  const remaining = capacityGiB - current
  if (remaining <= 0) return 0
  const stepsToFull = remaining / slope
  const daysToFull = (stepsToFull * 120) / 86400 // 120s step → days
  // Cap forecast at 3× the look-back window to avoid unreliable long-range extrapolation
  const maxForecastDays = (windowSeconds / 86400) * 3
  const result = Math.round(daysToFull * 10) / 10
  return result <= maxForecastDays ? result : null
}

async function k8sGet(k8sUrl: string, path: string): Promise<any> {
  try {
    const res = await fetch(`${k8sUrl}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    return res.json()
  } catch { return null }
}

function parseCapacityGiB(s?: string): number {
  if (!s) return 0
  if (s.endsWith('Ti')) return parseFloat(s) * 1024
  if (s.endsWith('Gi')) return parseFloat(s)
  if (s.endsWith('Mi')) return parseFloat(s) / 1024
  if (s.endsWith('Ki')) return parseFloat(s) / (1024 ** 2)
  if (s.endsWith('G')) return parseFloat(s) * 1000 / 1024
  if (s.endsWith('M')) return parseFloat(s) * 1000 / (1024 ** 2)
  return parseFloat(s) || 0
}

export async function GET() {
  const PROM = await resolvePromUrl()
  if (!PROM) return NextResponse.json({ trends: {} })

  const K8S = await resolveK8sUrl()
  const now = Math.floor(Date.now() / 1000)
  const start = now - 1800 // 30 min window

  try {
    const [usedRes, capRes, pvcData] = await Promise.all([
      fetch(
        `${PROM}/api/v1/query_range?query=${encodeURIComponent('kubelet_volume_stats_used_bytes')}&start=${start}&end=${now}&step=120`,
        { signal: AbortSignal.timeout(10000) },
      ).then(r => r.json()).catch(() => ({ data: { result: [] } })),
      fetch(
        `${PROM}/api/v1/query?query=${encodeURIComponent('kubelet_volume_stats_capacity_bytes')}`,
        { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) },
      ).then(r => r.json()).catch(() => ({ data: { result: [] } })),
      K8S ? k8sGet(K8S, '/api/v1/persistentvolumeclaims') : Promise.resolve(null),
    ])

    // Build K8s-provisioned capacity map: namespace/pvcName → GiB (authoritative size)
    const k8sCapMap: Record<string, number> = {}
    for (const pvc of (pvcData?.items ?? [])) {
      const ns = pvc.metadata?.namespace ?? ''
      const name = pvc.metadata?.name ?? ''
      if (ns && name) {
        k8sCapMap[`${ns}/${name}`] = parseCapacityGiB(pvc.status?.capacity?.storage) || parseCapacityGiB(pvc.spec?.resources?.requests?.storage)
      }
    }

    // Build Prometheus capacity map: namespace/pvcName → GiB
    const promCapMap: Record<string, number> = {}
    for (const r of (capRes.data?.result ?? [])) {
      const ns = r.metric?.namespace ?? ''
      const pvc = r.metric?.persistentvolumeclaim ?? ''
      if (ns && pvc) {
        promCapMap[`${ns}/${pvc}`] = parseFloat(r.value?.[1] ?? '0') / (1024 ** 3)
      }
    }

    // Use K8s capacity as truth; mark PVCs where promCap >> k8s as unreliable (host partition)
    const capMap: Record<string, number> = {}
    const reliableKeys = new Set<string>()
    for (const key of new Set([...Object.keys(k8sCapMap), ...Object.keys(promCapMap)])) {
      const k8sCap = k8sCapMap[key] ?? 0
      const promCap = promCapMap[key] ?? 0
      const reliable = k8sCap === 0 || promCap === 0 || promCap <= k8sCap * 1.1
      capMap[key] = k8sCap || promCap
      if (reliable) reliableKeys.add(key)
    }

    const trends: Record<string, {
      points: number[]
      usedGiB: number
      daysToFull: number | null
      usedPct: number
    }> = {}

    for (const r of (usedRes.data?.result ?? [])) {
      const ns = r.metric?.namespace ?? ''
      const pvc = r.metric?.persistentvolumeclaim ?? ''
      if (!ns || !pvc) continue

      const key = `${ns}/${pvc}`
      // Skip PVCs where Prometheus is reporting host partition stats
      if (!reliableKeys.has(key)) continue

      const points = (r.values ?? []).map((v: any[]) => parseFloat(v[1]) / (1024 ** 3))
      const usedGiB = Math.round((points.at(-1) ?? 0) * 100) / 100
      const capGiB = capMap[key] ?? 0
      if (capGiB <= 0) continue

      const usedPct = Math.round((usedGiB / capGiB) * 100)

      trends[key] = {
        points: points.map((p: number) => Math.round(p * 100) / 100),
        usedGiB,
        daysToFull: linearForecastDaysToFull(points, capGiB),
        usedPct,
      }
    }

    return NextResponse.json({ trends })
  } catch {
    return NextResponse.json({ trends: {} })
  }
}