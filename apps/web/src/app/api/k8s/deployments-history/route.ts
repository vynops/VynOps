import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolveClusterMeta } from '@/lib/cluster'

async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(10000), next: { revalidate: 0 } })
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

// ── Metadata helpers ─────────────────────────────────────────────────────────

function getAny(obj: any, ...keys: string[]): string {
  const labels      = obj?.metadata?.labels ?? {}
  const annotations = obj?.metadata?.annotations ?? {}
  for (const k of keys) {
    if (labels[k])      return String(labels[k])
    if (annotations[k]) return String(annotations[k])
  }
  return ''
}

function detectDeployer(deploy: any, rs: any): string {
  const mgr = getAny(deploy, 'app.kubernetes.io/managed-by') ||
              getAny(rs,     'app.kubernetes.io/managed-by') ||
              getAny({ metadata: { labels: deploy.spec?.template?.metadata?.labels ?? {} } }, 'app.kubernetes.io/managed-by')
  if (/helm/i.test(mgr))   return 'helm'
  if (/flux/i.test(mgr))   return 'flux'
  if (/argo/i.test(mgr))   return 'argocd'
  const annotations = deploy.metadata?.annotations ?? {}
  if (annotations['objectset.rio.cattle.io/id']) return 'k3s-fleet'
  if (annotations['kubectl.kubernetes.io/last-applied-configuration']) return 'kubectl'
  if (annotations['deployment.kubernetes.io/revision']) return 'k8s-controller'
  return 'k8s-controller'
}

function extractCommitSha(rs: any): string {
  const podAnnotations = rs.spec?.template?.metadata?.annotations ?? {}
  const podLabels      = rs.spec?.template?.metadata?.labels ?? {}
  const candidates = [
    podAnnotations['git-commit'],     podAnnotations['gitCommit'],
    podAnnotations['commit'],         podAnnotations['scm-revision'],
    podAnnotations['app.kubernetes.io/git-commit'],
    podLabels['git-commit'],          podLabels['gitCommit'],
    podLabels['commit'],
  ]
  for (const c of candidates) {
    if (c && /^[0-9a-f]{6,40}$/i.test(String(c))) return String(c).slice(0, 8)
  }
  // Try image digest
  const img = rs.spec?.template?.spec?.containers?.[0]?.image ?? ''
  const digest = img.match(/@sha256:([0-9a-f]{12})/)
  if (digest) return digest[1].slice(0, 8)
  // Fall back to RS UID
  return (rs.metadata?.uid ?? 'unknown').slice(0, 8)
}

function extractBranch(rs: any): string {
  const podAnnotations = rs.spec?.template?.metadata?.annotations ?? {}
  const podLabels      = rs.spec?.template?.metadata?.labels ?? {}
  const candidates = [
    podAnnotations['git-branch'], podAnnotations['branch'],
    podLabels['git-branch'],      podLabels['branch'],
    podAnnotations['app.kubernetes.io/part-of'],
  ]
  for (const c of candidates) {
    if (c && !c.includes('/') && !c.includes(':')) return String(c)
  }
  return '—'
}

function detectEnvironment(ns: string, labels: Record<string, string>): 'production' | 'staging' | 'development' {
  const env = labels['app.kubernetes.io/environment'] ?? labels['environment'] ?? ''
  if (/prod/i.test(env) || /prod/i.test(ns)) return 'production'
  if (/stag/i.test(env) || /stag/i.test(ns)) return 'staging'
  if (/dev/i.test(env)  || /dev/i.test(ns))  return 'development'
  // System namespaces = treat as production-equivalent
  return 'production'
}

function imageToVersion(image: string): string {
  const tag = image.split(':').pop()?.split('@')[0] ?? 'latest'
  return tag.length > 28 ? tag.slice(0, 28) : tag
}

// ── Change detection ──────────────────────────────────────────────────────────

