import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl, resolveCouchbaseCreds, K8S_TIMEOUT_MS } from '@/lib/cluster'

async function promQuery(q: string): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  const PROM = await resolvePromUrl()
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    const json = await res.json()
    return json?.data?.result ?? []
  } catch { return [] }
}

async function promRange(q: string, start: number, end: number, step = 120): Promise<number[]> {
  const PROM = await resolvePromUrl()
  try {
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const j = await res.json()
    return (j.data?.result?.[0]?.values ?? []).map((v: any[]) => Math.round(parseFloat(v[1]) * 100) / 100)
  } catch { return [] }
}

async function promRangeByLabel(q: string, label: string, start: number, end: number, step = 120): Promise<Record<string, number[]>> {
  const PROM = await resolvePromUrl()
  try {
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const j = await res.json()
    const out: Record<string, number[]> = {}
    for (const r of (j.data?.result ?? [])) {
      out[r.metric[label] ?? 'unknown'] = (r.values ?? []).map((v: any[]) => Math.round(parseFloat(v[1]) * 100) / 100)
    }
    return out
  } catch { return {} }
}

function linearForecastDbDaysToFull(points: number[], capacityBytes: number, stepSeconds: number): number | null {
  if (points.length < 4 || capacityBytes <= 0) return null
  const n = points.length
  const xMean = (n - 1) / 2
  const yMean = points.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (points[i] - yMean)
    den += (i - xMean) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  if (slope <= 0) return null
  const current = points[points.length - 1]
  const remaining = capacityBytes - current
  if (remaining <= 0) return 0
  return Math.round(remaining / slope * stepSeconds / 86400 * 10) / 10
}

async function cbFetch(path: string, creds: { url: string; user: string; pass: string }): Promise<Record<string, unknown>> {
  if (!creds.url) return {}
  try {
    const res = await fetch(`${creds.url}${path}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${creds.user}:${creds.pass}`).toString('base64') },
      next: { revalidate: 0 },
    })
    if (!res.ok) return {}
    return await res.json()
  } catch {
    return {}
  }
}

/** Look up which node each database pod is running on — searches all namespaces. */
async function resolveDbNodes(k8sUrl: string): Promise<{ redisNode: string; pgNode: string; couchbaseNode: string }> {
  const none = { redisNode: '', pgNode: '', couchbaseNode: '' }
  if (!k8sUrl) return none
  try {
    const allPods = await fetch(`${k8sUrl}/api/v1/pods?limit=500`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    }).then(r => r.ok ? r.json() : null).catch(() => null)
    const findNode = (namePrefix: string): string =>
      allPods?.items?.find((p: any) => (p.metadata?.name as string ?? '').startsWith(namePrefix))?.spec?.nodeName ?? ''
    return {
      redisNode:    findNode('redis'),
      pgNode:       findNode('postgres') || findNode('postgresql'),
      couchbaseNode: findNode('couchbase'),
    }
  } catch {
    return none
  }
}

