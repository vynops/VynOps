import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'

const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])

async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
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

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })
  try {
    const podsData = await k8sGet('/api/v1/pods')

    let privilegedCount = 0
    let runAsRootCount = 0
    let allowPrivEscCount = 0
    let hostNetworkCount = 0
    let hostPathCount = 0
    let noSeccompCount = 0
    let noReadOnlyRootFsCount = 0

    const findings: { pod: string; namespace: string; container: string; risks: string[] }[] = []

    for (const pod of (podsData.items ?? [])) {
      if (SYSTEM_NS.has(pod.metadata.namespace)) continue
      const spec = pod.spec ?? {}
      const podSecCtx = spec.securityContext ?? {}
      const hasHostPath = (spec.volumes ?? []).some((v: any) => !!v.hostPath)
      let podHostPathCounted = false
      let podHostNetCounted = false

      for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
        const sc = c.securityContext ?? {}
        const risks: string[] = []

        if (sc.privileged === true) {
          risks.push('privileged')
          privilegedCount++
        }

        if (sc.allowPrivilegeEscalation !== false) {
          risks.push('allowPrivEsc')
          allowPrivEscCount++
        }

        // runAsRoot: explicit root user, or no runAsNonRoot enforcement at pod or container level
        const effectiveRunAsNonRoot = sc.runAsNonRoot ?? podSecCtx.runAsNonRoot
        if (sc.runAsUser === 0 || (!effectiveRunAsNonRoot && sc.runAsUser == null)) {
          risks.push('mayRunAsRoot')
          runAsRootCount++
        }

        if (!sc.readOnlyRootFilesystem) {
          risks.push('writableRootFs')
          noReadOnlyRootFsCount++
        }

        const seccomp = sc.seccompProfile?.type ?? podSecCtx.seccompProfile?.type
        if (!seccomp) {
          risks.push('noSeccomp')
          noSeccompCount++
        }

        if (spec.hostNetwork) {
          risks.push('hostNetwork')
          if (!podHostNetCounted) { hostNetworkCount++; podHostNetCounted = true }
        }

        if (hasHostPath) {
          risks.push('hostPath')
          if (!podHostPathCounted) { hostPathCount++; podHostPathCounted = true }
        }

        if (risks.length > 0) {
          findings.push({
            pod: pod.metadata.name,
            namespace: pod.metadata.namespace,
            container: c.name,
            risks,
          })
        }
      }
    }

    return NextResponse.json({
      findings,
      summary: {
        privilegedCount,
        runAsRootCount,
        allowPrivEscCount,
        hostNetworkCount,
        hostPathCount,
        noSeccompCount,
        noReadOnlyRootFsCount,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}