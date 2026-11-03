const DECIMAL_SUFFIXES: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
}
const BINARY_SUFFIXES: Record<string, number> = {
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3,
  Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
}

export function parseKubernetesQuantity(value?: string | number): number {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid Kubernetes resource quantity')
    return value
  }
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(value)
  if (!match) throw new Error(`Invalid Kubernetes resource quantity: ${value}`)
  const numeric = Number(match[1])
  const suffix = match[2]!
  const multiplier = suffix === '' ? 1 : BINARY_SUFFIXES[suffix] ?? DECIMAL_SUFFIXES[suffix]
  if (!Number.isFinite(numeric) || multiplier === undefined) throw new Error(`Unsupported Kubernetes resource quantity: ${value}`)
  const result = numeric * multiplier
  if (!Number.isFinite(result)) throw new Error(`Invalid Kubernetes resource quantity: ${value}`)
  return result
}

export function parseCpuMillis(value?: string | number): number {
  return parseKubernetesQuantity(value) * 1000
}

export function parseMemMiB(value?: string | number): number {
  return parseKubernetesQuantity(value) / (1024 ** 2)
}

export function parseCapGiB(value?: string | number): number {
  return parseKubernetesQuantity(value) / (1024 ** 3)
}

export function calculateWeightedEfficiency(input: {
  cpuRequested: number
  cpuActual: number | null
  memoryRequestedGiB: number
  memoryActualGiB: number | null
  cpuRate: number
  memoryRate: number
}): number | null {
  const { cpuRequested, cpuActual, memoryRequestedGiB, memoryActualGiB, cpuRate, memoryRate } = input
  if ((cpuRequested > 0 && cpuActual === null) || (memoryRequestedGiB > 0 && memoryActualGiB === null)) return null
  const requestedCost = cpuRequested * cpuRate + memoryRequestedGiB * memoryRate
  if (requestedCost <= 0) return null
  const actualCost = (cpuActual ?? 0) * cpuRate + (memoryActualGiB ?? 0) * memoryRate
  return Math.min(100, Math.round(actualCost / requestedCost * 100))
}

function sumRequests(containers: any[]) {
  return containers.reduce((sum, container) => ({
    cpuMillis: sum.cpuMillis + parseCpuMillis(container.resources?.requests?.cpu),
    memMiB: sum.memMiB + parseMemMiB(container.resources?.requests?.memory),
  }), { cpuMillis: 0, memMiB: 0 })
}

export function getEffectivePodRequests(pod: any) {
  const appRequests = sumRequests(pod.spec?.containers ?? [])
  let restartableInitRequests = { cpuMillis: 0, memMiB: 0 }
  let peakInitRequests = { cpuMillis: 0, memMiB: 0 }

  for (const container of pod.spec?.initContainers ?? []) {
    const request = sumRequests([container])
    if (container.restartPolicy === 'Always') {
      restartableInitRequests = {
        cpuMillis: restartableInitRequests.cpuMillis + request.cpuMillis,
        memMiB: restartableInitRequests.memMiB + request.memMiB,
      }
      peakInitRequests = {
        cpuMillis: Math.max(peakInitRequests.cpuMillis, restartableInitRequests.cpuMillis),
        memMiB: Math.max(peakInitRequests.memMiB, restartableInitRequests.memMiB),
      }
    } else {
      peakInitRequests = {
        cpuMillis: Math.max(peakInitRequests.cpuMillis, restartableInitRequests.cpuMillis + request.cpuMillis),
        memMiB: Math.max(peakInitRequests.memMiB, restartableInitRequests.memMiB + request.memMiB),
      }
    }
  }

  const overhead = pod.spec?.overhead ?? {}
  return {
    cpuMillis: Math.max(appRequests.cpuMillis + restartableInitRequests.cpuMillis, peakInitRequests.cpuMillis) + parseCpuMillis(overhead.cpu),
    memMiB: Math.max(appRequests.memMiB + restartableInitRequests.memMiB, peakInitRequests.memMiB) + parseMemMiB(overhead.memory),
  }
}