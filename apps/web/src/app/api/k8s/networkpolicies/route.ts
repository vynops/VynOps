import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const res = await fetch(`${K8S}/apis/networking.k8s.io/v1/networkpolicies`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    if (!res.ok) return NextResponse.json({ networkPolicies: [] })
    const data = await res.json()

    const networkPolicies = (data.items ?? []).map((np: any) => ({
      name: np.metadata.name,
      namespace: np.metadata.namespace,
      podSelector: np.spec?.podSelector?.matchLabels ?? {},
      policyTypes: np.spec?.policyTypes ?? [],
      ingressRules: (np.spec?.ingress ?? []).length,
      egressRules: (np.spec?.egress ?? []).length,
      // Full rules for detail view
      ingress: (np.spec?.ingress ?? []).map((rule: any) => ({
        from: (rule.from ?? []).map((f: any) => ({
          podSelector: f.podSelector?.matchLabels,
          namespaceSelector: f.namespaceSelector?.matchLabels,
          ipBlock: f.ipBlock,
        })),
        ports: (rule.ports ?? []).map((p: any) => ({ port: p.port, protocol: p.protocol ?? 'TCP' })),
      })),
      egress: (np.spec?.egress ?? []).map((rule: any) => ({
        to: (rule.to ?? []).map((t: any) => ({
          podSelector: t.podSelector?.matchLabels,
          namespaceSelector: t.namespaceSelector?.matchLabels,
          ipBlock: t.ipBlock,
        })),
        ports: (rule.ports ?? []).map((p: any) => ({ port: p.port, protocol: p.protocol ?? 'TCP' })),
      })),
      createdAt: np.metadata.creationTimestamp,
    })).sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    return NextResponse.json({ networkPolicies })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}