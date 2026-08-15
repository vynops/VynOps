import { create } from 'zustand'
import { devtools, subscribeWithSelector } from 'zustand/middleware'
import type {
  Alert, Incident, AIInsight, GlobalHealthScore, ClusterMetrics,
  ServiceMetric, TopologyGraph, SecurityThreat, CloudCostSummary,
  K8sCluster, TimeRange, AIChatMessage, User,
  HealthStatus,
} from '@/types'

const VALID_RANGES = ['15m','30m','1h','3h','6h','12h','24h','7d','30d']
function readTimeRange(): TimeRange {
  try {
    const v = typeof window !== 'undefined' ? localStorage.getItem('timeRange') : null
    return (v && VALID_RANGES.includes(v) ? v : '24h') as TimeRange
  } catch { return '24h' }
}

function readRealtimeActive(): boolean {
  try {
    const v = typeof window !== 'undefined' ? localStorage.getItem('realtimeActive') : null
    return v === null ? true : v === 'true'
  } catch { return true }
}

function readActiveClusterId(): string | null {
  try {
    return typeof window !== 'undefined' ? localStorage.getItem('activeClusterId') : null
  } catch { return null }
}

// -- Dashboard store (global state) ---------------------------
interface DashboardState {
  // Active cluster & user
  activeCluster: K8sCluster | null
  user: User
  timeRange: TimeRange

  // Data
  healthScore: GlobalHealthScore
  alerts: Alert[]
  incidents: Incident[]
  aiInsights: AIInsight[]
  clusterMetrics: ClusterMetrics
  serviceMetrics: ServiceMetric[]
  topology: TopologyGraph
  threats: SecurityThreat[]
  costSummary: CloudCostSummary
  clusters: K8sCluster[]

  // UI state
  commandPaletteOpen: boolean
  rightSidebarOpen: boolean
  activeIncidentId: string | null
  isRealtimeActive: boolean
  globalSearchQuery: string
  activeNamespace: string

  mobileNavOpen: boolean

  clusterStatus: 'checking' | 'unconfigured' | 'unreachable' | 'connected'
  clusterStatusCheckedAt: string | null
  setClusterStatus: (status: 'checking' | 'unconfigured' | 'unreachable' | 'connected', checkedAt?: string) => void

  // Actions
  setTimeRange: (range: TimeRange) => void
  setActiveCluster: (cluster: K8sCluster | null) => void
  openCommandPalette: () => void
  closeCommandPalette: () => void
  toggleRightSidebar: () => void
  toggleMobileNav: () => void
  setMobileNavOpen: (open: boolean) => void
  setActiveIncident: (id: string | null) => void
  dismissAIInsight: (id: string) => void
  acknowledgeAlert: (id: string, by: string) => void
  setGlobalSearch: (query: string) => void
  setActiveNamespace: (ns: string) => void
  toggleRealtime: () => void
  updateClusterMetrics: (update: Partial<{
    cpuUsage: number
    memoryUsage: number
    requestRate: number
    errorRate: number
    p99Latency: number
    activePods: number
  }>) => void
  addIncident: (incident: Incident) => void
  setIncidents: (incidents: Incident[]) => void
  setAlerts: (alerts: Alert[]) => void
  setHealthScore: (score: GlobalHealthScore) => void
  setServiceMetrics: (metrics: ServiceMetric[]) => void
  setClusters: (clusters: K8sCluster[]) => void
  addCluster: (cluster: K8sCluster) => void
  removeCluster: (id: string) => void
}

const defaultUser: User = {
  id: 'u1',
  name: 'Alex Karev',
  email: 'alex@VynOps.io',
  role: 'admin',
  team: 'Platform Engineering',
}