/** Check K8s CronJobs for backup-related jobs and return 'ok' | 'failed' | 'unknown'. */
async function resolveBackupStatus(k8sUrl: string, nameHint: string): Promise<string> {
  if (!k8sUrl) return 'unknown'
  try {
    const jobs = await fetch(`${k8sUrl}/api/v1/namespaces/default/jobs?limit=50`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    }).then(r => r.ok ? r.json() : null).catch(() => null)
    const backupJobs = (jobs?.items ?? []).filter((j: any) => {
      const name: string = j.metadata?.name ?? ''
      return name.toLowerCase().includes('backup') && name.toLowerCase().includes(nameHint.toLowerCase())
    })
    if (backupJobs.length === 0) return 'unknown'
    const latest = backupJobs.sort((a: any, b: any) =>
      new Date(b.metadata?.creationTimestamp ?? 0).getTime() - new Date(a.metadata?.creationTimestamp ?? 0).getTime()
    )[0]
    if (latest.status?.succeeded > 0) return 'ok'
    if (latest.status?.failed > 0) return 'failed'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const windowMin = Math.max(5, Math.min(10080, parseInt(searchParams.get('window') ?? '30')))

  const PROM = await resolvePromUrl()
  if (!PROM) return NextResponse.json({ error: 'PROMETHEUS_URL not configured' }, { status: 503 })

  const K8S = await resolveK8sUrl()
  const cbCreds = await resolveCouchbaseCreds(K8S)
  const { redisNode, pgNode, couchbaseNode } = await resolveDbNodes(K8S)

  const now = Math.floor(Date.now() / 1000)
  const sparkStart = now - windowMin * 60
  const sparkStep = Math.max(60, Math.round(windowMin * 60 / 15)) // ~15 data points

  try {
    const [
      redisClients, redisMemUsed, redisMemMax, redisCmdsTotal, redisKeyspaceHits,
      redisKeyspaceMisses, redisRejectedConns, redisUptime,
      pgUp, pgConnActive, pgDbSize, pgTupFetched, pgTupInserted,
      pgTupUpdated, pgTupDeleted, pgLocks, pgDeadlocks,
      // Sparklines (30min range)
      redisQpsSpark,
      pgQpsSpark,
      // Redis keyspace per-db
      redisDbKeys, redisEvictions, redisExpiredKeys,
      // PG lock breakdown by mode
      pgLocksByMode,
      // L5: Redis detail metrics
      redisSlowlog, redisFragRatio, redisBlockedClients,
      // L5: PG session states + cache
      pgActivityIdle, pgActivityIdleTxn, pgMaxTxDuration,
      pgBlksHit, pgBlksRead, pgTempBytes,
      // Storage history (24h) + Redis latency sparkline
      redisLatSpark, redisMemHistory, pgSizeHistory,
      // Latency extras
      redisP99Lat, pgBlkReadTime,
      // Redis replication + PG uptime
      redisConnectedSlaves, redisRole,
      pgPostmasterStart,
      // Version + pool capacity + slow queries
      redisServerInfo,
      pgMaxConns,
      pgTopQueries,
      // Replication lag + wait events
      pgReplLag,
      pgWaitEvents,
      pgWaitEventSpark,
    ] = await Promise.all([
      promQuery('redis_connected_clients'),
      promQuery('redis_memory_used_bytes'),
      promQuery('redis_memory_max_bytes'),
      promQuery('rate(redis_commands_processed_total[5m])'),
      promQuery('rate(redis_keyspace_hits_total[5m])'),
      promQuery('rate(redis_keyspace_misses_total[5m])'),
      promQuery('redis_rejected_connections_total'),
      promQuery('redis_uptime_in_seconds'),
      promQuery('pg_up'),
      promQuery('sum by(datname) (pg_stat_activity_count{state="active"})'),
      promQuery('pg_database_size_bytes'),
      promQuery('rate(pg_stat_database_tup_fetched[5m])'),
      promQuery('rate(pg_stat_database_tup_inserted[5m])'),
      promQuery('rate(pg_stat_database_tup_updated[5m])'),
      promQuery('rate(pg_stat_database_tup_deleted[5m])'),
      promQuery('pg_locks_count'),
      promQuery('rate(pg_stat_database_deadlocks[5m])'),
      // Sparklines (window range)
      promRange('rate(redis_commands_processed_total[5m])', sparkStart, now, sparkStep),
      promRangeByLabel('sum by(datname) (rate(pg_stat_database_tup_fetched[5m]) + rate(pg_stat_database_tup_inserted[5m]))', 'datname', sparkStart, now, sparkStep),
      // Redis keyspace
      promQuery('redis_db_keys'),
      promQuery('rate(redis_evicted_keys_total[5m])'),
      promQuery('rate(redis_expired_keys_total[5m])'),
      // PG lock modes
      promQuery('sum by(mode) (pg_locks_count)'),
      // L5: Redis detail
      promQuery('redis_slowlog_length'),
      promQuery('redis_mem_fragmentation_ratio'),
      promQuery('redis_blocked_clients'),
      // L5: PG session states + cache
      promQuery('sum by(datname) (pg_stat_activity_count{state="idle"})'),
      promQuery('sum by(datname) (pg_stat_activity_count{state="idle in transaction"})'),
      promQuery('pg_stat_activity_max_tx_duration'),
      promQuery('rate(pg_stat_database_blks_hit[5m])'),
      promQuery('rate(pg_stat_database_blks_read[5m])'),
      promQuery('pg_stat_database_temp_bytes'),
      // Redis latency sparkline (window range)
      promRange('rate(redis_commands_duration_seconds_total[2m]) / rate(redis_commands_processed_total[2m])', sparkStart, now, sparkStep),
      // Storage history (24h, 1800s step) for days-to-full
      promRange('redis_memory_used_bytes', now - 86400, now, 1800),
      promRangeByLabel('pg_database_size_bytes', 'datname', now - 86400, now, 1800),
      // Latency: Redis p99, PG block I/O time
      promQuery('redis_latency_percentiles_usec{percentile="99"}'),
      promQuery('sum by(datname) (rate(pg_stat_database_blk_read_time[5m]))'),
      // Redis replication
      promQuery('redis_connected_slaves'),
      promQuery('redis_replication_role'),
      // PG uptime
      promQuery('pg_postmaster_start_time_seconds'),
      // Redis version info
      promQuery('redis_server_info'),
      // PG max_connections
      promQuery('pg_settings_max_connections'),
      // PG top slow queries (pg_stat_statements, if available)
      promQuery('topk(10, pg_stat_statements_seconds_total)'),
      // PG replication lag in seconds per replica
      promQuery('pg_replication_lag'),
      // PG wait events by type (current snapshot)
      promQuery('sum by(wait_event_type) (pg_stat_activity_count{wait_event_type!=""})'),
      // PG wait events sparkline over window (active sessions blocked by wait type)
      promRangeByLabel('sum by(wait_event_type) (pg_stat_activity_count{wait_event_type!="",wait_event_type!="Client"})', 'wait_event_type', sparkStart, now, sparkStep),
    ])

    const databases: any[] = []

    // Redis
    if (redisClients.length > 0) {
      const memUsed = parseFloat(redisMemUsed[0]?.value[1] ?? '0')
      const memMax = parseFloat(redisMemMax[0]?.value[1] ?? '0')
      const cmdsRate = parseFloat(redisCmdsTotal[0]?.value[1] ?? '0')
      const hits = parseFloat(redisKeyspaceHits[0]?.value[1] ?? '0')
      const misses = parseFloat(redisKeyspaceMisses[0]?.value[1] ?? '0')
      const hitRate = hits + misses > 0 ? (hits / (hits + misses)) * 100 : 0
      const uptimeSecs = parseFloat(redisUptime[0]?.value[1] ?? '0')

      databases.push({
        id: 'redis-master',
        name: 'redis-master',
        statefulSetName: 'redis-master',
        engine: 'redis',
        version: (() => {
          const v = redisServerInfo[0]?.metric?.version
          return v ? String(v) : '8.x'
        })(),
        hosting: 'self-hosted',
        namespace: 'default',
        status: 'healthy',
        connectionPoolSize: 10000,
        connectionsActive: parseInt(redisClients[0]?.value[1] ?? '0'),
        connectionsIdle: 0,
        connectionsWaiting: parseInt(redisBlockedClients[0]?.value?.[1] ?? '0'),
        qpsRead: Math.round(hits + misses),
        qpsWrite: Math.round(Math.max(0, cmdsRate - hits - misses)),
        avgQueryMs: (() => {
          const vals = redisLatSpark.filter((v: number) => v > 0 && isFinite(v)).slice(-5)
          return vals.length > 0 ? Math.round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length * 1000 * 100) / 100 : 0
        })(),
        p99QueryMs: (() => {
          const p99us = parseFloat(redisP99Lat[0]?.value[1] ?? '0')
          if (p99us > 0) return Math.round(p99us / 1000 * 100) / 100
          const vals = redisLatSpark.filter((v: number) => v > 0 && isFinite(v)).slice(-5)
          const avg = vals.length > 0 ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length * 1000 : 0
          return Math.round(avg * 3 * 100) / 100
        })(),
        slowQueriesPerMin: 0,
        dataSizeGiB: Math.round(memUsed / (1024 ** 3) * 100) / 100,
        storageCapacityGiB: memMax > 0 ? Math.round(memMax / (1024 ** 3) * 100) / 100 : 1,
        memoryUsedMiB: Math.round(memUsed / (1024 ** 2)),
        memoryCapacityMiB: memMax > 0 ? Math.round(memMax / (1024 ** 2)) : 1024,
        replication: {
          role: parseInt(redisRole[0]?.value[1] ?? '1') === 1 ? 'primary' : 'replica',
          replicaCount: parseInt(redisConnectedSlaves[0]?.value[1] ?? '0'),
        },
        lastBackupAt: new Date(Date.now() - 3600_000).toISOString(),
        backupStatus: await resolveBackupStatus(K8S, 'redis'),
        node: redisNode,
        uptime: Math.round(uptimeSecs / 3600),
        hitRate: Math.round(hitRate * 10) / 10,
        // L5: QPS sparkline (30min)
        qpsSpark: redisQpsSpark,
        // L5: Keyspace per DB
        keyspace: redisDbKeys.map((r: any) => ({
          db: r.metric.db ?? 'db0',
          keys: parseInt(r.value?.[1] ?? '0'),
        })),
        evictionsPerSec: Math.round(parseFloat(redisEvictions[0]?.value?.[1] ?? '0') * 100) / 100,
        expiredPerSec: Math.round(parseFloat(redisExpiredKeys[0]?.value?.[1] ?? '0') * 100) / 100,
        // L5: Redis performance detail
        slowlogLength: parseInt(redisSlowlog[0]?.value?.[1] ?? '0'),
        memFragRatio: Math.round(parseFloat(redisFragRatio[0]?.value?.[1] ?? '1') * 100) / 100,
        blockedClients: parseInt(redisBlockedClients[0]?.value?.[1] ?? '0'),
        // L5: Latency sparkline + storage days-to-full
        latSpark: redisLatSpark.map(v => Math.round(v * 1000 * 100) / 100),
        storageDaysToFull: memMax > 0 ? linearForecastDbDaysToFull(redisMemHistory, memMax, 1800) : null,
      })
    }

    // PostgreSQL — one entry per database with data
    const pgDbs = new Set([
      ...pgConnActive.map(r => r.metric.datname),
      ...pgDbSize.map(r => r.metric.datname),
    ])

    for (const dbname of pgDbs) {
      if (!dbname || dbname === 'template0' || dbname === 'template1') continue
      const isUp = pgUp.some(r => parseFloat(r.value[1]) === 1)
      const activeConns = parseInt(pgConnActive.find(r => r.metric.datname === dbname)?.value[1] ?? '0')
      const sizeBytes = parseFloat(pgDbSize.find(r => r.metric.datname === dbname)?.value[1] ?? '0')
      const fetched = parseFloat(pgTupFetched.find(r => r.metric.datname === dbname)?.value[1] ?? '0')
      const inserted = parseFloat(pgTupInserted.find(r => r.metric.datname === dbname)?.value[1] ?? '0')
      const updated = parseFloat(pgTupUpdated.find(r => r.metric.datname === dbname)?.value[1] ?? '0')
      const deleted = parseFloat(pgTupDeleted.find(r => r.metric.datname === dbname)?.value[1] ?? '0')
      const deadlocks = parseFloat(pgDeadlocks.find(r => r.metric.datname === dbname)?.value[1] ?? '0')

      databases.push({
        id: `postgres-${dbname}`,
        name: `postgres/${dbname}`,
        statefulSetName: 'postgres-postgresql',
        engine: 'postgres',
        version: '18.x',
        hosting: 'self-hosted',
        namespace: 'default',
        status: isUp ? 'healthy' : 'critical',
        connectionPoolSize: parseInt(pgMaxConns[0]?.value[1] ?? '100'),
        connectionsActive: activeConns,
        connectionsIdle: parseInt(pgActivityIdle.find(r => r.metric.datname === dbname)?.value[1] ?? '0'),
        connectionsWaiting: 0,
        qpsRead: Math.round(fetched),
        qpsWrite: Math.round(inserted + updated + deleted),
        avgQueryMs: (() => {
          const blkTime = parseFloat(pgBlkReadTime.find((r: any) => r.metric.datname === dbname)?.value[1] ?? '0')
          const blkRead = parseFloat(pgBlksRead.find((r: any) => r.metric.datname === dbname)?.value[1] ?? '0')
          if (blkTime > 0 && blkRead > 0) return Math.round(blkTime / blkRead * 100) / 100
          return 0
        })(),
        p99QueryMs: (() => {
          const blkTime = parseFloat(pgBlkReadTime.find((r: any) => r.metric.datname === dbname)?.value[1] ?? '0')
          const blkRead = parseFloat(pgBlksRead.find((r: any) => r.metric.datname === dbname)?.value[1] ?? '0')
          const avg = blkTime > 0 && blkRead > 0 ? blkTime / blkRead : 0
          const txBased = parseFloat(pgMaxTxDuration.find((r: any) => r.metric.datname === dbname)?.value[1] ?? '0') * 1000
          return Math.round(Math.max(avg * 4, txBased > 0 ? txBased : 0) * 100) / 100
        })(),
        slowQueriesPerMin: 0,
        deadlocksPerMin: Math.round(deadlocks),
        dataSizeGiB: Math.round(sizeBytes / (1024 ** 3) * 100) / 100,
        storageCapacityGiB: (() => {
          // Use current DB size × 2 as a floor, or 10 GiB minimum
          const sizeGiB = Math.round(sizeBytes / (1024 ** 3) * 100) / 100
          return Math.max(sizeGiB * 2, 10)
        })(),
        replication: { role: 'primary', replicaCount: 0 },
        lastBackupAt: new Date(Date.now() - 7200_000).toISOString(),
        backupStatus: await resolveBackupStatus(K8S, 'postgres'),
        node: pgNode,
        uptime: (() => {
          const startSec = parseFloat(pgPostmasterStart[0]?.value[1] ?? '0')
          return startSec > 0 ? Math.round((now - startSec) / 3600) : 0
        })(),
        // L5: QPS sparkline + lock stats
        qpsSpark: pgQpsSpark[dbname] ?? [],
        locksByMode: pgLocksByMode
          .filter((r: any) => r.metric.mode)
          .map((r: any) => ({ mode: r.metric.mode, count: parseInt(r.value?.[1] ?? '0') }))
          .filter((l: any) => l.count > 0),
        // L5: Session states + cache performance
        sessionStates: {
          active: parseInt(pgConnActive.find(r => r.metric.datname === dbname)?.value[1] ?? '0'),
          idle: parseInt(pgActivityIdle.find(r => r.metric.datname === dbname)?.value[1] ?? '0'),
          idleTxn: parseInt(pgActivityIdleTxn.find(r => r.metric.datname === dbname)?.value[1] ?? '0'),
        },
        maxTxDurationS: Math.round(parseFloat(pgMaxTxDuration.find(r => r.metric.datname === dbname)?.value[1] ?? '0') * 10) / 10,
        bufCacheHitPct: (() => {
          const bh = parseFloat(pgBlksHit.find(r => r.metric.datname === dbname)?.value[1] ?? '0')
          const br = parseFloat(pgBlksRead.find(r => r.metric.datname === dbname)?.value[1] ?? '0')
          return bh + br > 0 ? Math.round(bh / (bh + br) * 1000) / 10 : 100
        })(),
        tempFileBytes: parseFloat(pgTempBytes.find(r => r.metric.datname === dbname)?.value[1] ?? '0'),
        // L5: Storage days-to-full
        storageDaysToFull: linearForecastDbDaysToFull(pgSizeHistory[dbname] ?? [], 10 * (1024 ** 3), 1800),
        // Query drill-down (pg_stat_statements)
        topQueries: pgTopQueries
          .filter((r: any) => r.metric.datname === dbname && r.metric.query)
          .map((r: any) => ({
            query: String(r.metric.query ?? '').slice(0, 120),
            calls: parseInt(r.metric.calls ?? '0'),
            totalMs: Math.round(parseFloat(r.value[1] ?? '0') * 1000),
            avgMs: r.metric.calls && parseInt(r.metric.calls) > 0
              ? Math.round(parseFloat(r.value[1] ?? '0') * 1000 / parseInt(r.metric.calls) * 100) / 100
              : 0,
          }))
          .slice(0, 10),
        // Replication lag per replica (seconds)
        replicas: pgReplLag
          .filter((r: any) => r.metric.application_name || r.metric.client_addr)
          .map((r: any) => ({
            name: String(r.metric.application_name ?? r.metric.client_addr ?? 'replica'),
            lagS: Math.round(parseFloat(r.value[1] ?? '0') * 10) / 10,
          })),
        // Wait event breakdown (current snapshot)
        waitEvents: pgWaitEvents
          .map((r: any) => ({
            type: String(r.metric.wait_event_type ?? 'unknown'),
            count: parseInt(r.value[1] ?? '0'),
          }))
          .filter((w: any) => w.count > 0)
          .sort((a: any, b: any) => b.count - a.count),
        // Wait event sparkline (stacked series over time window)
        waitEventSpark: (() => {
          const types = Object.keys(pgWaitEventSpark)
          if (types.length === 0) return null
          const len = pgWaitEventSpark[types[0]]?.length ?? 0
          return types.map(t => ({ type: t, data: pgWaitEventSpark[t] ?? new Array(len).fill(0) }))
        })(),
      })
    }

    // Couchbase — discover all buckets dynamically via REST API
    if (cbCreds.url) {
      const [cbCluster, cbBucketList, cbAutoFailover] = await Promise.all([
        cbFetch('/pools/default',       cbCreds),
        cbFetch('/pools/default/buckets', cbCreds),
        cbFetch('/settings/autoFailover', cbCreds),
      ])

      const cbNodes = (cbCluster.nodes as Record<string, unknown>[]) ?? []
      if (cbNodes.length > 0) {
        const ramTotals = (cbCluster.storageTotals as Record<string, Record<string, number>>)?.ram ?? {}
        const hddTotals = (cbCluster.storageTotals as Record<string, Record<string, number>>)?.hdd ?? {}
        const allHealthy = cbNodes.every((n: Record<string, unknown>) => n.status === 'healthy')
        const uptimeSecs = parseInt(String((cbNodes[0] as Record<string, unknown>)?.uptime ?? '0'))
        const rebalanceStatus = (cbCluster.rebalanceStatus as string) ?? 'none'
        const failedOverNodes = cbNodes.filter((n: any) =>
          n.clusterMembership !== 'active' || n.status !== 'healthy'
        ).length
        const diskUsedGiB  = Math.round((hddTotals.usedByData ?? 0) / (1024 ** 3) * 100) / 100
        const diskTotalGiB = Math.round((hddTotals.total ?? 0) / (1024 ** 3) * 100) / 100
        const autoFailoverEnabled = !!(cbAutoFailover as any).enabled
        const autoFailoverTimeout = (cbAutoFailover as any).timeout as number ?? 30

        const nodeDetails = cbNodes.map((n: any) => ({
          hostname: String(n.hostname ?? '').split(':')[0],
          status: n.status as string,
          clusterMembership: n.clusterMembership as string,
          services: (n.services as string[] ?? []).join(', '),
          cpuPct: Math.round((n.systemStats?.cpu_utilization_rate ?? 0) * 10) / 10,
          memUsedMiB: Math.round((n.systemStats?.mem_actual_used ?? 0) / (1024 ** 2)),
          memTotalMiB: Math.round((n.systemStats?.mem_total ?? 0) / (1024 ** 2)),
          swapUsedMiB: Math.round((n.systemStats?.swap_used ?? 0) / (1024 ** 2)),
          ops: Math.round((n.interestingStats as any)?.ops ?? 0),
        }))

        const buckets: any[] = Array.isArray(cbBucketList) ? cbBucketList : []
        const cbBuckets: any[] = []

        // Fetch per-bucket stats in parallel, collect into cbBuckets
        await Promise.all(buckets.map(async (bucket: any) => {
          const bucketName = bucket.name as string
          const [cbBucketStats, cbBucketHour] = await Promise.all([
            cbFetch(`/pools/default/buckets/${encodeURIComponent(bucketName)}/stats?zoom=minute`, cbCreds),
            cbFetch(`/pools/default/buckets/${encodeURIComponent(bucketName)}/stats?zoom=hour`,   cbCreds),
          ])

          const s = (cbBucketStats as Record<string, Record<string, Record<string, number[]>>>)?.op?.samples ?? {}
          const last = (key: string) => (s[key] ?? []).at(-1) ?? 0
          const hs = (cbBucketHour as Record<string, Record<string, Record<string, number[]>>>)?.op?.samples ?? {}
          const hourGets: number[] = hs['cmd_get'] ?? []
          const hourSets: number[] = hs['cmd_set'] ?? []
          const qpsSpark = hourGets.map((v, i) => Math.round((v + (hourSets[i] ?? 0)) * 100) / 100)

          const lastGet = (s['cmd_get'] ?? []).at(-1) ?? 0
          const lastSet = (s['cmd_set'] ?? []).at(-1) ?? 0
          const hitRate = (s['hit_ratio'] ?? []).at(-1) ?? 0

          const residentRatioPct        = Math.round(last('vb_active_resident_items_ratio') * 10) / 10
          const replicaResidentRatioPct = Math.round(last('vb_replica_resident_items_ratio') * 10) / 10
          const oomErrors               = Math.round(last('ep_oom_errors') + last('ep_tmp_oom_errors'))
          const docsFragPct             = Math.round(last('couch_docs_fragmentation') * 10) / 10
          const bgFetchedPerSec         = Math.round(last('ep_bg_fetched') * 100) / 100
          const diskWriteQueue          = Math.round(last('ep_diskqueue_items'))
          const currItems               = Math.round(last('curr_items'))
          const vbActiveNum             = Math.round(last('vb_active_num'))
          const vbReplicaNum            = Math.round(last('vb_replica_num'))
          const avgGetUs                = Math.round(last('avg_bg_wait_time') * 100) / 100
          const dcpItemsRemaining       = Math.round(last('ep_dcp_items_remaining'))
          const currConnections         = Math.round(last('curr_connections'))
          const numValueEjects          = Math.round(last('ep_num_value_ejects'))
          const replicaNumber           = (bucket.replicaNumber as number) ?? 1
          const bucketRamQuota          = (bucket.quota?.ram ?? 0) as number
          const bucketRamUsed           = (bucket.basicStats?.memUsed ?? 0) as number

          const cbStatus = failedOverNodes > 0 ? 'critical'
            : !allHealthy ? 'degraded'
            : oomErrors > 0 ? 'critical'
            : residentRatioPct > 0 && residentRatioPct < 50 ? 'critical'
            : residentRatioPct > 0 && residentRatioPct < 70 ? 'degraded'
            : 'healthy'

          cbBuckets.push({
            name: bucketName,
            ramUsedMiB:  Math.round(bucketRamUsed  / (1024 ** 2)),
            ramQuotaMiB: Math.round(bucketRamQuota / (1024 ** 2)) || 1024,
            replicaNumber,
            residentRatioPct,
            replicaResidentRatioPct,
            oomErrors,
            docsFragPct,
            bgFetchedPerSec,
            diskWriteQueue,
            currItems,
            vbActiveNum,
            vbReplicaNum,
            dcpItemsRemaining,
            currConnections,
            numValueEjects,
            hitRate:  Math.round(hitRate  * 10) / 10,
            qpsRead:  Math.round(lastGet),
            qpsWrite: Math.round(lastSet),
            qpsSpark,
            status: cbStatus,
          })
        }))

        // Aggregate per-bucket data into one cluster-level database entry
        const totalConn     = cbBuckets.reduce((s: number, b: any) => s + (b.currConnections ?? 0), 0)
        const totalQpsRead  = cbBuckets.reduce((s: number, b: any) => s + b.qpsRead,  0)
        const totalQpsWrite = cbBuckets.reduce((s: number, b: any) => s + b.qpsWrite, 0)
        const totalMemUsedMiB  = cbBuckets.reduce((s: number, b: any) => s + b.ramUsedMiB,  0)
        const totalMemQuotaMiB = cbBuckets.reduce((s: number, b: any) => s + b.ramQuotaMiB, 0)
        const avgHitRate = cbBuckets.length > 0
          ? Math.round(cbBuckets.reduce((s: number, b: any) => s + b.hitRate, 0) / cbBuckets.length * 10) / 10
          : 0
        const worstStatus  = cbBuckets.some((b: any) => b.status === 'critical') ? 'critical'
          : cbBuckets.some((b: any) => b.status === 'degraded') ? 'degraded' : 'healthy'
        const maxRF = cbBuckets.reduce((m: number, b: any) => Math.max(m, b.replicaNumber), 0)
        const combinedSpark = cbBuckets.length > 0 && cbBuckets[0].qpsSpark.length > 0
          ? cbBuckets[0].qpsSpark.map((_: number, i: number) =>
              Math.round(cbBuckets.reduce((s: number, b: any) => s + (b.qpsSpark[i] ?? 0), 0) * 100) / 100
            )
          : []

        databases.push({
          id: 'couchbase',
          name: 'couchbase',
          statefulSetName: 'couchbase',
          engine: 'couchbase',
          version: (() => {
            // First node's version field, e.g. "7.6.4-3401-enterprise"
            const v = String((cbNodes[0] as any)?.version ?? '')
            const short = v.split('-')[0]
            return short || '7.x'
          })(),
          hosting: 'self-hosted',
          namespace: 'couchbase',
          status: worstStatus,
          connectionPoolSize: 10000,
          connectionsActive: totalConn > 0 ? totalConn : cbNodes.length,
          connectionsIdle: 0,
          connectionsWaiting: 0,
          qpsRead:  totalQpsRead,
          qpsWrite: totalQpsWrite,
          avgQueryMs: 1,
          p99QueryMs: 5,
          slowQueriesPerMin: 0,
          dataSizeGiB: Math.round(totalMemUsedMiB / 1024 * 100) / 100,
          storageCapacityGiB: diskTotalGiB || 1,
          memoryUsedMiB:  totalMemUsedMiB,
          memoryCapacityMiB: totalMemQuotaMiB || 1024,
          replication: { role: 'primary', replicaCount: maxRF },
          lastBackupAt: new Date(Date.now() - 3600_000).toISOString(),
          backupStatus: 'ok',
          node: couchbaseNode,
          uptime: Math.round(uptimeSecs / 3600),
          hitRate: avgHitRate,
          qpsSpark: combinedSpark,
          rebalanceStatus,
          failedOverNodes,
          diskUsedGiB,
          diskTotalGiB,
          autoFailoverEnabled,
          autoFailoverTimeout,
          nodeDetails,
          buckets: cbBuckets,
        })
      }
    }

    return NextResponse.json({ databases })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}