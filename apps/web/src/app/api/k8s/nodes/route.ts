import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl, K8S_TIMEOUT_MS } from '@/lib/cluster'

async function k8sGet(k8sUrl: string, path: string): Promise<any> {
  try {
    const res = await fetch(`${k8sUrl}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    return res.json()
  } catch { return null }
}

type PromResult = { metric: Record<string, string>; value: [number, string] }[]

async function promQuery(promUrl: string, q: string): Promise<PromResult> {
  try {
    const res = await fetch(`${promUrl}/api/v1/query?query=${encodeURIComponent(q)}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    const json = await res.json()
    return json?.data?.result ?? []
  } catch { return [] }
}

/** Parse Kubernetes CPU string (e.g. "4", "500m") to fractional cores */
function parseCpu(cpu: string): number {
  if (!cpu) return 0
  if (cpu.endsWith('m')) return parseInt(cpu) / 1000
  return parseFloat(cpu) || 0
}

/** Parse Kubernetes memory string (e.g. "8Gi", "16384Mi") to bytes */
function parseMemBytes(mem: string): number {
  if (!mem) return 0
  if (mem.endsWith('Ki')) return parseInt(mem) * 1024
  if (mem.endsWith('Mi')) return parseInt(mem) * 1024 ** 2
  if (mem.endsWith('Gi')) return parseInt(mem) * 1024 ** 3
  if (mem.endsWith('Ti')) return parseInt(mem) * 1024 ** 4
  if (mem.endsWith('K') || mem.endsWith('k')) return parseInt(mem) * 1000
  if (mem.endsWith('M')) return parseInt(mem) * 1000 ** 2
  if (mem.endsWith('G')) return parseInt(mem) * 1000 ** 3
  return parseInt(mem) || 0
}

export async function GET() {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()

  // K8s API is always required — Prometheus is optional enrichment
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    // ── Primary source: K8s API ───────────────────────────────────────────────
    const k8sNodesRaw = await k8sGet(K8S, '/api/v1/nodes')
    const k8sItems: any[] = k8sNodesRaw?.items ?? []

    if (!k8sItems.length) {
      return NextResponse.json({ error: 'K8s API unreachable or no nodes found' }, { status: 503 })
    }

    // Build K8s-sourced metadata maps
    const nodeLabelsMap:       Record<string, Record<string, string>> = {}
    const nodeInstanceTypeMap: Record<string, string> = {}
    const nodeTaintsMap:       Record<string, { key: string; effect: string; value?: string }[]> = {}
    const nodeCreatedAtMap:    Record<string, string> = {}
    const nodeUnschedulableMap: Record<string, boolean> = {}
    const nodeInfoMap:         Record<string, { kubeletVersion: string; osImage: string; kernelVersion: string; containerRuntime: string; internalIP: string }> = {}
    const nodeCpuCapMap:       Record<string, number> = {}
    const nodeMemCapMap:       Record<string, number> = {}  // bytes
    const nodePodCapMap:       Record<string, number> = {}
    const nodeCondMap:         Record<string, { type: string; status: string; lastTransitionTime: string }[]> = {}
    const nodeRoleMap:         Record<string, 'control-plane' | 'worker'> = {}

    for (const item of k8sItems) {
      const n: string = item.metadata?.name
      if (!n) continue
      const lbl = item.metadata?.labels ?? {}
      nodeLabelsMap[n]        = lbl
      nodeCreatedAtMap[n]     = item.metadata?.creationTimestamp ?? ''
      nodeInstanceTypeMap[n]  = lbl['node.kubernetes.io/instance-type'] ?? lbl['beta.kubernetes.io/instance-type'] ?? ''
      nodeUnschedulableMap[n] = !!item.spec?.unschedulable
      nodeTaintsMap[n]        = (item.spec?.taints ?? []).map((t: any) => ({
        key: t.key, effect: t.effect, ...(t.value != null ? { value: t.value } : {}),
      }))
      nodeCondMap[n] = (item.status?.conditions ?? []).map((c: any) => ({
        type: c.type, status: c.status, lastTransitionTime: c.lastTransitionTime ?? new Date().toISOString(),
      }))
      const ni        = item.status?.nodeInfo ?? {}
      const internalIP = (item.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')?.address ?? ''
      nodeInfoMap[n] = {
        kubeletVersion:   ni.kubeletVersion          ?? '',
        osImage:          ni.osImage                 ?? 'Linux',
        kernelVersion:    ni.kernelVersion           ?? '',
        containerRuntime: ni.containerRuntimeVersion ?? '',
        internalIP,
      }
      nodeCpuCapMap[n] = parseCpu(item.status?.allocatable?.cpu    ?? item.status?.capacity?.cpu    ?? '0')
      nodeMemCapMap[n] = parseMemBytes(item.status?.allocatable?.memory ?? item.status?.capacity?.memory ?? '0Ki')
      nodePodCapMap[n] = parseInt(item.status?.allocatable?.pods   ?? item.status?.capacity?.pods   ?? '0', 10) || 110
      const isCP = 'node-role.kubernetes.io/control-plane' in lbl
        || 'node-role.kubernetes.io/master' in lbl
        || n.includes('server') || n.includes('master') || n.includes('control')
      nodeRoleMap[n] = isCP ? 'control-plane' : 'worker'
    }

    // ── K8s pod counts (fallback when Prometheus absent) ─────────────────────
    const k8sPodCountMap: Record<string, number> = {}
    const k8sPodsRaw = await k8sGet(K8S, '/api/v1/pods?limit=1000&fieldSelector=status.phase%3DRunning')
    for (const pod of (k8sPodsRaw?.items ?? [])) {
      const node = pod.spec?.nodeName
      if (node) k8sPodCountMap[node] = (k8sPodCountMap[node] ?? 0) + 1
    }

    // ── Optional: Prometheus metrics ─────────────────────────────────────────
    let nodeInfoProm:   PromResult = []
    let conditionsProm: PromResult = []
    let cpuUsage:       PromResult = []
    let memAvail:       PromResult = []
    let podCounts:      PromResult = []
    let diskRead:       PromResult = []
    let diskWrite:      PromResult = []
    let fsSize:         PromResult = []
    let fsAvail:        PromResult = []
    let iopsRead:       PromResult = []
    let iopsWrite:      PromResult = []
    let diskReadTime:   PromResult = []
    let diskWriteTime:  PromResult = []
    let nodeUptime:     PromResult = []
    let cpuAllocProm:   PromResult = []
    let netIn:          PromResult = []
    let netOut:         PromResult = []

    if (PROM) {
      [nodeInfoProm, conditionsProm, cpuUsage, memAvail, podCounts,
        diskRead, diskWrite, fsSize, fsAvail, iopsRead, iopsWrite,
        diskReadTime, diskWriteTime, nodeUptime, cpuAllocProm, netIn, netOut] = await Promise.all([
        promQuery(PROM, 'kube_node_info'),
        promQuery(PROM, 'kube_node_status_condition'),
        promQuery(PROM, '1 - avg by(node) (rate(node_cpu_seconds_total{mode="idle"}[5m]))'),
        promQuery(PROM, 'node_memory_MemAvailable_bytes'),
        promQuery(PROM, 'count by(node) (kube_pod_info{node!=""})'),
        promQuery(PROM, 'rate(node_disk_read_bytes_total[5m])'),
        promQuery(PROM, 'rate(node_disk_written_bytes_total[5m])'),
        promQuery(PROM, 'node_filesystem_size_bytes{fstype!~"tmpfs|rootfs|overlay|squashfs|devtmpfs|cgroup.*|fuse.*|nfs.*"}'),
        promQuery(PROM, 'node_filesystem_avail_bytes{fstype!~"tmpfs|rootfs|overlay|squashfs|devtmpfs|cgroup.*|fuse.*|nfs.*"}'),
        promQuery(PROM, 'rate(node_disk_reads_completed_total[5m])'),
        promQuery(PROM, 'rate(node_disk_writes_completed_total[5m])'),
        promQuery(PROM, 'rate(node_disk_read_time_seconds_total[5m])'),
        promQuery(PROM, 'rate(node_disk_write_time_seconds_total[5m])'),
        promQuery(PROM, 'node_time_seconds - node_boot_time_seconds'),
        promQuery(PROM, 'kube_node_status_allocatable{resource="cpu"}'),
        promQuery(PROM, 'sum by(instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|cni.*|flannel.*|tunl.*|cali.*|dummy.*"}[5m]))'),
        promQuery(PROM, 'sum by(instance) (rate(node_network_transmit_bytes_total{device!~"lo|veth.*|cni.*|flannel.*|tunl.*|cali.*|dummy.*"}[5m]))'),
      ])
    }

    // instance → node mapping (Prom nodeInfo first, then K8s IPs as fallback)
    const instanceToNode: Record<string, string> = {}
    for (const r of nodeInfoProm) {
      if (r.metric.internal_ip) instanceToNode[r.metric.internal_ip] = r.metric.node
    }
    for (const [name, info] of Object.entries(nodeInfoMap)) {
      if (info.internalIP && !instanceToNode[info.internalIP]) instanceToNode[info.internalIP] = name
    }
    function resolveInst(instance: string) {
      const ip = instance?.split(':')[0]
      return instanceToNode[ip] ?? ip
    }
    function resolveNode(metric: Record<string, string>): string {
      if (metric.node) return metric.node
      return resolveInst(metric.instance)
    }

    // Prom metric maps indexed by node name
    const cpuMap:        Record<string, number> = {}
    const memAvailMap:   Record<string, number> = {}
    const diskReadMap:   Record<string, number> = {}
    const diskWriteMap:  Record<string, number> = {}
    const uptimeMap:     Record<string, number> = {}
    const netInMap:      Record<string, number> = {}
    const netOutMap:     Record<string, number> = {}
    const podCountMap:   Record<string, number> = {}
    const cpuCapPromMap: Record<string, number> = {}

    for (const r of cpuUsage)    cpuMap[r.metric.node]         = parseFloat(r.value[1])
    for (const r of memAvail)    { const n = resolveInst(r.metric.instance); memAvailMap[n]  = parseFloat(r.value[1]) }
    for (const r of diskRead)    { const n = resolveInst(r.metric.instance); diskReadMap[n]  = (diskReadMap[n]  ?? 0) + parseFloat(r.value[1]) }
    for (const r of diskWrite)   { const n = resolveInst(r.metric.instance); diskWriteMap[n] = (diskWriteMap[n] ?? 0) + parseFloat(r.value[1]) }
    for (const r of nodeUptime)  { const n = resolveInst(r.metric.instance); uptimeMap[n]    = parseFloat(r.value[1]) }
    for (const r of netIn)       { const n = resolveInst(r.metric.instance); netInMap[n]     = (netInMap[n]  ?? 0) + parseFloat(r.value[1]) }
    for (const r of netOut)      { const n = resolveInst(r.metric.instance); netOutMap[n]    = (netOutMap[n] ?? 0) + parseFloat(r.value[1]) }
    for (const r of podCounts)   podCountMap[r.metric.node]    = parseInt(r.value[1])
    for (const r of cpuAllocProm) cpuCapPromMap[r.metric.node] = parseFloat(r.value[1])

    // Prom conditions (augment K8s conditions if needed)
    const condPromMap: Record<string, { type: string; status: string }[]> = {}
    for (const r of conditionsProm) {
      if (r.value[1] !== '1') continue
      const node = r.metric.node
      if (!condPromMap[node]) condPromMap[node] = []
      condPromMap[node].push({ type: r.metric.condition, status: r.metric.status === 'true' ? 'True' : 'False' })
    }

    // Filesystem maps (Prom)
    type FsInfo = { device: string; sizeBytes: number; availBytes: number; mount: string }
    const fsMap: Record<string, Record<string, FsInfo>> = {}
    for (const r of fsSize) {
      const node = resolveNode(r.metric)
      if (!fsMap[node]) fsMap[node] = {}
      fsMap[node][r.metric.mountpoint] = { device: r.metric.device, sizeBytes: parseFloat(r.value[1]), availBytes: 0, mount: r.metric.mountpoint }
    }
    for (const r of fsAvail) {
      const node = resolveNode(r.metric)
      const mount = r.metric.mountpoint
      if (fsMap[node]?.[mount]) fsMap[node][mount].availBytes = parseFloat(r.value[1])
    }

    type DevMap = Record<string, Record<string, number>>
    const iopsReadMap:  DevMap = {}
    const iopsWriteMap: DevMap = {}
    const readTimeMap:  DevMap = {}
    const writeTimeMap: DevMap = {}
    for (const [src, dst] of [[iopsRead, iopsReadMap], [iopsWrite, iopsWriteMap], [diskReadTime, readTimeMap], [diskWriteTime, writeTimeMap]] as const) {
      for (const r of src) {
        const node = resolveNode(r.metric)
        if (!dst[node]) dst[node] = {}
        dst[node][r.metric.device] = parseFloat(r.value[1])
      }
    }

    // ── Build final node list (K8s items = primary) ───────────────────────────
    const nodes = k8sItems.flatMap((item: any) => {
      const name: string = item.metadata?.name
      if (!name) return []

      const cpuCores      = cpuCapPromMap[name] ?? nodeCpuCapMap[name] ?? 4
      const cpuFraction   = cpuMap[name] ?? 0
      const memTotalBytes = nodeMemCapMap[name] ?? 0
      // If Prom has memAvail → compute used; if Prom absent → show 0 used
      const memAvailBytes = memAvailMap[name] !== undefined ? memAvailMap[name] : memTotalBytes
      const memUsedBytes  = Math.max(0, memTotalBytes - memAvailBytes)
      const memTotalGiB   = Math.round(memTotalBytes / (1024 ** 3) * 100) / 100
      const memUsedGiB    = Math.round(memUsedBytes  / (1024 ** 3) * 100) / 100

      const role        = nodeRoleMap[name] ?? 'worker'
      const uptimeHours = Math.round((uptimeMap[name]  ?? 0) / 3600)
      const netInMbps   = Math.round((netInMap[name]   ?? 0) * 8 / 1_000_000 * 100) / 100
      const netOutMbps  = Math.round((netOutMap[name]  ?? 0) * 8 / 1_000_000 * 100) / 100

      // K8s conditions are authoritative; Prom conditions supplement if K8s gave nothing
      const conditions = nodeCondMap[name]?.length
        ? nodeCondMap[name]
        : (condPromMap[name]?.map(c => ({ ...c, lastTransitionTime: new Date().toISOString() }))
            ?? [{ type: 'Ready', status: 'True', lastTransitionTime: new Date().toISOString() }])

      const ni     = nodeInfoMap[name]!
      const promNI = nodeInfoProm.find(r => r.metric.node === name)

      return [{
        id:               name,
        name,
        role,
        status:           conditions.find(c => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
        region:           '',
        zone:             '',
        instanceType:     nodeInstanceTypeMap[name] || (role === 'control-plane' ? 'control-plane' : 'worker-node'),
        kubeletVersion:   promNI?.metric.kubelet_version           ?? ni.kubeletVersion,
        osImage:          promNI?.metric.os_image                  ?? ni.osImage,
        kernelVersion:    promNI?.metric.kernel_version            ?? ni.kernelVersion,
        containerRuntime: promNI?.metric.container_runtime_version ?? ni.containerRuntime,
        uptime:           uptimeHours,
        cpuCapacity:      cpuCores,
        cpuUsed:          Math.round(cpuFraction * cpuCores * 100) / 100,
        memoryCapacity:   memTotalGiB,
        memoryUsed:       memUsedGiB,
        podCount:         podCountMap[name]  ?? k8sPodCountMap[name] ?? 0,
        podCapacity:      nodePodCapMap[name] ?? 110,
        networkInMbps:    netInMbps,
        networkOutMbps:   netOutMbps,
        networkBandwidthMbps: 1000,
        packetDropRate:   0,
        conditions,
        labels:           nodeLabelsMap[name]   ?? {},
        taints:           nodeTaintsMap[name]   ?? [],
        createdAt:        nodeCreatedAtMap[name] ?? '',
        unschedulable:    nodeUnschedulableMap[name] ?? false,
        disks: (() => {
          // Deduplicate by device — keep only one mountpoint per device (largest by size)
          const byDevice: Record<string, { device: string; mountPath: string; sizeBytes: number; availBytes: number }> = {}
          for (const fs of Object.values(fsMap[name] ?? {})) {
            const dev = fs.device
            if (!byDevice[dev] || fs.sizeBytes > byDevice[dev].sizeBytes) {
              byDevice[dev] = { device: dev, mountPath: fs.mount, sizeBytes: fs.sizeBytes, availBytes: fs.availBytes }
            }
          }
          return Object.values(byDevice).map(fs => {
            const capacityGiB = Math.round(fs.sizeBytes / (1024 ** 3) * 100) / 100
            const usedGiB     = Math.round((fs.sizeBytes - fs.availBytes) / (1024 ** 3) * 100) / 100
            const blockDev    = fs.device.replace(/^\/dev\//, '')
            const rIops  = iopsReadMap[name]?.[blockDev]  ?? 0
            const wIops  = iopsWriteMap[name]?.[blockDev] ?? 0
            const rTime  = readTimeMap[name]?.[blockDev]  ?? 0
            const wTime  = writeTimeMap[name]?.[blockDev] ?? 0
            const totalIops = rIops + wIops
            const latencyMs = totalIops > 0.01 ? Math.round(((rTime + wTime) / totalIops) * 1000 * 10) / 10 : 0
            return { device: fs.device, mountPath: fs.mountPath, capacityGiB, usedGiB, iopsRead: Math.round(rIops), iopsWrite: Math.round(wIops), latencyMs }
          }).filter(d => d.capacityGiB > 0.01)
        })(),
        diskIO: {
          readBytesPerSec:  Math.round(diskReadMap[name]  ?? 0),
          writeBytesPerSec: Math.round(diskWriteMap[name] ?? 0),
        },
      }]
    })

    return NextResponse.json({ nodes })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