export const useDashboardStore = create<DashboardState>()(
  devtools(
    subscribeWithSelector((set) => ({
      activeCluster: null,
      user: defaultUser,
      timeRange: readTimeRange(),

      healthScore: { score: 0, status: 'healthy' as HealthStatus, uptime: 100, mttr: 0, mttd: 0, changeFailureRate: 0, deploymentFrequency: 0, trend: 'stable' as const },
      alerts: [] as Alert[],
      incidents: [] as Incident[],
      aiInsights: [] as AIInsight[],
      clusterMetrics: { cpuUsage: 0, memoryUsage: 0, networkInBytes: 0, networkOutBytes: 0, diskReadBytes: 0, diskWriteBytes: 0, podRestartRate: 0, errorRate: 0, p50Latency: 0, p99Latency: 0, requestRate: 0, history: { cpu: [], memory: [], requests: [], errors: [], latency: [] } } as ClusterMetrics,
      serviceMetrics: [] as ServiceMetric[],
      topology: { nodes: [], edges: [], updatedAt: new Date().toISOString() } as TopologyGraph,
      threats: [] as SecurityThreat[],
      costSummary: { totalMonthly: 0, projected: 0, savings: 0, wastedResources: 0, byService: [], byProvider: [], history: [], optimizationSuggestions: [] } as CloudCostSummary,
      clusters: [],

      commandPaletteOpen: false,
      rightSidebarOpen: true,
      mobileNavOpen: false,
      activeIncidentId: 'inc-001',
      clusterStatus: 'checking' as const,
      clusterStatusCheckedAt: null,
      isRealtimeActive: readRealtimeActive(),
      globalSearchQuery: '',
      activeNamespace: 'all',

      setTimeRange: (range) => { localStorage.setItem('timeRange', range); set({ timeRange: range }) },
      setActiveCluster: (cluster) => {
        try { if (cluster) localStorage.setItem('activeClusterId', cluster.id); else localStorage.removeItem('activeClusterId') } catch {}
        set({ activeCluster: cluster })
      },
      openCommandPalette: () => set({ commandPaletteOpen: true }),
      closeCommandPalette: () => set({ commandPaletteOpen: false }),
      toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
      toggleMobileNav: () => set((s) => ({ mobileNavOpen: !s.mobileNavOpen })),
      setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
      setActiveIncident: (id) => set({ activeIncidentId: id }),
      dismissAIInsight: (id) => set((s) => ({
        aiInsights: s.aiInsights.map(i => i.id === id ? { ...i, dismissed: true } : i),
      })),
      acknowledgeAlert: (id, by) => set((s) => ({
        alerts: s.alerts.map(a => a.id === id ? { ...a, state: 'acknowledged', acknowledgedBy: by, acknowledgedAt: new Date().toISOString() } : a),
      })),
      setGlobalSearch: (query) => set({ globalSearchQuery: query }),
      setActiveNamespace: (ns) => set({ activeNamespace: ns }),
      toggleRealtime: () => set((s) => {
        const next = !s.isRealtimeActive
        localStorage.setItem('realtimeActive', String(next))
        return { isRealtimeActive: next }
      }),
      updateClusterMetrics: (update) =>
        set((s) => ({
          clusterMetrics: { ...s.clusterMetrics, ...update },
        })),
      addIncident: (incident) =>
        set((s) => ({ incidents: [incident, ...s.incidents] })),
      setIncidents: (incidents) => set({ incidents }),
      setAlerts: (alerts) => set({ alerts }),
      setHealthScore: (score) => set({ healthScore: score }),
      setServiceMetrics: (metrics) => set({ serviceMetrics: metrics }),
      setClusters: (clusters) => set({ clusters }),
      addCluster: (cluster) => set((s) => ({ clusters: [...s.clusters.filter(c => c.id !== cluster.id), cluster] })),
      removeCluster: (id) => set((s) => ({ clusters: s.clusters.filter(c => c.id !== id) })),
      setClusterStatus: (status, checkedAt) => set({ clusterStatus: status, clusterStatusCheckedAt: checkedAt ?? new Date().toISOString() }),
    })),
    { name: 'VynOps-dashboard' },
  ),
)

/** Read active-cluster headers from the Zustand store without needing a hook.
 *  Safe to call inside fetch(), useEffect, callbacks, and inline onClick handlers. */
export function getClusterHeaders(): Record<string, string> {
  const activeCluster = useDashboardStore.getState().activeCluster
  if (!activeCluster) return {}
  return {
    'X-K8s-Url':          activeCluster.k8sUrl          || 'none',
    'X-Prom-Url':         activeCluster.promUrl         || 'none',
    'X-Alertmanager-Url': activeCluster.alertmanagerUrl || 'none',
    'X-Loki-Url':         activeCluster.lokiUrl         || 'none',
    'X-Jaeger-Url':       activeCluster.jaegerUrl       || 'none',
    'X-Grafana-Url':      activeCluster.grafanaUrl      || 'none',
  }
}

