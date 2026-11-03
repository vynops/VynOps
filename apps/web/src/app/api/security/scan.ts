export type ControlSeverity = 'critical' | 'high' | 'medium' | 'low'
export type WarningPriority = 'critical' | 'high' | 'medium' | 'unclassified'

export interface SecurityControl {
  id: string
  category: string
  name: string
  pass: boolean | null
  severity: ControlSeverity
  detail: string
  count: number
}

const SEVERITY_WEIGHT: Record<ControlSeverity, number> = {
  critical: 20,
  high: 15,
  medium: 10,
  low: 5,
}

export function getResourceLimitGaps(container: any) {
  const limits = container.resources?.limits ?? {}
  return { cpu: !limits.cpu, memory: !limits.memory }
}

export function countUniqueWorkloadFindings(namespace: string, ...groups: Array<Array<{ pod: string; ns: string; container: string }>>): number {
  return new Set(groups.flatMap(group =>
    group.filter(item => item.ns === namespace).map(item => `${item.ns}/${item.pod}/${item.container}`)
  )).size
}

export function enforcesNonRoot(containerSecurityContext: any, podSecurityContext: any): boolean {
  const runAsNonRoot = containerSecurityContext.runAsNonRoot ?? podSecurityContext.runAsNonRoot
  const runAsUser = containerSecurityContext.runAsUser ?? podSecurityContext.runAsUser
  if (runAsUser === 0) return false
  return runAsNonRoot === true || (typeof runAsUser === 'number' && runAsUser > 0)
}

function selectsAllPods(selector: any): boolean {
  return Object.keys(selector?.matchLabels ?? {}).length === 0 &&
    (selector?.matchExpressions ?? []).length === 0
}

function getPolicyTypes(spec: any): string[] {
  if (Array.isArray(spec.policyTypes) && spec.policyTypes.length > 0) return spec.policyTypes
  return (spec.egress ?? []).length > 0 ? ['Ingress', 'Egress'] : ['Ingress']
}

export function getNamespaceNetworkPolicyCoverage(namespace: string, policies: any[]) {
  const namespacePolicies = policies.filter(policy => policy.metadata?.namespace === namespace)
  const defaultDenyIngress = namespacePolicies.some(policy =>
    selectsAllPods(policy.spec?.podSelector) &&
    getPolicyTypes(policy.spec ?? {}).includes('Ingress') &&
    (policy.spec?.ingress ?? []).length === 0
  )
  const defaultDenyEgress = namespacePolicies.some(policy =>
    selectsAllPods(policy.spec?.podSelector) &&
    getPolicyTypes(policy.spec ?? {}).includes('Egress') &&
    (policy.spec?.egress ?? []).length === 0
  )
  return { hasPolicy: namespacePolicies.length > 0, defaultDenyIngress, defaultDenyEgress }
}

function hasFalcoImage(daemonSet: any): boolean {
  const labels = daemonSet.spec?.template?.metadata?.labels ?? {}
  if (labels['app.kubernetes.io/name']?.toLowerCase() === 'falco' || labels.app?.toLowerCase() === 'falco') return true
  return (daemonSet.spec?.template?.spec?.containers ?? []).some((container: any) => {
    const imageName = String(container.image ?? '').split('/').pop()?.split(/[:@]/, 1)[0]?.toLowerCase()
    return imageName === 'falco' || imageName === 'falco-no-driver' || imageName === 'falco-modern-bpf'
  })
}

export function getFalcoStatus(daemonSets: any[]) {
  const falcoDaemonSets = daemonSets.filter(hasFalcoImage)
  const readyPods = falcoDaemonSets.reduce((total, daemonSet) => total + (daemonSet.status?.numberReady ?? 0), 0)
  const desiredPods = falcoDaemonSets.reduce((total, daemonSet) => total + (daemonSet.status?.desiredNumberScheduled ?? 0), 0)
  return { detected: falcoDaemonSets.length > 0, running: readyPods > 0, readyPods, desiredPods, daemonSets: falcoDaemonSets }
}

export function getFalcoPodKeys(daemonSets: any[], pods: any[]): Set<string> {
  const falcoOwners = new Set(getFalcoStatus(daemonSets).daemonSets.map(ds => `${ds.metadata?.namespace}/${ds.metadata?.name}`))
  return new Set(pods.filter(pod =>
    (pod.metadata?.ownerReferences ?? []).some((owner: any) =>
      owner.kind === 'DaemonSet' && falcoOwners.has(`${pod.metadata?.namespace}/${owner.name}`)
    )
  ).map(pod => `${pod.metadata?.namespace}/${pod.metadata?.name}`))
}

export function scoreSecurityControls(controls: SecurityControl[]) {
  const assessed = controls.filter(control => control.pass !== null)
  const denominator = assessed.reduce((total, control) => total + SEVERITY_WEIGHT[control.severity], 0)
  const numerator = assessed.filter(control => control.pass).reduce((total, control) => total + SEVERITY_WEIGHT[control.severity], 0)
  const score = denominator > 0 ? Math.round((numerator / denominator) * 100) : null
  const grade = score === null ? '-' : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F'
  return {
    score,
    grade,
    passed: controls.filter(control => control.pass === true).length,
    failed: controls.filter(control => control.pass === false).length,
    unknown: controls.filter(control => control.pass === null).length,
    assessed: assessed.length,
  }
}

export function classifyWarningPriority(reason: string): WarningPriority {
  const normalized = reason.toLowerCase()
  if (['oomkilling', 'evicted', 'crashloopbackoff'].some(value => normalized.includes(value))) return 'critical'
  if (['backoff', 'failedmount', 'unhealthy', 'nodenotready', 'imagepullbackoff', 'networknotready'].some(value => normalized.includes(value))) return 'high'
  if (['failed', 'warning'].some(value => normalized.includes(value))) return 'medium'
  return 'unclassified'
}