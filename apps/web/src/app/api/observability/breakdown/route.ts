import { NextResponse } from 'next/server'
import { resolvePromUrl, K8S_TIMEOUT_MS } from '@/lib/cluster'

type Row = { name: string; value: number; unit: string; meta?: Record<string, string> }

async function promInstantAt(q: string, time: number): Promise<{ metric: Record<string, string>; value: number }[]> {
  const PROM = await resolvePromUrl()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), K8S_TIMEOUT_MS)
    const url = `${PROM}/api/v1/query?query=${encodeURIComponent(q)}&time=${time}`
    const r   = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    const j   = await r.json()
    return (j.data?.result ?? []).map((item: any) => ({
      metric: item.metric ?? {},
      value:  parseFloat(parseFloat(item.value?.[1] ?? '0').toFixed(2)),
    }))
  } catch { return [] }
}

// ── Level 1: top contributors ─────────────────────────────────────────────────
async function level1(metric: string, time: number): Promise<Row[]> {
  let rows: Row[] = []

  if (metric === 'cpu') {
    const pods = await promInstantAt(
      'topk(10, sum by (pod, namespace) (rate(container_cpu_usage_seconds_total{container!="",pod!=""}[5m])) * 100)',
      time,
    )
    if (pods.length > 0) {
      rows = pods.map(r => ({
        name: `${r.metric.namespace ?? ''}/${r.metric.pod ?? ''}`,
        value: r.value, unit: '%',
        meta: { pod: r.metric.pod ?? '', namespace: r.metric.namespace ?? '' },
      }))
    } else {
      const ns = await promInstantAt(
        'topk(10, sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=""}[5m])) * 100)', time)
      if (ns.length > 0) {
        rows = ns.map(r => ({ name: r.metric.namespace ?? 'unknown', value: r.value, unit: '%', meta: { namespace: r.metric.namespace ?? '' } }))
      } else {
        const nodes = await promInstantAt(
          'topk(10, sum by (node) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum by (node) (rate(node_cpu_seconds_total[5m])) * 100)', time)
        rows = nodes.map(r => ({ name: r.metric.node ?? 'node', value: r.value, unit: '%', meta: { node: r.metric.node ?? '' } }))
      }
    }
  }

  else if (metric === 'memory') {
    const pods = await promInstantAt(
      'topk(10, sum by (pod, namespace) (container_memory_working_set_bytes{container!="",pod!=""}) / 1024 / 1024)', time)
    if (pods.length > 0) {
      rows = pods.map(r => ({
        name: `${r.metric.namespace ?? ''}/${r.metric.pod ?? ''}`,
        value: r.value, unit: 'MiB',
        meta: { pod: r.metric.pod ?? '', namespace: r.metric.namespace ?? '' },
      }))
    } else {
      const ns = await promInstantAt(
        'topk(10, sum by (namespace) (container_memory_working_set_bytes{container!=""}) / 1024 / 1024)', time)
      rows = ns.map(r => ({ name: r.metric.namespace ?? 'unknown', value: r.value, unit: 'MiB', meta: { namespace: r.metric.namespace ?? '' } }))
    }
  }

  else if (metric === 'network_rx') {
    const pods = await promInstantAt(
      'topk(10, sum by (pod, namespace) (rate(container_network_receive_bytes_total{namespace!=""}[5m])) / 1024 / 1024)',
      time,
    )
    if (pods.length > 0) {
      rows = pods.map(r => ({
        name: `${r.metric.namespace ?? ''}/${r.metric.pod ?? ''}`,
        value: r.value, unit: 'MB/s',
        meta: { pod: r.metric.pod ?? '', namespace: r.metric.namespace ?? '' },
      }))
    } else {
      const ns = await promInstantAt(
        'topk(10, sum by (namespace) (rate(container_network_receive_bytes_total{namespace!=""}[5m])) / 1024 / 1024)', time)
      rows = ns.map(r => ({ name: r.metric.namespace ?? 'unknown', value: r.value, unit: 'MB/s', meta: { namespace: r.metric.namespace ?? '' } }))
    }
  }

  else if (metric === 'network_tx') {
    const pods = await promInstantAt(
      'topk(10, sum by (pod, namespace) (rate(container_network_transmit_bytes_total{namespace!=""}[5m])) / 1024 / 1024)',
      time,
    )
    if (pods.length > 0) {
      rows = pods.map(r => ({
        name: `${r.metric.namespace ?? ''}/${r.metric.pod ?? ''}`,
        value: r.value, unit: 'MB/s',
        meta: { pod: r.metric.pod ?? '', namespace: r.metric.namespace ?? '' },
      }))
    } else {
      const ns = await promInstantAt(
        'topk(10, sum by (namespace) (rate(container_network_transmit_bytes_total{namespace!=""}[5m])) / 1024 / 1024)', time)
      rows = ns.map(r => ({ name: r.metric.namespace ?? 'unknown', value: r.value, unit: 'MB/s', meta: { namespace: r.metric.namespace ?? '' } }))
    }
  }

  else if (metric === 'requests') {
    const res = await promInstantAt(
      'topk(10, sum by (service,exported_service,ingress,namespace) (rate(nginx_ingress_controller_requests[5m])))', time)
    rows = res.map(r => ({
      name: r.metric.service || r.metric.exported_service || r.metric.ingress || r.metric.namespace || 'unknown',
      value: r.value, unit: 'rps',
      meta: { service: r.metric.service || r.metric.exported_service || r.metric.ingress || '', namespace: r.metric.namespace ?? '' },
    }))
  }

  else if (metric === 'errors') {
    const res = await promInstantAt(
      'topk(10, sum by (service,exported_service,ingress,namespace,status) (rate(nginx_ingress_controller_requests{status=~"5.."}[5m])))', time)
    rows = res.map(r => ({
      name: r.metric.service || r.metric.exported_service || r.metric.ingress || r.metric.namespace || 'unknown',
      value: r.value, unit: 'err/s',
      meta: { service: r.metric.service || r.metric.exported_service || r.metric.ingress || '', namespace: r.metric.namespace ?? '' },
    }))
  }

  else if (metric === 'latency') {
    const res = await promInstantAt(
      'topk(10, histogram_quantile(0.99, sum by (service,exported_service,le) (rate(nginx_ingress_controller_request_duration_seconds_bucket[5m]))) * 1000)', time)
    rows = res.map(r => ({
      name: r.metric.service || r.metric.exported_service || 'unknown',
      value: r.value, unit: 'ms',
      meta: { service: r.metric.service || r.metric.exported_service || '' },
    }))
  }

  return rows.filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10)
}

