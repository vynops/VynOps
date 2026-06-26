import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  try {
    const r = await fetch(`${K8S}${path}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } })
    return r.ok ? r.json() : { items: [] }
  } catch { return { items: [] } }
}

// Known deprecated/removed API version mappings
// { apiVersion, removedIn, replacedBy }
const DEPRECATED: { match: RegExp; removedIn: string; replacedBy: string; severity: 'removed' | 'deprecated' }[] = [
  { match: /^extensions\/v1beta1$/,               removedIn: '1.22',  replacedBy: 'apps/v1, networking.k8s.io/v1',  severity: 'removed' },
  { match: /^apps\/v1beta1$/,                     removedIn: '1.16',  replacedBy: 'apps/v1',                        severity: 'removed' },
  { match: /^apps\/v1beta2$/,                     removedIn: '1.16',  replacedBy: 'apps/v1',                        severity: 'removed' },
  { match: /^networking\.k8s\.io\/v1beta1$/,      removedIn: '1.22',  replacedBy: 'networking.k8s.io/v1',           severity: 'removed' },
  { match: /^policy\/v1beta1$/,                   removedIn: '1.25',  replacedBy: 'policy/v1',                      severity: 'removed' },
  { match: /^batch\/v1beta1$/,                    removedIn: '1.25',  replacedBy: 'batch/v1',                       severity: 'removed' },
  { match: /^autoscaling\/v2beta1$/,              removedIn: '1.26',  replacedBy: 'autoscaling/v2',                 severity: 'removed' },
  { match: /^autoscaling\/v2beta2$/,              removedIn: '1.26',  replacedBy: 'autoscaling/v2',                 severity: 'removed' },
  { match: /^flowcontrol\.apiserver\.k8s\.io\/v1beta1$/, removedIn: '1.29', replacedBy: 'flowcontrol.apiserver.k8s.io/v1', severity: 'removed' },
  { match: /^storage\.k8s\.io\/v1beta1$/,         removedIn: '1.27',  replacedBy: 'storage.k8s.io/v1',             severity: 'removed' },
  { match: /^rbac\.authorization\.k8s\.io\/v1alpha1$/, removedIn: '1.20', replacedBy: 'rbac.authorization.k8s.io/v1', severity: 'removed' },
  { match: /^rbac\.authorization\.k8s\.io\/v1beta1$/, removedIn: '1.22', replacedBy: 'rbac.authorization.k8s.io/v1', severity: 'removed' },
  { match: /^scheduling\.k8s\.io\/v1alpha1$/,     removedIn: '1.17',  replacedBy: 'scheduling.k8s.io/v1',          severity: 'removed' },
  { match: /^scheduling\.k8s\.io\/v1beta1$/,      removedIn: '1.17',  replacedBy: 'scheduling.k8s.io/v1',          severity: 'removed' },
  { match: /^admissionregistration\.k8s\.io\/v1beta1$/, removedIn: '1.22', replacedBy: 'admissionregistration.k8s.io/v1', severity: 'removed' },
]

// Endpoints to scan: [apiPath, kind label]
const SCAN_TARGETS: { path: string; kind: string; apiVersion: string }[] = [
  { path: '/apis/extensions/v1beta1/ingresses',             kind: 'Ingress',        apiVersion: 'extensions/v1beta1' },
  { path: '/apis/extensions/v1beta1/deployments',           kind: 'Deployment',     apiVersion: 'extensions/v1beta1' },
  { path: '/apis/apps/v1beta1/deployments',                 kind: 'Deployment',     apiVersion: 'apps/v1beta1' },
  { path: '/apis/apps/v1beta2/deployments',                 kind: 'Deployment',     apiVersion: 'apps/v1beta2' },
  { path: '/apis/networking.k8s.io/v1beta1/ingresses',      kind: 'Ingress',        apiVersion: 'networking.k8s.io/v1beta1' },
  { path: '/apis/policy/v1beta1/poddisruptionbudgets',       kind: 'PodDisruptionBudget', apiVersion: 'policy/v1beta1' },
  { path: '/apis/batch/v1beta1/cronjobs',                   kind: 'CronJob',        apiVersion: 'batch/v1beta1' },
  { path: '/apis/autoscaling/v2beta1/horizontalpodautoscalers', kind: 'HPA',        apiVersion: 'autoscaling/v2beta1' },
  { path: '/apis/autoscaling/v2beta2/horizontalpodautoscalers', kind: 'HPA',        apiVersion: 'autoscaling/v2beta2' },
]

interface Finding {
  apiVersion: string
  kind: string
  namespace: string
  name: string
  removedIn: string
  replacedBy: string
  severity: 'removed' | 'deprecated'
}

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  const versionData = await k8sGet('/version')
  const serverVersion: string = versionData.gitVersion ?? 'unknown'

  // Scan all deprecated API endpoints in parallel (gracefully skip 404/410)
  const scanResults = await Promise.allSettled(
    SCAN_TARGETS.map(t => k8sGet(t.path))
  )

  const findings: Finding[] = []

  for (let i = 0; i < SCAN_TARGETS.length; i++) {
    const target = SCAN_TARGETS[i]
    const result = scanResults[i]
    if (result.status !== 'fulfilled') continue
    const items: any[] = result.value.items ?? []
    if (!items.length) continue

    const rule = DEPRECATED.find(d => d.match.test(target.apiVersion))

    for (const item of items) {
      findings.push({
        apiVersion:  target.apiVersion,
        kind:        item.kind ?? target.kind,
        namespace:   item.metadata?.namespace ?? '',
        name:        item.metadata?.name ?? '',
        removedIn:   rule?.removedIn  ?? 'unknown',
        replacedBy:  rule?.replacedBy ?? target.apiVersion.replace(/v1beta\d/, 'v1'),
        severity:    rule?.severity   ?? 'deprecated',
      })
    }
  }

  // Also check CRD API versions for deprecated apiextensions beta
  const crdData = await k8sGet('/apis/apiextensions.k8s.io/v1beta1/customresourcedefinitions')
  for (const crd of crdData.items ?? []) {
    findings.push({
      apiVersion: 'apiextensions.k8s.io/v1beta1',
      kind: 'CustomResourceDefinition',
      namespace: '',
      name: crd.metadata?.name ?? '',
      removedIn: '1.22',
      replacedBy: 'apiextensions.k8s.io/v1',
      severity: 'removed',
    })
  }

  return NextResponse.json({ serverVersion, findings })
}