function detectChanges(curRS: any, prevRS: any | null) {
  const changes: { type: string; field: string; from: string; to: string }[] = []
  const curContainers: any[] = curRS.spec?.template?.spec?.containers ?? []
  const prevContainers: any[] = prevRS?.spec?.template?.spec?.containers ?? []

  for (let i = 0; i < Math.max(curContainers.length, prevContainers.length); i++) {
    const cur  = curContainers[i]
    const prev = prevContainers[i]

    if (!cur && prev) { changes.push({ type: 'config', field: `container[${i}]`, from: prev.name, to: '(removed)' }); continue }
    if (!prev && cur) { changes.push({ type: 'image',  field: `container[${i}].image`, from: '(new container)', to: cur.image }); continue }

    // Image
    if (cur.image !== prev.image) changes.push({ type: 'image', field: `containers[${i}].image`, from: imageToVersion(prev.image ?? ''), to: imageToVersion(cur.image ?? '') })

    // CPU request
    const [cc, pc] = [cur.resources?.requests?.cpu ?? '', prev.resources?.requests?.cpu ?? '']
    if (cc !== pc && (cc || pc)) changes.push({ type: 'resources', field: `containers[${i}].resources.requests.cpu`, from: pc || '(none)', to: cc || '(none)' })

    // Memory request
    const [cm, pm] = [cur.resources?.requests?.memory ?? '', prev.resources?.requests?.memory ?? '']
    if (cm !== pm && (cm || pm)) changes.push({ type: 'resources', field: `containers[${i}].resources.requests.memory`, from: pm || '(none)', to: cm || '(none)' })

    // CPU limit
    const [cl, pl] = [cur.resources?.limits?.cpu ?? '', prev.resources?.limits?.cpu ?? '']
    if (cl !== pl && (cl || pl)) changes.push({ type: 'resources', field: `containers[${i}].resources.limits.cpu`, from: pl || '(none)', to: cl || '(none)' })

    // Env var count delta
    const curEnv  = (cur.env ?? []).length
    const prevEnv = (prev.env ?? []).length
    if (curEnv !== prevEnv) changes.push({ type: 'config', field: `containers[${i}].env`, from: `${prevEnv} vars`, to: `${curEnv} vars` })
  }

  // Init containers
  const curInits:  any[] = curRS.spec?.template?.spec?.initContainers  ?? []
  const prevInits: any[] = prevRS?.spec?.template?.spec?.initContainers ?? []
  if (curInits.length !== prevInits.length) {
    changes.push({ type: 'config', field: 'initContainers', from: `${prevInits.length}`, to: `${curInits.length}` })
  }

  // If no specific changes found but images differ (fallback)
  if (changes.length === 0) {
    const curImg  = imageToVersion(curContainers[0]?.image  ?? '')
    const prevImg = imageToVersion(prevContainers[0]?.image ?? '')
    changes.push({ type: 'image', field: 'containers[0].image', from: prevImg || '(first deploy)', to: curImg })
  }

  return changes
}

// ── Risk scoring ──────────────────────────────────────────────────────────────