// ── Level 2: sub-breakdown for a specific row ─────────────────────────────────
async function level2(metric: string, time: number, sub: string, namespace: string): Promise<Row[]> {
  let rows: Row[] = []

  if (metric === 'cpu') {
    // Containers within the pod
    const res = await promInstantAt(
      `sum by (container) (rate(container_cpu_usage_seconds_total{pod="${sub}",namespace="${namespace}",container!=""}[5m])) * 100`,
      time,
    )
    rows = res.map(r => ({ name: r.metric.container ?? 'unknown', value: r.value, unit: '%' }))
    // If no pod match, try namespace → pods in namespace
    if (rows.length === 0) {
      const ns = await promInstantAt(
        `topk(10, sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="${sub}",container!=""}[5m])) * 100)`, time)
      rows = ns.map(r => ({ name: r.metric.pod ?? 'unknown', value: r.value, unit: '%' }))
    }
  }

  else if (metric === 'memory') {
    const res = await promInstantAt(
      `sum by (container) (container_memory_working_set_bytes{pod="${sub}",namespace="${namespace}",container!=""}) / 1024 / 1024`,
      time,
    )
    rows = res.map(r => ({ name: r.metric.container ?? 'unknown', value: r.value, unit: 'MiB' }))
    if (rows.length === 0) {
      const ns = await promInstantAt(
        `topk(10, sum by (pod) (container_memory_working_set_bytes{namespace="${sub}",container!=""}) / 1024 / 1024)`, time)
      rows = ns.map(r => ({ name: r.metric.pod ?? 'unknown', value: r.value, unit: 'MiB' }))
    }
  }

  else if (metric === 'requests') {
    // Status code split for the service
    const res = await promInstantAt(
      `sum by (status) (rate(nginx_ingress_controller_requests{service="${sub}"}[5m]))`,
      time,
    )
    // Fallback: by exported_service or ingress
    const actual = res.length > 0 ? res : await promInstantAt(
      `sum by (status) (rate(nginx_ingress_controller_requests{exported_service="${sub}"}[5m]))`, time)
    rows = actual.map(r => ({ name: `HTTP ${r.metric.status ?? '?'}`, value: r.value, unit: 'rps' }))
  }

  else if (metric === 'errors') {
    // Error status codes for the service
    const res = await promInstantAt(
      `sum by (status) (rate(nginx_ingress_controller_requests{service="${sub}",status=~"[45].."}[5m]))`,
      time,
    )
    const actual = res.length > 0 ? res : await promInstantAt(
      `sum by (status) (rate(nginx_ingress_controller_requests{exported_service="${sub}",status=~"[45].."}[5m]))`, time)
    rows = actual.map(r => ({ name: `HTTP ${r.metric.status ?? '?'}`, value: r.value, unit: 'err/s' }))
  }

  else if (metric === 'latency') {
    // Percentile breakdown for the service
    const percentiles = [0.50, 0.75, 0.90, 0.95, 0.99]
    const results = await Promise.all(
      percentiles.map(p =>
        promInstantAt(
          `histogram_quantile(${p}, sum by (le) (rate(nginx_ingress_controller_request_duration_seconds_bucket{service="${sub}"}[5m]))) * 1000`,
          time,
        )
      )
    )
    rows = percentiles
      .map((p, i) => ({ name: `p${Math.round(p * 100)}`, value: results[i][0]?.value ?? 0, unit: 'ms' }))
      .filter(r => r.value > 0)
  }

  return rows.filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const metric    = searchParams.get('metric') ?? 'cpu'
  const at        = searchParams.get('at')
  const time      = at ? parseFloat(at) : Math.floor(Date.now() / 1000)
  const sub       = searchParams.get('sub')        // level-2: row name (pod/service)
  const namespace = searchParams.get('namespace') ?? ''

  const rows = sub
    ? await level2(metric, time, sub, namespace)
    : await level1(metric, time)

  return NextResponse.json({ metric, at: time, sub: sub ?? null, rows })
}
