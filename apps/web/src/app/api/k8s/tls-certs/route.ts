import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'
import { X509Certificate } from 'crypto'


export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ certs: [] })

  try {
    const res = await fetch(
      `${K8S}/api/v1/secrets?fieldSelector=type%3Dkubernetes.io%2Ftls`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS), next: { revalidate: 0 } },
    )
    if (!res.ok) return NextResponse.json({ certs: [] })

    const data = await res.json()
    const now = Date.now()

    const certs = (data.items ?? []).flatMap((secret: any) => {
      const certB64: string = secret.data?.['tls.crt'] ?? ''
      if (!certB64) return []
      try {
        const buf = Buffer.from(certB64, 'base64')
        const cert = new X509Certificate(buf)
        const notAfter = new Date(cert.validTo)
        const daysRemaining = Math.floor((notAfter.getTime() - now) / 86400000)

        const subjectCN = cert.subject
          .split('\n')
          .find((l: string) => l.startsWith('CN='))
          ?.slice(3) ?? secret.metadata.name

        const issuerCN = cert.issuer
          .split('\n')
          .find((l: string) => l.startsWith('CN='))
          ?.slice(3) ?? cert.issuer.split('\n')[0] ?? ''

        const dnsNames = cert.subjectAltName
          ? cert.subjectAltName.split(', ')
              .filter((s: string) => s.startsWith('DNS:'))
              .map((s: string) => s.slice(4))
          : []

        const ipAddresses = cert.subjectAltName
          ? cert.subjectAltName.split(', ')
              .filter((s: string) => s.startsWith('IP Address:'))
              .map((s: string) => s.slice(11))
          : []

        return [{
          name:          secret.metadata.name,
          namespace:     secret.metadata.namespace,
          subject:       subjectCN,
          issuer:        issuerCN,
          dnsNames,
          ipAddresses,
          notBefore:     new Date(cert.validFrom).toISOString(),
          notAfter:      notAfter.toISOString(),
          daysRemaining,
          isExpired:     daysRemaining < 0,
          isExpiringSoon: daysRemaining >= 0 && daysRemaining < 30,
        }]
      } catch { return [] }
    })

    return NextResponse.json({ certs })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}