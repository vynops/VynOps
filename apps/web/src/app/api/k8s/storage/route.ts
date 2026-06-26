import { NextResponse } from 'next/server'
import { resolveK8sUrl, resolvePromUrl , K8S_TIMEOUT_MS } from '@/lib/cluster'


async function k8sGet(path: string) {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()
  if (!K8S) return { items: [] }
  try {
    const res = await fetch(`${K8S}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    return res.json()
  } catch { return { items: [] } }
}

async function promQuery(q: string): Promise<any[]> {
  const K8S  = await resolveK8sUrl()
  const PROM = await resolvePromUrl()
  if (!PROM) return []
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
    const j = await res.json()
    return j?.data?.result ?? []
  } catch { return [] }
}

export async function GET() {
  const K8S  = await resolveK8sUrl()
  if (!K8S) return NextResponse.json({ error: 'K8S_API_URL not configured' }, { status: 503 })

  try {
    const [pvData, scData, pvcData, volUsedRaw, volCapRaw, inodesUsedRaw, inodesFreeRaw, podsData, cmData, secretData] = await Promise.all([
      k8sGet('/api/v1/persistentvolumes'),
      k8sGet('/apis/storage.k8s.io/v1/storageclasses'),
      k8sGet('/api/v1/persistentvolumeclaims'),
      // Prometheus kubelet volume stats (real disk usage per PVC)
      promQuery('kubelet_volume_stats_used_bytes'),
      promQuery('kubelet_volume_stats_capacity_bytes'),
      // Inode metrics
      promQuery('kubelet_volume_stats_inodes_used'),
      promQuery('kubelet_volume_stats_inodes_free'),
      // Pod list for PVC mount mapping and orphaned resource detection
      k8sGet('/api/v1/pods?limit=500'),
      k8sGet('/api/v1/configmaps?limit=500'),
      k8sGet('/api/v1/secrets?limit=500'),
    ])

    // Build PVC key -> used/capacity from Prometheus
    // label: namespace, persistentvolumeclaim
    const volUsedMap: Record<string, number> = {}
    const volCapMap: Record<string, number> = {}
    const inodesUsedMap: Record<string, number> = {}
    const inodesFreeMap: Record<string, number> = {}
    for (const r of volUsedRaw) {
      const key = `${r.metric.namespace}/${r.metric.persistentvolumeclaim}`
      volUsedMap[key] = parseFloat(r.value?.[1] ?? 0) / (1024 ** 3)
    }
    for (const r of volCapRaw) {
      const key = `${r.metric.namespace}/${r.metric.persistentvolumeclaim}`
      volCapMap[key] = parseFloat(r.value?.[1] ?? 0) / (1024 ** 3)
    }
    for (const r of inodesUsedRaw) {
      const key = `${r.metric.namespace}/${r.metric.persistentvolumeclaim}`
      inodesUsedMap[key] = parseFloat(r.value?.[1] ?? 0)
    }
    for (const r of inodesFreeRaw) {
      const key = `${r.metric.namespace}/${r.metric.persistentvolumeclaim}`
      inodesFreeMap[key] = parseFloat(r.value?.[1] ?? 0)
    }

    // Build PVC → mounting pods map
    type PodRef = { name: string; namespace: string; status: string }
    const pvcPodsMap: Record<string, PodRef[]> = {}
    // Build referenced configmaps/secrets sets
    const refCMs = new Set<string>()   // namespace/name
    const refSecrets = new Set<string>()
    const SKIP_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease', 'monitoring', 'cert-manager', 'cattle-system'])

    for (const pod of podsData?.items ?? []) {
      const ns: string = pod.metadata?.namespace ?? ''
      const podName: string = pod.metadata?.name ?? ''
      const podStatus: string = pod.status?.phase ?? 'Unknown'
      // PVC volumes
      for (const vol of pod.spec?.volumes ?? []) {
        if (vol.persistentVolumeClaim?.claimName) {
          const key = `${ns}/${vol.persistentVolumeClaim.claimName}`
          if (!pvcPodsMap[key]) pvcPodsMap[key] = []
          pvcPodsMap[key].push({ name: podName, namespace: ns, status: podStatus })
        }
        if (vol.configMap?.name) refCMs.add(`${ns}/${vol.configMap.name}`)
        if (vol.secret?.secretName) refSecrets.add(`${ns}/${vol.secret.secretName}`)
      }
      // envFrom
      for (const c of [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])]) {
        for (const ef of c.envFrom ?? []) {
          if (ef.configMapRef?.name) refCMs.add(`${ns}/${ef.configMapRef.name}`)
          if (ef.secretRef?.name) refSecrets.add(`${ns}/${ef.secretRef.name}`)
        }
        for (const env of c.env ?? []) {
          if (env.valueFrom?.configMapKeyRef?.name) refCMs.add(`${ns}/${env.valueFrom.configMapKeyRef.name}`)
          if (env.valueFrom?.secretKeyRef?.name) refSecrets.add(`${ns}/${env.valueFrom.secretKeyRef.name}`)
        }
      }
      for (const ips of pod.spec?.imagePullSecrets ?? []) {
        if (ips.name) refSecrets.add(`${ns}/${ips.name}`)
      }
    }

    // Orphaned ConfigMaps
    const SKIP_CM_NAMES = new Set(['kube-root-ca.crt'])
    const orphanedConfigMaps = (cmData?.items ?? [])
      .filter((cm: any) => {
        const ns = cm.metadata?.namespace ?? ''
        const name = cm.metadata?.name ?? ''
        if (SKIP_NS.has(ns)) return false
        if (SKIP_CM_NAMES.has(name)) return false
        if (name.startsWith('sh.helm.release')) return false
        return !refCMs.has(`${ns}/${name}`)
      })
      .map((cm: any) => ({
        name: cm.metadata.name,
        namespace: cm.metadata.namespace,
        createdAt: cm.metadata.creationTimestamp,
        keys: Object.keys(cm.data ?? {}).length,
      }))

    // Orphaned Secrets (skip system types)
    const SKIP_SECRET_TYPES = new Set([
      'kubernetes.io/service-account-token',
      'helm.sh/release.v1',
      'kubernetes.io/tls',
      'bootstrap.kubernetes.io/token',
    ])
    const orphanedSecrets = (secretData?.items ?? [])
      .filter((s: any) => {
        const ns = s.metadata?.namespace ?? ''
        const name = s.metadata?.name ?? ''
        const type = s.type ?? ''
        if (SKIP_NS.has(ns)) return false
        if (SKIP_SECRET_TYPES.has(type)) return false
        if (name.startsWith('sh.helm.release')) return false
        return !refSecrets.has(`${ns}/${name}`)
      })
      .map((s: any) => ({
        name: s.metadata.name,
        namespace: s.metadata.namespace,
        type: s.type ?? 'Opaque',
        createdAt: s.metadata.creationTimestamp,
        keys: Object.keys(s.data ?? {}).length,
      }))

    const pvs = (pvData.items ?? []).map((pv: any) => {
      const claimKey = pv.spec.claimRef ? `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}` : null
      const pvCapacityGiB = parseCapacity(pv.spec.capacity?.storage)
      const pvUsedRaw = claimKey && volUsedMap[claimKey] !== undefined ? Math.round(volUsedMap[claimKey] * 100) / 100 : 0
      // Discard kubelet_volume_stats if it exceeds provisioned capacity — local-path reports host partition, not PVC data
      const pvUsedGiB = pvCapacityGiB > 0 && pvUsedRaw > pvCapacityGiB ? 0 : pvUsedRaw
      return {
      name: pv.metadata.name,
      capacityGiB: pvCapacityGiB,
      usedGiB: pvUsedGiB,
      storageClass: pv.spec.storageClassName ?? 'unknown',
      accessMode: normalizeAccessMode(pv.spec.accessModes?.[0]),
      reclaimPolicy: pv.spec.persistentVolumeReclaimPolicy ?? 'Delete',
      status: pv.status?.phase ?? 'Available',
      claimRef: pv.spec.claimRef ? `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}` : undefined,
      volumeMode: pv.spec.volumeMode ?? 'Filesystem',
      provisioner: pv.spec.csi?.driver ?? pv.spec.storageClassName ?? 'unknown',
      createdAt: pv.metadata.creationTimestamp,
      // Orphaned: Released status with no active claim
      orphaned: pv.status?.phase === 'Released' && !pv.spec.claimRef,
    }
    })

    const storageclasses = (scData.items ?? []).map((sc: any) => ({
      name: sc.metadata.name,
      provisioner: sc.provisioner,
      reclaimPolicy: sc.reclaimPolicy ?? 'Delete',
      volumeBindingMode: sc.volumeBindingMode ?? 'Immediate',
      allowVolumeExpansion: sc.allowVolumeExpansion ?? false,
      isDefault: sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
      parameters: sc.parameters,
    }))

    const pvcs = (pvcData.items ?? []).map((pvc: any) => {
      const key = `${pvc.metadata.namespace}/${pvc.metadata.name}`
      const promUsed = volUsedMap[key]
      const promCap = volCapMap[key]
      // K8s-provisioned capacity is the authoritative size
      const k8sCapacityGiB = parseCapacity(pvc.status?.capacity?.storage) || parseCapacity(pvc.spec.resources?.requests?.storage)
      // If Prometheus capacity > 10% above K8s-provisioned size, kubelet is reporting the host
      // partition (local-path / hostPath provisioners) — discard all Prometheus volume stats
      const promReliable = promCap === undefined || k8sCapacityGiB === 0 || promCap <= k8sCapacityGiB * 1.1
      const capacityGiB = k8sCapacityGiB || (promReliable ? (promCap ?? 0) : 0)
      const usedRaw = promReliable && promUsed !== undefined ? Math.round(promUsed * 100) / 100 : undefined
      const usedGiB = usedRaw
      const usedPct = usedGiB !== undefined && capacityGiB > 0 ? Math.round((usedGiB / capacityGiB) * 100) : undefined
      return {
        name: pvc.metadata.name,
        namespace: pvc.metadata.namespace,
        status: pvc.status?.phase ?? 'Pending',
        storageClass: pvc.spec.storageClassName ?? 'unknown',
        accessMode: normalizeAccessMode(pvc.spec.accessModes?.[0]),
        volumeName: pvc.spec.volumeName ?? null,
        capacityGiB: Math.round(capacityGiB * 100) / 100,
        requestedGiB: parseCapacity(pvc.spec.resources?.requests?.storage),
        volumeMode: pvc.spec.volumeMode ?? 'Filesystem',
        createdAt: pvc.metadata.creationTimestamp,
        // Prometheus-sourced usage
        usedGiB,
        usedPct,
        hasLiveMetrics: promReliable && promUsed !== undefined,
        // Inode utilization
        inodesUsed: inodesUsedMap[key],
        inodesFree: inodesFreeMap[key],
        inodesUsedPct: inodesUsedMap[key] !== undefined && inodesFreeMap[key] !== undefined
          ? Math.round(inodesUsedMap[key] / (inodesUsedMap[key] + inodesFreeMap[key]) * 100)
          : undefined,
        // Pods currently mounting this PVC
        mountedByPods: pvcPodsMap[key] ?? [],
      }
    })

    // Orphaned PVs = Released with no active claim (consistent with per-PV orphaned flag)
    const orphanedPVs = pvs.filter(p => p.orphaned)

    // Storage summary
    const totalCapacity = pvs.reduce((a, p) => a + p.capacityGiB, 0)
    const boundCount = pvs.filter(p => p.status === 'Bound').length
    const pvcNearFull = pvcs.filter(p => p.usedPct !== undefined && p.usedPct >= 80)

    return NextResponse.json({
      pvs,
      storageclasses,
      pvcs,
      orphanedPVs,
      orphanedConfigMaps,
      orphanedSecrets,
      summary: {
        totalCapacityGiB: Math.round(totalCapacity),
        boundCount,
        orphanedCount: orphanedPVs.length,
        orphanedWasteGiB: Math.round(orphanedPVs.reduce((a, p) => a + p.capacityGiB, 0)),
        pvcNearFull: pvcNearFull.length,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}

function parseCapacity(s?: string): number {
  if (!s) return 0
  if (s.endsWith('Gi')) return parseFloat(s)
  if (s.endsWith('Mi')) return parseFloat(s) / 1024
  if (s.endsWith('Ti')) return parseFloat(s) * 1024
  if (s.endsWith('Ki')) return parseFloat(s) / (1024 * 1024)
  return parseFloat(s) / (1024 ** 3)
}

function normalizeAccessMode(m?: string): 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany' {
  if (m === 'ReadWriteMany') return 'ReadWriteMany'
  if (m === 'ReadOnlyMany') return 'ReadOnlyMany'
  return 'ReadWriteOnce'
}
