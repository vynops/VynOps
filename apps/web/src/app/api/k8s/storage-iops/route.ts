import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function promQuery(q: string): Promise<any[]> {
  const PROM = await resolvePromUrl()
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } })
    const j = await r.json()
    return j?.data?.result ?? []
  } catch { return [] }
}

async function promRange(q: string, start: number, end: number, step = 60): Promise<{ ts: number; value: number }[]> {
  const PROM = await resolvePromUrl()
  try {
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`
    const r = await fetch(url, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } })
    const j = await r.json()
    return (j.data?.result?.[0]?.values ?? []).map((v: any[]) => ({ ts: v[0] * 1000, value: parseFloat(v[1]) }))
  } catch { return [] }
}

async function promRangeByLabel(q: string, label: string, start: number, end: number, step = 60): Promise<Record<string, number[]>> {
  const PROM = await resolvePromUrl()
  try {
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), next: { revalidate: 0 } })
    const j = await r.json()
    const out: Record<string, number[]> = {}
    for (const rs of j.data?.result ?? []) {
      const key = rs.metric[label] ?? 'unknown'
      out[key] = (rs.values ?? []).map((v: any[]) => Math.round(parseFloat(v[1]) * 100) / 100)
    }
    return out
  } catch { return {} }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const windowMin = Math.min(Math.max(parseInt(searchParams.get('window') ?? '60', 10) || 60, 5), 360)
  const now   = Math.floor(Date.now() / 1000)
  const start = now - windowMin * 60

  const [
    readIopsRaw, writeIopsRaw,
    readMBsRaw,  writeMBsRaw,
    readSparkRaw, writeSparkRaw,
  ] = await Promise.all([
    // IOPS per PVC (cadvisor container_fs metrics keyed by device, merged by PVC if available)
    promQuery('sum by(namespace, persistentvolumeclaim) (rate(kubelet_volume_stats_used_bytes[5m]) * 0)'), // placeholder to check if kubelet stats exist
    promQuery('topk(20, sum by(namespace, pod, device) (rate(container_fs_reads_total{container!=""}[5m])))'),
    promQuery('topk(20, sum by(namespace, pod, device) (rate(container_fs_writes_total{container!=""}[5m])))'),
    promQuery('topk(20, sum by(namespace, pod, device) (rate(container_fs_reads_bytes_total{container!=""}[5m])))'),
    promQuery('topk(20, sum by(namespace, pod, device) (rate(container_fs_writes_bytes_total{container!=""}[5m])))'),
    // 30min sparklines
    promRangeByLabel('sum by(namespace, pod) (rate(container_fs_reads_total{container!=""}[5m]))', 'pod', start, now, 60),
    promRangeByLabel('sum by(namespace, pod) (rate(container_fs_writes_total{container!=""}[5m]))', 'pod', start, now, 60),
  ])

  // Build per-pod IOPS from reads/writes raw (indices 1 and 2)
  const readIops: any[]  = writeIopsRaw  // index 1
  const writeIops: any[] = readMBsRaw    // index 2
  const readMBs: any[]   = writeMBsRaw   // index 3
  const writeMBs: any[]  = readSparkRaw  // index 4
  const readSpark         = writeSparkRaw // index 5

  // Actually let me just redo the queries properly
  // The allSettled trick above had off-by-one, let's use actual named results:
  const [
    readsTotal, writesTotal, readBytesTotal, writeBytesTotal,
    readSparkByPod, writeSparkByPod,
    readMBsSparkByPod, writeMBsSparkByPod,
  ] = await Promise.all([
    promQuery('topk(20, sum by(namespace, pod) (rate(container_fs_reads_total{container!=""}[5m])))'),
    promQuery('topk(20, sum by(namespace, pod) (rate(container_fs_writes_total{container!=""}[5m])))'),
    promQuery('topk(20, sum by(namespace, pod) (rate(container_fs_reads_bytes_total{container!=""}[5m])))'),
    promQuery('topk(20, sum by(namespace, pod) (rate(container_fs_writes_bytes_total{container!=""}[5m])))'),
    promRangeByLabel('sum by(pod) (rate(container_fs_reads_total{container!=""}[5m]))',        'pod', start, now, 60),
    promRangeByLabel('sum by(pod) (rate(container_fs_writes_total{container!=""}[5m]))',       'pod', start, now, 60),
    promRangeByLabel('sum by(pod) (rate(container_fs_reads_bytes_total{container!=""}[5m]))',  'pod', start, now, 60),
    promRangeByLabel('sum by(pod) (rate(container_fs_writes_bytes_total{container!=""}[5m]))', 'pod', start, now, 60),
  ])

  // Merge by namespace/pod
  const podMap: Record<string, {
    namespace: string; pod: string
    readIops: number; writeIops: number
    readMBs: number;  writeMBs: number
    sparkRead: number[]; sparkWrite: number[]
    sparkReadMBs: number[]; sparkWriteMBs: number[]
  }> = {}

  const merge = (arr: any[], field: string) => {
    for (const r of arr) {
      const pod = r.metric.pod ?? ''
      const ns  = r.metric.namespace ?? ''
      const key = `${ns}/${pod}`
      if (!podMap[key]) podMap[key] = { namespace: ns, pod, readIops: 0, writeIops: 0, readMBs: 0, writeMBs: 0, sparkRead: [], sparkWrite: [], sparkReadMBs: [], sparkWriteMBs: [] }
      ;(podMap[key] as any)[field] = Math.round(parseFloat(r.value?.[1] ?? '0') * 100) / 100
    }
  }

  merge(readsTotal,      'readIops')
  merge(writesTotal,     'writeIops')
  merge(readBytesTotal,  'readMBs')
  merge(writeBytesTotal, 'writeMBs')

  // Convert bytes/sec → MB/s
  const MB = 1024 * 1024
  for (const e of Object.values(podMap)) {
    e.readMBs  = Math.round(e.readMBs  / MB * 1000) / 1000
    e.writeMBs = Math.round(e.writeMBs / MB * 1000) / 1000
  }

  for (const [pod, spark] of Object.entries(readSparkByPod)) {
    const entry = Object.values(podMap).find(e => e.pod === pod)
    if (entry) entry.sparkRead = spark
  }
  for (const [pod, spark] of Object.entries(writeSparkByPod)) {
    const entry = Object.values(podMap).find(e => e.pod === pod)
    if (entry) entry.sparkWrite = spark
  }
  for (const [pod, spark] of Object.entries(readMBsSparkByPod)) {
    const entry = Object.values(podMap).find(e => e.pod === pod)
    if (entry) entry.sparkReadMBs = spark.map(v => Math.round(v / (1024 * 1024) * 1000) / 1000)
  }
  for (const [pod, spark] of Object.entries(writeMBsSparkByPod)) {
    const entry = Object.values(podMap).find(e => e.pod === pod)
    if (entry) entry.sparkWriteMBs = spark.map(v => Math.round(v / (1024 * 1024) * 1000) / 1000)
  }

  const pvcs = Object.values(podMap)
    .filter(e => e.readIops > 0 || e.writeIops > 0 || e.readMBs > 0 || e.writeMBs > 0)
    .sort((a, b) => (b.readIops + b.writeIops) - (a.readIops + a.writeIops))
    .slice(0, 20)

  return NextResponse.json({ pvcs })
}