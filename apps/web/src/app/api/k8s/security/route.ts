import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return { items: [] }
  try {
    const res = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    if (!res.ok) return { items: [] }
    return res.json()
  } catch { return { items: [] } }
}

const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const [
      secretsData, serviceAccountsData, componentData,
      rolesData, clusterRolesData, roleBindingsData, clusterRoleBindingsData,
    ] = await Promise.all([
      k8sGet('/api/v1/secrets'),
      k8sGet('/api/v1/serviceaccounts'),
      k8sGet('/api/v1/componentstatuses'),
      k8sGet('/apis/rbac.authorization.k8s.io/v1/roles'),
      k8sGet('/apis/rbac.authorization.k8s.io/v1/clusterroles'),
      k8sGet('/apis/rbac.authorization.k8s.io/v1/rolebindings'),
      k8sGet('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),
    ])

    // Secrets: name + type per namespace — values never returned
    const secretsByNs: Record<string, { count: number; items: { name: string; type: string; createdAt: string }[] }> = {}
    for (const s of (secretsData.items ?? [])) {
      const ns: string = s.metadata.namespace
      if (!secretsByNs[ns]) secretsByNs[ns] = { count: 0, items: [] }
      secretsByNs[ns].count++
      secretsByNs[ns].items.push({
        name: s.metadata.name as string,
        type: (s.type as string) ?? 'Opaque',
        createdAt: s.metadata.creationTimestamp as string,
      })
    }
    const secrets = Object.entries(secretsByNs)
      .map(([namespace, { count, items }]) => ({ namespace, count, items }))
      .sort((a, b) => b.count - a.count)

    // Service accounts
    const serviceAccounts = (serviceAccountsData.items ?? []).map((sa: any) => ({
      name: sa.metadata.name,
      namespace: sa.metadata.namespace,
      secrets: sa.secrets?.length ?? 0,
      createdAt: sa.metadata.creationTimestamp,
    })).sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    // Component statuses
    const components = (componentData.items ?? []).map((c: any) => {
      const cond = (c.conditions ?? []).find((x: any) => x.type === 'Healthy')
      return { name: c.metadata.name, healthy: cond?.status === 'True', message: cond?.message ?? '', error: cond?.error ?? '' }
    })

    // RBAC Roles (namespace-scoped, filter system)
    const roles = (rolesData.items ?? [])
      .filter((r: any) => !SYSTEM_NS.has(r.metadata.namespace))
      .map((r: any) => ({
        name: r.metadata.name,
        namespace: r.metadata.namespace,
        isCluster: false,
        rules: (r.rules ?? []).map((rule: any) => ({
          verbs: rule.verbs ?? [],
          apiGroups: rule.apiGroups ?? [],
          resources: rule.resources ?? [],
          resourceNames: rule.resourceNames,
        })),
        createdAt: r.metadata.creationTimestamp,
      }))
      .sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    // ClusterRoles (filter system aggregation roles)
    const clusterRoles = (clusterRolesData.items ?? [])
      .filter((r: any) => !r.metadata.name.startsWith('system:') && !r.metadata.labels?.['kubernetes.io/bootstrapping'])
      .map((r: any) => ({
        name: r.metadata.name,
        namespace: undefined,
        isCluster: true,
        rules: (r.rules ?? []).map((rule: any) => ({
          verbs: rule.verbs ?? [],
          apiGroups: rule.apiGroups ?? [],
          resources: rule.resources ?? [],
          resourceNames: rule.resourceNames,
          nonResourceURLs: rule.nonResourceURLs,
        })),
        createdAt: r.metadata.creationTimestamp,
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .slice(0, 30) // cap to avoid huge payloads from system roles

    // RoleBindings
    const roleBindings = (roleBindingsData.items ?? [])
      .filter((rb: any) => !SYSTEM_NS.has(rb.metadata.namespace))
      .map((rb: any) => ({
        name: rb.metadata.name,
        namespace: rb.metadata.namespace,
        isCluster: false,
        roleRef: { kind: rb.roleRef.kind, name: rb.roleRef.name },
        subjects: (rb.subjects ?? []).map((s: any) => ({ kind: s.kind, name: s.name, namespace: s.namespace })),
        createdAt: rb.metadata.creationTimestamp,
      }))
      .sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    // ClusterRoleBindings (filter system)
    const clusterRoleBindings = (clusterRoleBindingsData.items ?? [])
      .filter((rb: any) => !rb.metadata.name.startsWith('system:'))
      .map((rb: any) => ({
        name: rb.metadata.name,
        namespace: undefined,
        isCluster: true,
        roleRef: { kind: rb.roleRef.kind, name: rb.roleRef.name },
        subjects: (rb.subjects ?? []).map((s: any) => ({ kind: s.kind, name: s.name, namespace: s.namespace })),
        createdAt: rb.metadata.creationTimestamp,
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .slice(0, 30)

    return NextResponse.json({ secrets, serviceAccounts, components, roles, clusterRoles, roleBindings, clusterRoleBindings })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}