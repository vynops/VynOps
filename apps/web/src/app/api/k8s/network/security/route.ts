import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'
import { X509Certificate } from 'crypto'

async function k8s(path: string) {
  const K8S  = await resolveK8sUrl()
  try {
    const res = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

async function promQuery(q: string) {
  const PROM = await resolvePromUrl()
  if (!PROM) return []
  try {
    const res = await fetch(
      `${PROM}/api/v1/query?query=${encodeURIComponent(q)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS) },
    )
    const json = await res.json()
    return json?.data?.result ?? []
  } catch { return [] }
}

// Parse a base64-encoded PEM cert (K8s secret data['tls.crt']) and return notAfter date
function parseCertExpiry(b64: string): Date | null {
  try {
    // K8s secret data is base64(PEM), so decode to get the PEM string directly
    const pem = Buffer.from(b64, 'base64').toString('utf-8')
    const cert = new X509Certificate(pem)
    return new Date(cert.validTo)
  } catch { return null }
}

export async function GET() {
  const SKIP_NS = new Set(['kube-node-lease'])
  // System namespaces where NetworkPolicies are intentionally absent or would break cluster function
  const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'falco', 'retina-system'])

  const [
    namespacesRaw,
    networkPoliciesRaw,
    podsRaw,
    secretsRaw,
    ingressesRaw,
    // Service mesh detection
    istioRaw,
    linkerdRaw,
    ciliumRaw,
    // Egress from Prometheus
    egressByPodRaw,
  ] = await Promise.all([
    k8s('/api/v1/namespaces'),
    k8s('/apis/networking.k8s.io/v1/networkpolicies?limit=500'),
    k8s('/api/v1/pods?limit=500'),
    k8s('/api/v1/secrets?limit=500'),
    k8s('/apis/networking.k8s.io/v1/ingresses?limit=200'),
    k8s('/apis/networking.istio.io/v1beta1').catch(() => null),
    k8s('/apis/linkerd.io/v1alpha2').catch(() => null),
    k8s('/apis/cilium.io/v2').catch(() => null),
    promQuery('sort_desc(sum by (namespace, pod) (rate(container_network_transmit_bytes_total{container!=""}[5m]))) * 8 / 1e6'),
  ])

  const namespaces: string[] = (namespacesRaw?.items ?? [])
    .map((n: any) => n.metadata.name as string)
    .filter((n: string) => !SKIP_NS.has(n))

  const policies: any[] = networkPoliciesRaw?.items ?? []
  const pods: any[] = podsRaw?.items ?? []
  const secrets: any[] = secretsRaw?.items ?? []
  const ingresses: any[] = ingressesRaw?.items ?? []

  // ── 1. NetworkPolicy Gap Analysis ─────────────────────────────────────────
  const gapsByNs: Record<string, {
    namespace: string
    totalPods: number
    coveredPods: number
    uncoveredPods: number
    policies: number
    risk: 'none' | 'low' | 'medium' | 'high' | 'critical'
    uncoveredPodNames: string[]
  }> = {}

  for (const ns of namespaces) {
    const nsPods = pods.filter(p => p.metadata.namespace === ns && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed')
    const nsPolicies = policies.filter(p => p.metadata.namespace === ns)
    const coveredSet = new Set<string>()

    for (const pol of nsPolicies) {
      const sel = pol.spec.podSelector?.matchLabels
      for (const pod of nsPods) {
        if (!sel || Object.keys(sel).length === 0) {
          // Matches all pods in namespace
          coveredSet.add(pod.metadata.name)
        } else {
          const labels = pod.metadata.labels ?? {}
          const matched = Object.entries(sel).every(([k, v]) => labels[k] === v)
          if (matched) coveredSet.add(pod.metadata.name)
        }
      }
    }

    const uncoveredPods = nsPods.filter(p => !coveredSet.has(p.metadata.name))
    const total = nsPods.length
    const covered = coveredSet.size
    const uncovered = uncoveredPods.length

    let risk: 'none' | 'low' | 'medium' | 'high' | 'critical'
    if (total === 0) risk = 'none'
    else if (SYSTEM_NS.has(ns)) {
      // System namespaces: downgrade max severity to 'low' — intentionally open
      if (uncovered === 0) risk = 'none'
      else risk = 'low'
    }
    else if (nsPolicies.length === 0 && total > 0) risk = 'critical'
    else if (uncovered > 0 && uncovered / total >= 0.5) risk = 'high'
    else if (uncovered > 0) risk = 'medium'
    else risk = 'none'  // fully covered

    gapsByNs[ns] = {
      namespace: ns,
      totalPods: total,
      coveredPods: covered,
      uncoveredPods: uncovered,
      policies: nsPolicies.length,
      risk,
      uncoveredPodNames: uncoveredPods.slice(0, 5).map(p => p.metadata.name),
    }
  }

  const networkPolicyGaps = Object.values(gapsByNs)
    .filter(g => g.totalPods > 0)
    .sort((a, b) => {
      const order = { critical: 4, high: 3, medium: 2, low: 1, none: 0 }
      return order[b.risk] - order[a.risk]
    })

  // ── 2. TLS Certificate Expiry ──────────────────────────────────────────────
  const tlsCerts: Array<{
    name: string
    namespace: string
    source: string
    ingressName: string | null
    expiresAt: string | null
    daysRemaining: number | null
    expired: boolean
    status: 'ok' | 'warning' | 'critical' | 'expired' | 'unknown'
  }> = []

  const now = Date.now()

  // From TLS secrets
  const tlsSecrets = secrets.filter(s => s.type === 'kubernetes.io/tls')
  for (const secret of tlsSecrets) {
    const b64 = secret.data?.['tls.crt']
    let expiresAt: string | null = null
    let daysRemaining: number | null = null
    let expired = false
    let status: 'ok' | 'warning' | 'critical' | 'expired' | 'unknown' = 'unknown'

    if (b64) {
      const expiry = parseCertExpiry(b64)
      if (expiry) {
        expiresAt = expiry.toISOString()
        const msLeft = expiry.getTime() - now
        daysRemaining = Math.floor(msLeft / 86400000)
        expired = daysRemaining < 0
        status = expired ? 'expired' : daysRemaining < 7 ? 'critical' : daysRemaining < 30 ? 'warning' : 'ok'
      }
    }

    // Find associated Ingress
    const associatedIngress = ingresses.find(
      i => i.metadata.namespace === secret.metadata.namespace &&
        (i.spec.tls ?? []).some((t: any) => t.secretName === secret.metadata.name)
    )

    tlsCerts.push({
      name: secret.metadata.name,
      namespace: secret.metadata.namespace,
      source: 'tls-secret',
      ingressName: associatedIngress?.metadata.name ?? null,
      expiresAt,
      daysRemaining,
      expired,
      status,
    })
  }

  // Ingresses without TLS (exposure)
  for (const ing of ingresses) {
    const hasTLS = (ing.spec.tls ?? []).length > 0
    if (!hasTLS) {
      tlsCerts.push({
        name: ing.metadata.name,
        namespace: ing.metadata.namespace,
        source: 'ingress-no-tls',
        ingressName: ing.metadata.name,
        expiresAt: null,
        daysRemaining: null,
        expired: false,
        status: 'critical', // No TLS at all
      })
    }
  }

  tlsCerts.sort((a, b) => {
    const order = { expired: 5, critical: 4, warning: 3, unknown: 2, ok: 1 }
    return order[b.status] - order[a.status]
  })

  // ── 3. Service Mesh Detection ──────────────────────────────────────────────
  // Also check for Cilium via CNI configmap or Hubble
  const [ciliumCM, hubbleRaw] = await Promise.all([
    k8s('/api/v1/namespaces/kube-system/configmaps/cilium-config'),
    promQuery('hubble_flows_processed_total[1m]'),
  ])

  const serviceMesh = {
    istio: istioRaw != null,
    linkerd: linkerdRaw != null,
    cilium: ciliumCM != null,
    hubble: hubbleRaw.length > 0,
    none: istioRaw == null && linkerdRaw == null && ciliumCM == null,
  }

  // ── 4. Egress Tracking ────────────────────────────────────────────────────
  const egressByPod: Array<{ namespace: string; pod: string; egressMbps: number }> =
    (egressByPodRaw ?? [])
      .filter((r: any) => !SKIP_NS.has(r.metric.namespace))
      .map((r: any) => ({
        namespace: r.metric.namespace ?? '',
        pod: r.metric.pod ?? '',
        egressMbps: Math.round(parseFloat(r.value[1]) * 1000) / 1000,
      }))
      .filter((r: any) => r.egressMbps > 0)
      .sort((a: any, b: any) => b.egressMbps - a.egressMbps)
      .slice(0, 20)

  // Per-namespace egress summary
  const egressByNs = Object.entries(
    egressByPod.reduce((acc: Record<string, number>, r) => {
      acc[r.namespace] = (acc[r.namespace] ?? 0) + r.egressMbps
      return acc
    }, {})
  )
    .map(([namespace, egressMbps]) => ({ namespace, egressMbps: Math.round((egressMbps as number) * 1000) / 1000 }))
    .sort((a, b) => b.egressMbps - a.egressMbps)

  return NextResponse.json({
    networkPolicyGaps,
    tlsCerts,
    serviceMesh,
    egressByPod,
    egressByNs,
  })
}