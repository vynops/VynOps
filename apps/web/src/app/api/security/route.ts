import { NextResponse } from 'next/server'
import { resolveK8sUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'
import {
  classifyWarningPriority,
  countUniqueWorkloadFindings,
  enforcesNonRoot,
  getFalcoPodKeys,
  getFalcoStatus,
  getNamespaceNetworkPolicyCoverage,
  getResourceLimitGaps,
  scoreSecurityControls,
  type SecurityControl,
} from './scan'

const SKIP_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

async function k8sGet(path: string) {
  const K8S = await resolveK8sUrl()
  if (!K8S) throw new Error('Kubernetes API URL is unavailable for the selected cluster')
  const r = await fetch(`${K8S}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    next: { revalidate: 0 },
  } as RequestInit)
  if (!r.ok) throw new Error(`${path} returned HTTP ${r.status}`)
  const data = await r.json()
  if (!Array.isArray(data?.items)) throw new Error(`${path} returned an invalid list response`)
  return data
}

export async function GET() {
  const K8S = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const [
      podsData, nsData, netpolData, daemonSetsData,
      crbsData, crsData, eventsData,
    ] = await Promise.all([
      k8sGet('/api/v1/pods'),
      k8sGet('/api/v1/namespaces'),
      k8sGet('/apis/networking.k8s.io/v1/networkpolicies'),
      k8sGet('/apis/apps/v1/daemonsets'),
      k8sGet('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),
      k8sGet('/apis/rbac.authorization.k8s.io/v1/clusterroles'),
      k8sGet('/api/v1/events?fieldSelector=type%3DWarning&limit=200'),
    ])

    const falcoStatus = getFalcoStatus(daemonSetsData.items)
    const falcoPodKeys = getFalcoPodKeys(daemonSetsData.items, podsData.items)
    const falcoRunning = falcoStatus.running
    const falcoPods = falcoStatus.readyPods

    // ── Workload security analysis ──────────────────────────────────────────
    const privilegedPods: { pod: string; ns: string; container: string; image: string }[] = []
    const latestTagContainers: { pod: string; ns: string; container: string; image: string }[] = []
    const noLimitsContainers:  { pod: string; ns: string; container: string; containerType: 'containers' | 'initContainers'; image: string; missingCpuLimit: boolean; missingMemoryLimit: boolean; fixable: boolean }[] = []
    const noCpuLimitContainers: { pod: string; ns: string; container: string }[] = []
    const noMemoryLimitContainers: { pod: string; ns: string; container: string }[] = []
    const noReadOnlyFsContainers: { pod: string; ns: string; container: string; containerType: 'containers' | 'initContainers'; fixable: boolean }[] = []
    const allowPrivEscContainers: { pod: string; ns: string; container: string; containerType: 'containers' | 'initContainers'; fixable: boolean }[] = []
    const noRunAsNonRootContainers: { pod: string; ns: string; container: string }[] = []
    const noSeccompContainers: { pod: string; ns: string; container: string }[] = []
    const secretEnvContainers: { pod: string; ns: string; container: string }[] = []
    const hostNetworkPods: { pod: string; ns: string; fixable: boolean }[] = []
    const hostPathPods:    { pod: string; ns: string }[] = []

    for (const pod of (podsData.items ?? [])) {
      const ns   = pod.metadata.namespace as string
      const name = pod.metadata.name as string
      const spec = pod.spec ?? {}
      const podSecCtx = spec.securityContext ?? {}
      const fixable = (pod.metadata?.ownerReferences ?? []).some((owner: any) =>
        owner.controller !== false && ['ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet'].includes(owner.kind)
      )

      if (SKIP_NS.has(ns)) continue

      const hasHostPath = (spec.volumes ?? []).some((v: any) => !!v.hostPath)
      if (spec.hostNetwork) hostNetworkPods.push({ pod: name, ns, fixable })
      if (hasHostPath) hostPathPods.push({ pod: name, ns })

      for (const [containerType, containerList] of [
        ['containers', spec.containers ?? []],
        ['initContainers', spec.initContainers ?? []],
      ] as const) {
        for (const c of containerList) {
        const sc  = c.securityContext ?? {}
        const img = (c.image as string) ?? ''
        const isLatest = img.endsWith(':latest') || img.includes(':latest@sha')

        if (sc.privileged === true)
          privilegedPods.push({ pod: name, ns, container: c.name, image: img })

        if (sc.allowPrivilegeEscalation !== false)
          allowPrivEscContainers.push({ pod: name, ns, container: c.name, containerType, fixable })

        if (!sc.readOnlyRootFilesystem)
          noReadOnlyFsContainers.push({ pod: name, ns, container: c.name, containerType, fixable })

        if (!enforcesNonRoot(sc, podSecCtx))
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

        const limitGaps = getResourceLimitGaps(c)
        if (limitGaps.cpu) noCpuLimitContainers.push({ pod: name, ns, container: c.name })
        if (limitGaps.memory) noMemoryLimitContainers.push({ pod: name, ns, container: c.name })
        if (limitGaps.cpu || limitGaps.memory)
          noLimitsContainers.push({ pod: name, ns, container: c.name, containerType, image: img, missingCpuLimit: limitGaps.cpu, missingMemoryLimit: limitGaps.memory, fixable })

        if (isLatest)
          latestTagContainers.push({ pod: name, ns, container: c.name, image: img })
        }
      }
    }

    // ── Namespace analysis ─────────────────────────────────────────────────
    const userNamespaces = (nsData.items ?? [])
      .map((n: any) => n.metadata.name as string)
      .filter((n: string) => !SKIP_NS.has(n))

    const nsAnalysis = userNamespaces.map((nsName: string) => {
      const nsObj = (nsData.items ?? []).find((n: any) => n.metadata.name === nsName)
      const psaLevel = (nsObj?.metadata?.labels?.['pod-security.kubernetes.io/enforce'] as string | undefined) ?? null
      const netpolCoverage = getNamespaceNetworkPolicyCoverage(nsName, netpolData.items)
      const workloadRisks = countUniqueWorkloadFindings(nsName, privilegedPods, latestTagContainers, noLimitsContainers)
      return { name: nsName, ...netpolCoverage, psaLevel, workloadRisks }
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
    const warningEvents = (eventsData.items ?? [])
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
        priority: classifyWarningPriority(e.reason ?? ''),
      }))

    // ── CIS Kubernetes Benchmark v1.8 checks ──────────────────────────────
    const totalUserNS    = userNamespaces.length
    const nsWithoutNetpol = nsAnalysis.filter(ns => !ns.hasPolicy).length
    const nsWithoutPsa    = userNamespaces.filter((n: string) => {
      const nsObj = (nsData.items ?? []).find((x: any) => x.metadata.name === n)
      return !nsObj?.metadata?.labels?.['pod-security.kubernetes.io/enforce']
    }).length

    // Non-Falco privileged is the real concern (Falco runs privileged by design)
    const nonFalcoPrivileged = privilegedPods.filter(p => !falcoPodKeys.has(`${p.ns}/${p.pod}`)).length

    // Group allowPrivEsc by unique pods only
    const uniqueAllowPrivEscPods = new Set(
      allowPrivEscContainers.map(c => `${c.ns}/${c.pod}`)
    ).size

    const controls: SecurityControl[] = [
      {
        id: 'SEC-01', category: 'Network Policies',
        name: 'User namespaces have a NetworkPolicy',
        pass: totalUserNS === 0 ? null : nsWithoutNetpol === 0,
        severity: 'medium',
        detail: totalUserNS === 0
          ? 'Not assessed: no user namespaces were returned by the API'
          : nsWithoutNetpol === 0
          ? 'A NetworkPolicy exists in each user namespace. Presence alone does not establish traffic isolation.'
          : `${nsWithoutNetpol}/${totalUserNS} user namespaces have no NetworkPolicy`,
        count: nsWithoutNetpol,
      },
      {
        id: 'SEC-02', category: 'Pod Security Admission',
        name: 'Namespaces enforce pod security standards',
        pass: totalUserNS === 0 ? null : nsWithoutPsa === 0,
        severity: 'critical',
        detail: totalUserNS === 0
          ? 'Not assessed: no user namespaces were returned by the API'
          : nsWithoutPsa === 0
          ? 'All namespaces enforce pod security admission (PSA)'
          : `${nsWithoutPsa}/${totalUserNS} namespaces missing pod-security.kubernetes.io/enforce label`,
        count: nsWithoutPsa,
      },
      {
        id: 'SEC-03', category: 'RBAC',
        name: 'ClusterRoles do not use wildcard permissions',
        pass: wildcardRoles.length === 0,
        severity: 'high',
        detail: wildcardRoles.length === 0
          ? 'No ClusterRoles grant wildcard resource/verb access'
          : `${wildcardRoles.length} ClusterRoles use wildcards: ${wildcardRoles.map(r => r.name).join(', ')}`,
        count: wildcardRoles.length,
      },
      {
        id: 'SEC-04', category: 'Pod Security',
        name: 'Privilege escalation blocked in containers',
        pass: allowPrivEscContainers.length === 0,
        severity: 'high',
        detail: allowPrivEscContainers.length === 0
          ? 'All containers explicitly block privilege escalation'
          : `${allowPrivEscContainers.length} containers allow privilege escalation (${uniqueAllowPrivEscPods} pods) — set allowPrivilegeEscalation: false`,
        count: allowPrivEscContainers.length,
      },
      {
        id: 'SEC-05', category: 'Pod Security',
        name: 'Host path volumes restricted',
        pass: hostPathPods.length === 0,
        severity: 'high',
        detail: hostPathPods.length === 0
          ? 'No pods mount host filesystem paths'
          : `${hostPathPods.length} pods mount host paths — potential host filesystem access`,
        count: hostPathPods.length,
      },
      {
        id: 'SEC-06', category: 'Pod Security',
        name: 'Non-privileged containers only',
        pass: nonFalcoPrivileged === 0,
        severity: 'medium',
        detail: nonFalcoPrivileged === 0
          ? `${privilegedPods.length > 0 ? privilegedPods.length + ' privileged containers (Falco runtime — expected)' : 'No privileged containers'}`
          : `${nonFalcoPrivileged} non-Falco containers run as privileged`,
        count: nonFalcoPrivileged,
      },
      {
        id: 'SEC-07', category: 'Pod Security',
        name: 'Host network namespace not shared',
        pass: hostNetworkPods.length === 0,
        severity: 'medium',
        detail: hostNetworkPods.length === 0
          ? 'No pods share the host network namespace'
          : `${hostNetworkPods.length} pods use hostNetwork — can access host network stack`,
        count: hostNetworkPods.length,
      },
      {
        id: 'SEC-08', category: 'Image Security',
        name: 'No :latest / mutable image tags',
        pass: latestTagContainers.length === 0,
        severity: 'medium',
        detail: latestTagContainers.length === 0
          ? 'All container images use pinned version tags'
          : `${latestTagContainers.length} containers use :latest tags — non-deterministic deploys, cannot pin to CVE-free version`,
        count: latestTagContainers.length,
      },
      {
        id: 'SEC-09', category: 'Resource Management',
        name: 'CPU and memory limits set on all containers',
        pass: noCpuLimitContainers.length === 0 && noMemoryLimitContainers.length === 0,
        severity: 'medium',
        detail: noCpuLimitContainers.length === 0 && noMemoryLimitContainers.length === 0
          ? 'All containers have CPU and memory limits set'
          : `${noCpuLimitContainers.length} containers lack CPU limits; ${noMemoryLimitContainers.length} lack memory limits`,
        count: noLimitsContainers.length,
      },
      {
        id: 'SEC-10', category: 'Pod Security',
        name: 'Non-root identity is configured',
        pass: noRunAsNonRootContainers.length === 0,
        severity: 'high',
        detail: noRunAsNonRootContainers.length === 0
          ? 'All containers set runAsNonRoot: true or a non-root runAsUser'
          : `${noRunAsNonRootContainers.length} containers do not configure a non-root identity; this does not prove they run as root`,
        count: noRunAsNonRootContainers.length,
      },
      {
        id: 'SEC-11', category: 'Pod Security',
        name: 'Seccomp profile set on containers',
        pass: noSeccompContainers.length === 0,
        severity: 'medium',
        detail: noSeccompContainers.length === 0
          ? 'All containers have a seccomp profile (RuntimeDefault or Localhost) configured'
          : `${noSeccompContainers.length} containers have no seccomp profile — syscall attack surface is unrestricted`,
        count: noSeccompContainers.length,
      },
      {
        id: 'SEC-12', category: 'Secrets Management',
        name: 'Containers avoid Secret-backed environment variables',
        pass: secretEnvContainers.length === 0,
        severity: 'low',
        detail: secretEnvContainers.length === 0
          ? 'No containers reference Kubernetes Secrets as environment variables'
          : `${secretEnvContainers.length} containers mount Secrets as env vars — prefer volumeMount with in-memory tmpfs or external secret managers`,
        count: secretEnvContainers.length,
      },
      {
        id: 'SEC-13', category: 'RBAC',
        name: 'Default service account token automounting',
        pass: null,
        severity: 'low',
        detail: 'Not assessed. Review automountServiceAccountToken on workloads and service accounts; API audit logs are not available to this scan.',
        count: 0,
      },
    ]

    const scoreResult = scoreSecurityControls(controls)

    return NextResponse.json({
      score: scoreResult.score,
      grade: scoreResult.grade,
      kpis: {
        criticalFindings: controls.filter(c => c.pass === false && c.severity === 'critical').length,
        highFindings:     controls.filter(c => c.pass === false && c.severity === 'high').length,
        privilegedContainers: privilegedPods.length,
        latestTagImages:      latestTagContainers.length,
        noLimitsContainers:   noLimitsContainers.length,
        noCpuLimitContainers: noCpuLimitContainers.length,
        noMemoryLimitContainers: noMemoryLimitContainers.length,
        namespacesWithoutNetpol: nsWithoutNetpol,
        namespacesWithoutPsa:    nsWithoutPsa,
        wildcardRoles:  wildcardRoles.length,
        falcoDetected: falcoStatus.detected,
        falcoRunning: falcoStatus.running,
        falcoPods,
        falcoDesiredPods: falcoStatus.desiredPods,
        totalUserNS,
      },
      controls: {
        checks: controls,
        passed: scoreResult.passed,
        failed: scoreResult.failed,
        unknown: scoreResult.unknown,
        assessed: scoreResult.assessed,
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
      warningEvents: warningEvents.slice(0, 100),
      source: 'live',
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}