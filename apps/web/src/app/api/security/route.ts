import { NextResponse } from 'next/server'
import { resolveK8sUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

const SKIP_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  if (!K8S) return { items: [] }
  try {
    const r = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      next: { revalidate: 0 },
    } as RequestInit)
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

function reasonSeverity(reason: string): 'critical' | 'high' | 'medium' {
  const critical = ['OOMKilling', 'Evicted', 'BackOff', 'Failed', 'CrashLoopBackOff']
  const high = ['FailedMount', 'Unhealthy', 'NodeNotReady', 'ImagePullBackOff', 'NetworkNotReady']
  if (critical.some(r => reason.toLowerCase().includes(r.toLowerCase()))) return 'critical'
  if (high.some(r => reason.toLowerCase().includes(r.toLowerCase()))) return 'high'
  return 'medium'
}

export async function GET() {
  const K8S = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const [
      podsData, nsData, netpolData,
      crbsData, crsData, eventsData,
    ] = await Promise.all([
      k8sGet('/api/v1/pods'),
      k8sGet('/api/v1/namespaces'),
      k8sGet('/apis/networking.k8s.io/v1/networkpolicies'),
      k8sGet('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),
      k8sGet('/apis/rbac.authorization.k8s.io/v1/clusterroles'),
      k8sGet('/api/v1/events?fieldSelector=type%3DWarning&limit=200'),
    ])

    // ── Workload security analysis ──────────────────────────────────────────
    const privilegedPods: { pod: string; ns: string; container: string; image: string }[] = []
    const latestTagContainers: { pod: string; ns: string; container: string; image: string }[] = []
    const noLimitsContainers:  { pod: string; ns: string; container: string; image: string }[] = []
    const noReadOnlyFsContainers: { pod: string; ns: string; container: string }[] = []
    const allowPrivEscContainers: { pod: string; ns: string; container: string }[] = []
    const noRunAsNonRootContainers: { pod: string; ns: string; container: string }[] = []
    const noSeccompContainers: { pod: string; ns: string; container: string }[] = []
    const secretEnvContainers: { pod: string; ns: string; container: string }[] = []
    const hostNetworkPods: { pod: string; ns: string }[] = []
    const hostPathPods:    { pod: string; ns: string }[] = []

    let falcoRunning = false
    let falcoPods = 0

    for (const pod of (podsData.items ?? [])) {
      const ns   = pod.metadata.namespace as string
      const name = pod.metadata.name as string
      const spec = pod.spec ?? {}
      const podSecCtx = spec.securityContext ?? {}

      // Detect Falco (privileged runtime security - expected, noted separately)
      if (ns === 'falco') { falcoRunning = true; falcoPods++ }

      if (SKIP_NS.has(ns)) continue

      const hasHostPath = (spec.volumes ?? []).some((v: any) => !!v.hostPath)
      if (spec.hostNetwork) hostNetworkPods.push({ pod: name, ns })
      if (hasHostPath) hostPathPods.push({ pod: name, ns })

      for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
        const sc  = c.securityContext ?? {}
        const img = (c.image as string) ?? ''
        const isLatest = img.endsWith(':latest') || img.includes(':latest@sha')

        if (sc.privileged === true)
          privilegedPods.push({ pod: name, ns, container: c.name, image: img })

        if (sc.allowPrivilegeEscalation !== false)
          allowPrivEscContainers.push({ pod: name, ns, container: c.name })

        if (!sc.readOnlyRootFilesystem)
          noReadOnlyFsContainers.push({ pod: name, ns, container: c.name })

        // runAsNonRoot: must be true at container level OR pod level
        const effectiveRunAsNonRoot = sc.runAsNonRoot ?? podSecCtx.runAsNonRoot
        if (!effectiveRunAsNonRoot && sc.runAsUser !== 0)
          noRunAsNonRootContainers.push({ pod: name, ns, container: c.name })

        // seccomp: must be set at container or pod level
        const seccomp = sc.seccompProfile?.type ?? podSecCtx.seccompProfile?.type
        if (!seccomp)
          noSeccompContainers.push({ pod: name, ns, container: c.name })

        // secret env vars: valueFrom.secretKeyRef or envFrom.secretRef
        const hasSecretEnv = (c.env ?? []).some((e: any) => !!e.valueFrom?.secretKeyRef) ||
          (c.envFrom ?? []).some((e: any) => !!e.secretRef)
        if (hasSecretEnv)
          secretEnvContainers.push({ pod: name, ns, container: c.name })

        if (!c.resources?.limits)
          noLimitsContainers.push({ pod: name, ns, container: c.name, image: img })

        if (isLatest)
          latestTagContainers.push({ pod: name, ns, container: c.name, image: img })
      }
    }

    // ── Namespace analysis ─────────────────────────────────────────────────
    const nsWithNetpol = new Set(
      (netpolData.items ?? []).map((np: any) => np.metadata.namespace as string)
    )
    const userNamespaces = (nsData.items ?? [])
      .map((n: any) => n.metadata.name as string)
      .filter((n: string) => !SKIP_NS.has(n))

    const nsAnalysis = userNamespaces.map((nsName: string) => {
      const nsObj = (nsData.items ?? []).find((n: any) => n.metadata.name === nsName)
      const psaLevel = (nsObj?.metadata?.labels?.['pod-security.kubernetes.io/enforce'] as string | undefined) ?? null
      const hasNetpol = nsWithNetpol.has(nsName)
      const workloadRisks = (
        privilegedPods.filter(p => p.ns === nsName).length +
        latestTagContainers.filter(p => p.ns === nsName).length +
        noLimitsContainers.filter(p => p.ns === nsName).length
      )
      return { name: nsName, hasNetpol, psaLevel, workloadRisks }
    })

    // ── RBAC analysis ──────────────────────────────────────────────────────
    const nonSysCRBs = (crbsData.items ?? [])
      .filter((rb: any) => !rb.metadata.name.startsWith('system:'))
      .map((rb: any) => ({
        name:          rb.metadata.name as string,
        roleRef:       rb.roleRef.name as string,
        roleKind:      rb.roleRef.kind as string,
        isClusterAdmin: rb.roleRef.name === 'cluster-admin',
        subjects:      (rb.subjects ?? []).map((s: any) => ({
          kind: s.kind, name: s.name, namespace: s.namespace ?? null,
        })),
        createdAt: rb.metadata.creationTimestamp as string,
      }))

    const wildcardRoles = (crsData.items ?? [])
      .filter((r: any) =>
        !r.metadata.name.startsWith('system:') &&
        !r.metadata.labels?.['kubernetes.io/bootstrapping'] &&
        (r.rules ?? []).some((rule: any) =>
          rule.verbs?.includes('*') || rule.resources?.includes('*')
        )
      )
      .map((r: any) => ({
        name: r.metadata.name as string,
        rules: (r.rules ?? [])
          .filter((rule: any) => rule.verbs?.includes('*') || rule.resources?.includes('*'))
          .map((rule: any) => ({
            verbs:     rule.verbs     ?? [],
            resources: rule.resources ?? [],
            apiGroups: rule.apiGroups ?? [],
          })),
        createdAt: r.metadata.creationTimestamp as string,
      }))

    const clusterAdminBindings = nonSysCRBs.filter(rb => rb.isClusterAdmin)

    // ── Threats (K8s Warning events) ───────────────────────────────────────
    const threats = (eventsData.items ?? [])
      .filter((e: any) => e.type === 'Warning')
      .map((e: any) => ({
        id:       e.metadata.uid as string,
        reason:   e.reason as string,
        message:  e.message as string,
        ns:       (e.involvedObject?.namespace as string) ?? '',
        kind:     (e.involvedObject?.kind as string) ?? '',
        objName:  (e.involvedObject?.name as string) ?? '',
        count:    (e.count as number) ?? 1,
        lastTime: (e.lastTimestamp ?? e.eventTime) as string,
        severity: reasonSeverity(e.reason ?? ''),
      }))

    // ── CIS Kubernetes Benchmark v1.8 checks ──────────────────────────────
    const totalUserNS    = userNamespaces.length
    const nsWithoutNetpol = userNamespaces.filter((n: string) => !nsWithNetpol.has(n)).length
    const nsWithoutPsa    = userNamespaces.filter((n: string) => {
      const nsObj = (nsData.items ?? []).find((x: any) => x.metadata.name === n)
      return !nsObj?.metadata?.labels?.['pod-security.kubernetes.io/enforce']
    }).length

    // Non-Falco privileged is the real concern (Falco runs privileged by design)
    const nonFalcoPrivileged = privilegedPods.filter(p => p.ns !== 'falco').length

    // Group allowPrivEsc by unique pods only
    const uniqueAllowPrivEscPods = new Set(
      allowPrivEscContainers.map(c => `${c.ns}/${c.pod}`)
    ).size

    interface CisCheck {
      id: string; category: string; name: string
      pass: boolean; severity: 'critical' | 'high' | 'medium' | 'low'
      detail: string; count: number
    }

    const cisChecks: CisCheck[] = [
      {
        id: '5.3.1', category: 'Network Policies',
        name: 'Namespaces have network policies',
        pass: nsWithoutNetpol === 0,
        severity: 'critical',
        detail: nsWithoutNetpol === 0
          ? 'All user namespaces have network isolation policies'
          : `${nsWithoutNetpol}/${totalUserNS} user namespaces lack network policies — lateral movement risk`,
        count: nsWithoutNetpol,
      },
      {
        id: '5.7.1', category: 'Pod Security Admission',
        name: 'Namespaces enforce pod security standards',
        pass: nsWithoutPsa === 0,
        severity: 'critical',
        detail: nsWithoutPsa === 0
          ? 'All namespaces enforce pod security admission (PSA)'
          : `${nsWithoutPsa}/${totalUserNS} namespaces missing pod-security.kubernetes.io/enforce label`,
        count: nsWithoutPsa,
      },
      {
        id: '5.1.1', category: 'RBAC',
        name: 'ClusterRoles do not use wildcard permissions',
        pass: wildcardRoles.length === 0,
        severity: 'high',
        detail: wildcardRoles.length === 0
          ? 'No ClusterRoles grant wildcard resource/verb access'
          : `${wildcardRoles.length} ClusterRoles use wildcards: ${wildcardRoles.map(r => r.name).join(', ')}`,
        count: wildcardRoles.length,
      },
      {
        id: '5.2.3', category: 'Pod Security',
        name: 'Privilege escalation blocked in containers',
        pass: allowPrivEscContainers.length === 0,
        severity: 'high',
        detail: allowPrivEscContainers.length === 0
          ? 'All containers explicitly block privilege escalation'
          : `${allowPrivEscContainers.length} containers allow privilege escalation (${uniqueAllowPrivEscPods} pods) — set allowPrivilegeEscalation: false`,
        count: allowPrivEscContainers.length,
      },
      {
        id: '5.2.7', category: 'Pod Security',
        name: 'Host path volumes restricted',
        pass: hostPathPods.length === 0,
        severity: 'high',
        detail: hostPathPods.length === 0
          ? 'No pods mount host filesystem paths'
          : `${hostPathPods.length} pods mount host paths — potential host filesystem access`,
        count: hostPathPods.length,
      },
      {
        id: '5.2.1', category: 'Pod Security',
        name: 'Non-privileged containers only',
        pass: nonFalcoPrivileged === 0,
        severity: 'medium',
        detail: nonFalcoPrivileged === 0
          ? `${privilegedPods.length > 0 ? privilegedPods.length + ' privileged containers (Falco runtime — expected)' : 'No privileged containers'}`
          : `${nonFalcoPrivileged} non-Falco containers run as privileged`,
        count: nonFalcoPrivileged,
      },
      {
        id: '5.2.6', category: 'Pod Security',
        name: 'Host network namespace not shared',
        pass: hostNetworkPods.length === 0,
        severity: 'medium',
        detail: hostNetworkPods.length === 0
          ? 'No pods share the host network namespace'
          : `${hostNetworkPods.length} pods use hostNetwork — can access host network stack`,
        count: hostNetworkPods.length,
      },
      {
        id: '5.2.8', category: 'Image Security',
        name: 'No :latest / mutable image tags',
        pass: latestTagContainers.length === 0,
        severity: 'medium',
        detail: latestTagContainers.length === 0
          ? 'All container images use pinned version tags'
          : `${latestTagContainers.length} containers use :latest tags — non-deterministic deploys, cannot pin to CVE-free version`,
        count: latestTagContainers.length,
      },
      {
        id: '5.4.2', category: 'Resource Management',
        name: 'Resource limits set on all containers',
        pass: noLimitsContainers.length === 0,
        severity: 'medium',
        detail: noLimitsContainers.length === 0
          ? 'All containers have CPU and memory limits set'
          : `${noLimitsContainers.length} containers have no resource limits — DoS risk, noisy-neighbour potential`,
        count: noLimitsContainers.length,
      },
      {
        id: '5.2.4', category: 'Pod Security',
        name: 'Containers run as non-root user',
        pass: noRunAsNonRootContainers.length === 0,
        severity: 'high',
        detail: noRunAsNonRootContainers.length === 0
          ? 'All containers enforce runAsNonRoot: true'
          : `${noRunAsNonRootContainers.length} containers do not enforce runAsNonRoot — risk of root breakout if container is compromised`,
        count: noRunAsNonRootContainers.length,
      },
      {
        id: '5.2.10', category: 'Pod Security',
        name: 'Seccomp profile set on containers',
        pass: noSeccompContainers.length === 0,
        severity: 'medium',
        detail: noSeccompContainers.length === 0
          ? 'All containers have a seccomp profile (RuntimeDefault or Localhost) configured'
          : `${noSeccompContainers.length} containers have no seccomp profile — syscall attack surface is unrestricted`,
        count: noSeccompContainers.length,
      },
      {
        id: '5.4.1', category: 'Secrets Management',
        name: 'Secrets not exposed as plain env vars',
        pass: secretEnvContainers.length === 0,
        severity: 'low',
        detail: secretEnvContainers.length === 0
          ? 'No containers reference Kubernetes Secrets as environment variables'
          : `${secretEnvContainers.length} containers mount Secrets as env vars — prefer volumeMount with in-memory tmpfs or external secret managers`,
        count: secretEnvContainers.length,
      },
      {
        id: '5.1.6', category: 'RBAC',
        name: 'Default service accounts inactive',
        pass: true,
        severity: 'low',
        detail: 'Service account token automounting audit requires API server audit logs — check automountServiceAccountToken: false on default SAs manually',
        count: 0,
      },
    ]

    // ── Score ──────────────────────────────────────────────────────────────
    const SEV_WEIGHT = { critical: 20, high: 15, medium: 10, low: 5 }
    const totalWeight = cisChecks.reduce(
      (s, c) => s + (SEV_WEIGHT[c.severity] ?? 5), 0
    )
    const passWeight = cisChecks
      .filter(c => c.pass)
      .reduce((s, c) => s + (SEV_WEIGHT[c.severity] ?? 5), 0)
    const score = Math.round((passWeight / totalWeight) * 100)
    const grade =
      score >= 90 ? 'A' :
      score >= 75 ? 'B' :
      score >= 60 ? 'C' :
      score >= 45 ? 'D' : 'F'

    return NextResponse.json({
      score,
      grade,
      kpis: {
        criticalFindings: cisChecks.filter(c => !c.pass && c.severity === 'critical').length,
        highFindings:     cisChecks.filter(c => !c.pass && c.severity === 'high').length,
        privilegedContainers: privilegedPods.length,
        latestTagImages:      latestTagContainers.length,
        noLimitsContainers:   noLimitsContainers.length,
        namespacesWithoutNetpol: nsWithoutNetpol,
        namespacesWithoutPsa:    nsWithoutPsa,
        wildcardRoles:  wildcardRoles.length,
        falcoRunning,
        falcoPods,
        totalUserNS,
        activeThreats:  threats.length,
      },
      cis: {
        checks: cisChecks,
        passed: cisChecks.filter(c => c.pass).length,
        failed: cisChecks.filter(c => !c.pass).length,
      },
      rbac: {
        clusterAdminBindings,
        wildcardRoles,
        clusterRoleBindings: nonSysCRBs,
        totalNonSystemCRBs:  nonSysCRBs.length,
      },
      workloads: {
        privileged:      privilegedPods.slice(0, 20),
        latestTags:      latestTagContainers.slice(0, 20),
        noLimits:        noLimitsContainers.slice(0, 30),
        noReadOnlyRootFs: noReadOnlyFsContainers.slice(0, 30),
        allowPrivEsc:    allowPrivEscContainers.slice(0, 30),
        hostNetwork:     hostNetworkPods,
        hostPath:        hostPathPods,
      },
      namespaces: nsAnalysis,
      threats: threats.slice(0, 100),
      source: 'live',
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}