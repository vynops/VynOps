import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

async function gpGet(k8sUrl: string, path: string) {
  const gpSvc = `${k8sUrl}/api/v1/namespaces/monitoring/services/goldpinger:8081/proxy`
  try {
    const r = await fetch(`${gpSvc}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    return r.text()
  } catch { return '' }
}

async function k8sGet(k8sUrl: string, path: string) {
  try {
    const r = await fetch(`${k8sUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    return r.json()
  } catch { return null }
}

/** Parse Prometheus text-format metrics into { [key]: number } */
function parsePromText(text: string, metricName: string): { labels: Record<string,string>; value: number }[] {
  const out: { labels: Record<string,string>; value: number }[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith(metricName + '{')) continue
    const labelsStr = line.match(/\{([^}]+)\}/)?.[1] ?? ''
    const valueStr  = line.split('} ').at(-1)?.trim() ?? ''
    const value = parseFloat(valueStr)
    if (isNaN(value)) continue
    const labels: Record<string,string> = {}
    for (const pair of labelsStr.split(',')) {
      const [k, v] = pair.split('=')
      if (k && v) labels[k.trim()] = v.replace(/^"|"$/g, '').trim()
    }
    out.push({ labels, value })
  }
  return out
}

export async function GET() {
  const K8S = await resolveK8sUrl()
  try {
    // 1. Get check_all — hosts list + ok status from all pods
    const checkAllText = await gpGet(K8S, '/check_all')
    if (!checkAllText) {
      return NextResponse.json({ available: false, reason: 'goldpinger not installed' })
    }
    const checkAll = JSON.parse(checkAllText)

    // 2. Build hostIP → nodeName from K8s nodes
    const nodesResp = await k8sGet(K8S, '/api/v1/nodes')
    const hostIpToNode: Record<string, string> = {}
    for (const node of (nodesResp?.items ?? [])) {
      const name: string = node.metadata.name
      for (const addr of (node.status?.addresses ?? [])) {
        if (addr.type === 'InternalIP' || addr.type === 'ExternalIP') {
          hostIpToNode[addr.address] = name
        }
      }
    }

    // 3. Build hosts list: podName → { nodeName, hostIP, podIP }
    const hosts: { podName: string; nodeName: string; hostIP: string; podIP: string }[] =
      (checkAll.hosts ?? []).map((h: any) => ({
        podName: h.podName,
        hostIP:  h.hostIP,
        podIP:   h.podIP,
        nodeName: hostIpToNode[h.hostIP] ?? h.hostIP,
      }))

    // 4. Get pod list to scrape individual metrics
    const podsResp = await k8sGet(K8S, '/api/v1/namespaces/monitoring/pods')
    const gpPods: string[] = (podsResp?.items ?? [])
      .filter((p: any) => p.metadata.name.startsWith('goldpinger-'))
      .map((p: any) => p.metadata.name)

    // 5. Scrape metrics from each goldpinger pod and collect sum/count
    //    key: "sourceNode|targetHostIP"
    const latSum:   Record<string, number> = {}
    const latCount: Record<string, number> = {}

    await Promise.all(gpPods.map(async pod => {
      try {
        const metricsText = await (async () => {
          const r = await fetch(
            `${K8S}/api/v1/namespaces/monitoring/pods/${pod}/proxy/metrics`,
            { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) }
          )
          return r.text()
        })()

        const sums   = parsePromText(metricsText, 'goldpinger_peers_response_time_s_sum')
        const counts = parsePromText(metricsText, 'goldpinger_peers_response_time_s_count')

        for (const { labels, value } of sums) {
          if (labels.call_type !== 'check') continue
          const key = `${labels.goldpinger_instance}|${labels.host_ip}`
          latSum[key] = (latSum[key] ?? 0) + value
        }
        for (const { labels, value } of counts) {
          if (labels.call_type !== 'check') continue
          const key = `${labels.goldpinger_instance}|${labels.host_ip}`
          latCount[key] = (latCount[key] ?? 0) + value
        }
      } catch { /* pod unreachable */ }
    }))

    // 6. Build node name list (sorted)
    const nodeNames = hosts.map(h => h.nodeName)

    // 7. Build matrix[sourceIdx][targetIdx] = avg latency ms
    const matrix: (number | null)[][] = nodeNames.map(srcNode => {
      return nodeNames.map(tgtNode => {
        if (srcNode === tgtNode) return 0 // self
        const tgtHost = hosts.find(h => h.nodeName === tgtNode)?.hostIP
        if (!tgtHost) return null
        const key = `${srcNode}|${tgtHost}`
        const s = latSum[key]
        const c = latCount[key]
        if (!c || !s) return null
        return Math.round((s / c) * 1000 * 100) / 100 // ms, 2dp
      })
    })

    // 8. Build ok matrix from check_all responses
    const okMatrix: boolean[][] = nodeNames.map(srcNode => {
      const srcPod = hosts.find(h => h.nodeName === srcNode)?.podName
      if (!srcPod) return nodeNames.map(() => false)
      const responses = checkAll.responses?.[srcPod]?.response?.podResults ?? {}
      return nodeNames.map(tgtNode => {
        const tgtPod = hosts.find(h => h.nodeName === tgtNode)?.podName
        if (!tgtPod) return false
        const result = responses[tgtPod]
        if (typeof result === 'string') return result.includes('OK=True')
        return result?.OK === true
      })
    })

    // 9. Stats
    const allLatencies = matrix.flat().filter(v => v !== null && v !== 0) as number[]
    const maxLatency   = allLatencies.length ? Math.max(...allLatencies) : 0
    const avgLatency   = allLatencies.length ? Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length * 100) / 100 : 0
    const failCount    = okMatrix.flat().filter((v, i) => {
      const row = Math.floor(i / nodeNames.length)
      const col = i % nodeNames.length
      return row !== col && !v
    }).length

    return NextResponse.json({
      available: true,
      nodes: nodeNames,
      matrix,
      okMatrix,
      stats: { maxLatency, avgLatency, failCount, nodeCount: nodeNames.length },
    })
  } catch (e: any) {
    return NextResponse.json({ available: false, reason: e.message }, { status: 500 })
  }
}