function calcRiskScore(opts: {
  status: string; isFirstRevision: boolean; changesCount: number
  startedAt: string; replicas: number; namespace: string
}): number {
  if (opts.status === 'failed') return 82
  if (opts.status === 'in-progress') return 28

  let score = 5
  const ns = opts.namespace.toLowerCase()
  if (!ns.includes('test') && !ns.includes('dev') && !ns.includes('stag')) score += 5
  score += Math.min(30, opts.changesCount * 8)
  if (opts.isFirstRevision) score += 20
  const hour = new Date(opts.startedAt).getUTCHours()
  if (hour < 7 || hour > 20) score += 15
  const dow = new Date(opts.startedAt).getUTCDay()
  if (dow === 0 || dow === 6) score += 10
  if (opts.replicas <= 1) score += 10
  return Math.min(95, Math.max(3, score))
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET() {
  const [deployData, rsData, clusterMeta] = await Promise.all([
    k8sGet('/apis/apps/v1/deployments'),
    k8sGet('/apis/apps/v1/replicasets'),
    resolveClusterMeta(),
  ])
  const clusterName = clusterMeta?.name ?? 'unknown'

  const deployments: any[] = deployData.items ?? []
  const replicasets: any[]  = rsData.items ?? []

  // Group RSes by owner Deployment
  const rsByDeploy: Record<string, any[]> = {}
  for (const rs of replicasets) {
    const owner = rs.metadata?.ownerReferences?.find((o: any) => o.kind === 'Deployment')
    if (!owner) continue
    const key = `${rs.metadata.namespace}/${owner.name}`
    ;(rsByDeploy[key] ??= []).push(rs)
  }

  const events: any[] = []

  for (const deploy of deployments) {
    const name = deploy.metadata.name
    const ns   = deploy.metadata.namespace
    const key  = `${ns}/${name}`
    const strategy = deploy.spec?.strategy?.type ?? 'RollingUpdate'
    const method   = strategy === 'Recreate' ? 'recreate' : 'rolling'
    const envLabels: Record<string, string> = {
      ...deploy.metadata?.labels ?? {},
      ...deploy.spec?.template?.metadata?.labels ?? {},
    }
    const environment = detectEnvironment(ns, envLabels)

    // Sort RSes newest first
    const rsList = (rsByDeploy[key] ?? []).sort((a: any, b: any) => {
      const revA = parseInt(a.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? '0')
      const revB = parseInt(b.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? '0')
      return revB - revA
    })
    const deployer = detectDeployer(deploy, rsList[0] ?? null)  // B2: use this deploy's own RS

    for (let i = 0; i < rsList.length; i++) {
      const rs      = rsList[i]
      const rev     = parseInt(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? '0')
      const image   = rs.spec?.template?.spec?.containers?.[0]?.image ?? 'unknown'
      const desired = rs.spec?.replicas ?? deploy.spec?.replicas ?? 1
      const ready   = rs.status?.readyReplicas ?? 0
      const created = rs.metadata.creationTimestamp ?? new Date().toISOString()

      // Skip old scaled-down revisions (desired=0 and not the latest)
      if (i > 0 && (rs.spec?.replicas ?? 0) === 0) continue

      // Status — B3: give new deploys a 5-min grace before marking failed
      let status: 'success' | 'in-progress' | 'failed' | 'rolled-back' = 'success'
      if (i === 0) {
        const ageMs = Date.now() - new Date(created).getTime()
        if (desired > 0 && ready === desired) status = 'success'
        else if (ready > 0 || ageMs < 300_000) status = 'in-progress'
        else                                   status = 'failed'
      }

      const prevRS    = rsList[i + 1] ?? null
      const prevImg   = prevRS?.spec?.template?.spec?.containers?.[0]?.image ?? ''
      const changes   = detectChanges(rs, prevRS)
      const commitSha = extractCommitSha(rs)
      const branch    = extractBranch(rs)

      // Duration & completedAt — use real K8s timestamps where available
      // A1/A3: replace fake `30 + desired * 20` heuristic with timestamp-derived values
      let durationSeconds: number
      let completedAt: string | undefined
      let isEstimated = false

      if (status === 'in-progress') {
        // Still rolling — elapsed time is the real duration so far
        durationSeconds = Math.floor((Date.now() - new Date(created).getTime()) / 1000)
        completedAt     = undefined
      } else if (i === 0) {
        // Current RS that has finished — try the Deployment's Progressing condition
        // (reason=NewReplicaSetAvailable, lastUpdateTime = when replicas became available)
        const condition = (deploy.status?.conditions ?? []).find(
          (c: any) => c.type === 'Progressing' && c.reason === 'NewReplicaSetAvailable' && c.lastUpdateTime
        )
        if (condition?.lastUpdateTime) {
          completedAt     = condition.lastUpdateTime
          durationSeconds = Math.max(1, Math.floor(
            (new Date(condition.lastUpdateTime).getTime() - new Date(created).getTime()) / 1000
          ))
        } else {
          // Condition not available — fall back to elapsed if recent, else cap
          const elapsed = Math.floor((Date.now() - new Date(created).getTime()) / 1000)
          durationSeconds = elapsed < 1200 ? elapsed : Math.min(300, 30 + desired * 20)
          isEstimated     = elapsed >= 1200
        }
      } else {
        // Historical RS — use the NEXT RS creation time as the upper bound for completedAt
        // (the next deploy started at rsList[i-1], so this one was done by then)
        const nextRS = rsList[i - 1]
        if (nextRS?.metadata?.creationTimestamp) {
          const nextCreated = nextRS.metadata.creationTimestamp as string
          completedAt     = nextCreated
          const diffSec   = Math.floor(
            (new Date(nextCreated).getTime() - new Date(created).getTime()) / 1000
          )
          // Cap at 600s — if two RSes are hours apart it's still just one rollout
          durationSeconds = Math.max(1, Math.min(diffSec, 600))
          isEstimated     = diffSec > 600  // capped = only upper-bound known
        } else {
          durationSeconds = Math.min(300, 30 + desired * 20)
          isEstimated     = true
        }
      }

      const riskScore = calcRiskScore({
        status, isFirstRevision: rev === 1,
        changesCount: changes.length,
        startedAt: created,
        replicas: desired,
        namespace: ns,
      })

      events.push({
        id:              rs.metadata.name,
        service:         name,
        version:         `r${rev} (${imageToVersion(image)})`,
        previousVersion: prevImg ? imageToVersion(prevImg) : '—',
        previousRsName: prevRS?.metadata?.name ?? null,
        environment,
        namespace:       ns,
        cluster:         clusterName,
        deployer,
        method,
        status,
        startedAt:  created,
        completedAt,
        durationSeconds,
        isEstimated,
        changes,
        riskScore,
        replicas: { desired, ready },
        commitSha,
        branch,
        imageTag:  imageToVersion(image),
        // linkedIncidentId and rollbackOf deliberately omitted (real data has none)
      })
    }
  }

  // Newest first
  events.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())

  // ── DORA metrics ────────────────────────────────────────────────────────────
  const now7d  = Date.now() - 7  * 86_400_000
  const now30d = Date.now() - 30 * 86_400_000
  const e7d    = events.filter(e => new Date(e.startedAt).getTime() > now7d)
  const e30d   = events.filter(e => new Date(e.startedAt).getTime() > now30d)

  const dora = {
    deployFrequency7d:  Math.round(e7d.length  / 7  * 100) / 100,   // deploys/day
    deployFrequency30d: Math.round(e30d.length / 30 * 100) / 100,
    // B7: CFR and successRate scoped to 30-day window (same as DORA spec)
    changeFailureRate:  e30d.length > 0
      ? Math.round(e30d.filter(e => e.status === 'failed').length / e30d.length * 100) : 0,
    successRate: e30d.length > 0
      ? Math.round(e30d.filter(e => e.status === 'success').length / e30d.length * 100) : 0,
    totalDeploys:   events.length,
    serviceCount:   new Set(events.map(e => e.service)).size,
    inProgress:     events.filter(e => e.status === 'in-progress').length,
    // Frequency category (per DORA research benchmarks)
    frequencyBand: e7d.length >= 7 ? 'elite'         // ≥1/day
                 : e7d.length >= 1 ? 'high'           // 1-6/week
                 : e30d.length >= 1 ? 'medium'        // 1-4/month
                 : 'low',                             // <1/month
    cfrBand: e30d.length === 0 ? 'elite'
           : e30d.filter(e => e.status === 'failed').length / e30d.length < 0.05 ? 'elite'
           : e30d.filter(e => e.status === 'failed').length / e30d.length < 0.15 ? 'high'
           : e30d.filter(e => e.status === 'failed').length / e30d.length < 0.30 ? 'medium'
           : 'low',
  }

  return NextResponse.json({ events, dora })
}
