import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const res = await fetch(`${K8S}/apis/networking.k8s.io/v1/ingresses`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    if (!res.ok) return NextResponse.json({ ingresses: [] })
    const data = await res.json()

    const ingresses = (data.items ?? []).map((ing: any) => ({
      name: ing.metadata.name,
      namespace: ing.metadata.namespace,
      className: ing.spec?.ingressClassName ?? ing.metadata.annotations?.['kubernetes.io/ingress.class'],
      annotations: Object.fromEntries(
        Object.entries(ing.metadata.annotations ?? {})
          .filter(([k]) => k !== 'kubectl.kubernetes.io/last-applied-configuration')
      ),
      rules: (ing.spec?.rules ?? []).map((rule: any) => ({
        host: rule.host,
        paths: (rule.http?.paths ?? []).map((p: any) => ({
          path: p.path ?? '/',
          pathType: p.pathType ?? 'Prefix',
          serviceName: p.backend?.service?.name ?? p.backend?.serviceName ?? '',
          servicePort: p.backend?.service?.port?.number ?? p.backend?.service?.port?.name ?? p.backend?.servicePort ?? 80,
        })),
      })),
      tls: (ing.spec?.tls ?? []).map((t: any) => ({
        hosts: t.hosts ?? [],
        secretName: t.secretName ?? '',
      })),
      loadBalancerIPs: (ing.status?.loadBalancer?.ingress ?? [])
        .map((lb: any) => lb.ip ?? lb.hostname ?? '')
        .filter(Boolean),
      createdAt: ing.metadata.creationTimestamp,
    })).sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))

    return NextResponse.json({ ingresses })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}