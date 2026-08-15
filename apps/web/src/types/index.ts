// ═══════════════════════════════════════════════════════════
// VynOps AI — Core Type Definitions
// ═══════════════════════════════════════════════════════════

// ── Severity & Status ────────────────────────────────────────
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type HealthStatus = 'healthy' | 'degraded' | 'critical' | 'unknown'
export type AlertState = 'firing' | 'resolved' | 'acknowledged' | 'suppressed'
export type IncidentState = 'open' | 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'postmortem'
export type PodPhase = 'Running' | 'Pending' | 'Failed' | 'Succeeded' | 'Unknown' | 'CrashLoopBackOff' | 'OOMKilled'
export type NodeCondition = 'Ready' | 'NotReady' | 'SchedulingDisabled'
export type CloudProvider = 'aws' | 'azure' | 'gcp' | 'on-prem'

// ── Time range ───────────────────────────────────────────────
export type TimeRange = '15m' | '30m' | '1h' | '3h' | '6h' | '12h' | '24h' | '7d' | '30d'

// ── Generic ──────────────────────────────────────────────────
export interface TimeSeriesPoint {
  ts: number        // unix ms
  value: number
}

export interface LabelSet {
  [key: string]: string
}

// ── Global Health Score ──────────────────────────────────────
export interface GlobalHealthScore {
  score: number           // 0-100
  status: HealthStatus
  uptime: number          // percentage
  mttr: number            // minutes
  mttd: number            // minutes
  changeFailureRate: number
  deploymentFrequency: number
  trend: 'up' | 'down' | 'stable'
  _debug?: {
    nodes:   { total: number; ready: number }
    pods:    { workload: number; running: number; failed: number }
    deploys: { total: number; unavailable: number }
    cpuPct:  number | null
    memPct:  number | null
  }
}

// ── Alerts ───────────────────────────────────────────────────
export interface Alert {
  id: string
  name: string
  severity: Severity
  state: AlertState
  summary: string
  description: string
  labels: LabelSet
  annotations: LabelSet
  startsAt: string
  endsAt?: string
  acknowledgedBy?: string
  acknowledgedAt?: string
  source: string          // prometheus | grafana | custom
  affectedServices: string[]
  aiCorrelated?: boolean
  incidentId?: string
}

export interface AlertSummary {
  total: number
  critical: number
  high: number
  medium: number
  low: number
  firing: number
  acknowledged: number
  resolved: number
}

// ── Incidents ────────────────────────────────────────────────
export interface IncidentTimelineEvent {
  id: string
  ts: string
  type: 'alert' | 'deployment' | 'config_change' | 'k8s_event' | 'user_action' | 'ai_insight' | 'escalation' | 'resolution'
  title: string
  description: string
  actor?: string
  severity?: Severity
  metadata?: Record<string, unknown>
  eventId?: string   // links to K8sEvent.id when type === 'k8s_event'
}

export interface BlastRadius {
  affectedServices: string[]
  affectedUsers: number
  affectedRegions: string[]
  revenueImpact?: number     // USD/min
  slaBreached: boolean
  dependentServices: string[]
}

export interface RCAFinding {
  id: string
  rootCause: string
  confidence: number   // 0-1
  evidence: string[]
  affectedComponents: string[]
  triggerEvent: string
  contributingFactors: string[]
  recommendation: string
  generatedAt: string
}

export interface Incident {
  id: string
  title: string
  description: string
  severity: Severity
  state: IncidentState
  owner: string
  team: string
  service: string
  environment: string
  labels: LabelSet
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  slaDeadline: string
  slaBreached: boolean
  alerts: Alert[]
  timeline: IncidentTimelineEvent[]
  blastRadius: BlastRadius
  rca?: RCAFinding
  runbookUrl?: string
  slackChannel?: string
  linkedDeployments: string[]
  affectedServices?: string[]
  postmortemUrl?: string
}

// ── Kubernetes ───────────────────────────────────────────────
export interface K8sCluster {
  id: string
  name: string
  provider: CloudProvider
  region: string
  version: string
  status: HealthStatus
  nodeCount: number
  podCount: number
  namespaceCount: number
  cpuCapacity: number     // cores
  cpuUsed: number
  memoryCapacity: number  // GiB
  memoryUsed: number
  storageCapacity: number // GiB
  storageUsed: number     // GiB
  networkInMbps: number
  networkOutMbps: number
  createdAt: string
  // Connection details (set on registration, absent for the live cluster built from K8s API)
  k8sUrl?: string
  promUrl?: string
  alertmanagerUrl?: string
  lokiUrl?: string
  jaegerUrl?: string
  grafanaUrl?: string
  isDefault?: boolean
  // Enterprise metadata (P2)
  displayName?: string
  environment?: 'production' | 'staging' | 'development' | 'lab'
  description?: string
  tags?: string[]
  createdBy?: string
  updatedAt?: string
  updatedBy?: string
  lastProbed?: string
  lastProbedStatus?: HealthStatus
}

export interface NodeStorageDisk {
  device: string          // e.g. /dev/nvme0n1
  mountPath: string       // e.g. /, /var/lib/kubelet
  capacityGiB: number
  usedGiB: number
  iopsRead: number
  iopsWrite: number
  latencyMs: number
}

export interface K8sNode {
  name: string
  status: NodeCondition
  role: 'control-plane' | 'worker'
  instanceType: string
  region: string
  zone: string
  cpuCapacity: number
  cpuUsed: number
  memoryCapacity: number
  memoryUsed: number
  podCount: number
  podCapacity: number
  conditions: { type: string; status: string; lastTransitionTime: string }[]
  taints: { key: string; effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'; value?: string }[]
  kubeletVersion: string
  // Storage
  disks: NodeStorageDisk[]
  // Network
  networkInMbps: number
  networkOutMbps: number
  networkBandwidthMbps: number  // max capacity
  packetDropRate: number        // 0-1
  // OS
  osImage: string
  kernelVersion: string
  containerRuntime: string
  uptime: number                // hours
  createdAt: string
  labels: LabelSet
  unschedulable?: boolean
}

export interface PersistentVolume {
  name: string
  capacityGiB: number
  usedGiB: number
  storageClass: string
  accessMode: 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany'
  reclaimPolicy: 'Retain' | 'Delete' | 'Recycle'
  status: 'Bound' | 'Available' | 'Released' | 'Failed'
  claimRef?: string            // namespace/pvc-name
  volumeMode: 'Filesystem' | 'Block'
  provisioner: string
  createdAt: string
}

export interface PersistentVolumeClaim {
  name: string
  namespace: string
  status: 'Bound' | 'Pending' | 'Lost' | 'Available' | 'Released' | 'Failed'
  storageClass: string
  accessMode: 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany'
  volumeName: string | null
  capacityGiB: number
  requestedGiB: number
  volumeMode: 'Filesystem' | 'Block'
  createdAt: string
}

export interface StorageClass {
  name: string
  provisioner: string
  reclaimPolicy: 'Retain' | 'Delete' | 'Recycle'
  volumeBindingMode: 'Immediate' | 'WaitForFirstConsumer'
  allowVolumeExpansion: boolean
  isDefault: boolean
  parameters?: Record<string, string>
}

export interface K8sNamespace {
  name: string
  status: string
  createdAt: string
  labels: Record<string, string>
}

export interface K8sServicePort {
  name?: string
  port: number
  targetPort: string | number
  protocol: 'TCP' | 'UDP' | 'SCTP'
  nodePort?: number
}

export interface K8sService {
  name: string
  namespace: string
  type: 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName'
  clusterIP: string
  externalIP: string | null
  externalIPs?: string[]
  ports: string
  portDetails: K8sServicePort[]
  selector: string | null
  readyEndpoints: number
  sessionAffinity: 'None' | 'ClientIP'
  externalTrafficPolicy?: 'Cluster' | 'Local'
  createdAt: string
}

export interface K8sContainerPort {
  name?: string
  containerPort: number
  protocol: 'TCP' | 'UDP'
}

export interface K8sContainerEnv {
  name: string
  value?: string
  valueFrom?: string
}

export interface K8sContainerMount {
  name: string
  mountPath: string
  readOnly: boolean
}

export interface K8sContainer {
  name: string
  image: string
  ready: boolean
  started: boolean
  restarts: number
  state: 'running' | 'waiting' | 'terminated'
  stateReason?: string
  lastTerminatedReason?: string
  isInit?: boolean
  cpuRequest?: string
  cpuLimit?: string
  memRequest?: string
  memLimit?: string
  ports: K8sContainerPort[]
  env: K8sContainerEnv[]
  volumeMounts: K8sContainerMount[]
  livenessProbe?: string
  readinessProbe?: string
  startupProbe?: string
}

export interface K8sPod {
  name: string
  namespace: string
  status: string
  ready: string
  restarts: number
  restartsLast10m?: number
  oomKilled?: boolean
  age: string
  nodeName: string
  nodeZone?: string
  containers: K8sContainer[]
  initContainers?: K8sContainer[]
  labels?: Record<string, string>
  podIP?: string
  qosClass?: string
  pdbName?: string | null
  schedulingFailureReason?: string | null
  reason?: string
  topologySpreadConstraints?: { maxSkew: number; topologyKey: string; whenUnsatisfiable: string; labelSelector?: Record<string, string> }[]
  conditions?: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[]
  cpuUsageCores?: number | null
  memUsageBytes?: number | null
  tolerations?: { key?: string; operator: string; value?: string; effect?: string }[]
  nodeSelector?: Record<string, string> | null
}

export interface K8sSecretCount {
  namespace: string
  count: number
  items?: { name: string; type: string; createdAt: string }[]
}

export interface K8sServiceAccount {
  name: string
  namespace: string
  secrets: number
  createdAt: string
}

export interface K8sComponentStatus {
  name: string
  healthy: boolean
  message: string
  error: string
}

export interface K8sConfigMap {
  name: string
  namespace: string
  keys: number
  createdAt: string
}

export interface K8sDeployment {
  name: string
  namespace: string
  ready: number
  desired: number
  available: number
  updated: number
  unavailable?: number
  image: string
  containerCount?: number
  createdAt: string
  strategy?: string
  labels?: Record<string, string>
  selector?: Record<string, string>
  rollingOut?: boolean
  helmRelease?: string | null
  helmChart?: string | null
  helmNs?: string | null
  actualCpuCores?: number | null
  actualMemBytes?: number | null
  conditions?: { type: string; status: string; reason?: string; message?: string }[]
  containers?: { name: string; image: string; cpuRequest?: string; cpuLimit?: string; memRequest?: string; memLimit?: string }[]
}

export interface K8sStatefulSet {
  name: string
  namespace: string
  ready: number
  desired: number
  image: string
  createdAt: string
  selector?: Record<string, string>
  rollingOut?: boolean
  updateStrategy?: string
  podManagementPolicy?: string
  volumeClaimTemplates?: number
  currentRevision?: string | null
  updateRevision?: string | null
  helmRelease?: string | null
  helmChart?: string | null
  conditions?: { type: string; status: string; reason?: string; message?: string }[]
  containers?: { name: string; image: string; cpuRequest?: string; cpuLimit?: string; memRequest?: string; memLimit?: string }[]
  actualCpuCores?: number | null
  actualMemBytes?: number | null
}

export interface K8sHPA {
  name: string
  namespace: string
  targetKind: string
  targetName: string
  minReplicas: number
  maxReplicas: number
  currentReplicas: number
  desiredReplicas: number
  lastScaleTime?: string | null
  metrics: { type: string; resourceName?: string; targetAverageUtilization?: number | null; currentAverageUtilization?: number | null; targetAverageValue?: string | null; currentAverageValue?: string | null }[]
  conditions?: { type: string; status: string; reason?: string }[]
}

export interface K8sJob {
  name: string
  namespace: string
  status: 'Complete' | 'Failed' | 'Running'
  succeeded: number
  failed: number
  active: number
  completions: number
  image: string
  startTime?: string
  completionTime?: string
  durationSec?: number | null
  ownerKind?: string | null
  ownerName?: string | null
}

export interface K8sCronJob {
  name: string
  namespace: string
  schedule: string
  lastSchedule?: string | null
  active: number
  suspended: boolean
  image: string
  createdAt: string
  concurrencyPolicy?: string
}

export interface K8sDaemonSet {
  name: string
  namespace: string
  desired: number
  ready: number
  available: number
  unavailable?: number
  misscheduled?: number
  image: string
  createdAt: string
  updateStrategy?: string
  conditions?: { type: string; status: string; reason?: string; message?: string }[]
  actualCpuCores?: number | null
  actualMemBytes?: number | null
}

export interface K8sPDB {
  name: string
  namespace: string
  minAvailable: number | string | null
  maxUnavailable: number | string | null
  currentHealthy: number
  desiredHealthy: number
  expectedPods: number
  disruptionsAllowed: number
  selector: Record<string, string>
}

export interface K8sPriorityClass {
  name: string
  value: number
  globalDefault: boolean
  preemptionPolicy: string   // 'PreemptLowerPriority' | 'Never'
  description: string
  createdAt: string
}

export interface LimitRange {
  name: string
  namespace: string
  limits: {
    type: string
    resource: string
    default: Record<string, string>
    defaultRequest: Record<string, string>
    max: Record<string, string>
    min: Record<string, string>
  }[]
}

export interface ResourceQuota {
  name: string
  namespace: string
  cpuRequestUsed: number; cpuRequestLimit: number   // cores
  cpuLimitUsed: number;   cpuLimitLimit: number
  memRequestUsed: number; memRequestLimit: number   // GiB
  memLimitUsed: number;   memLimitLimit: number
  podUsed: number;        podLimit: number
  pvcUsed?: number;       pvcLimit?: number
  serviceUsed?: number;   serviceLimit?: number
}

// ── Database ─────────────────────────────────────────────────
export type DbEngine = 'postgres' | 'mysql' | 'redis' | 'kafka' | 'elasticsearch' | 'mongodb'
export type DbHosting = 'self-hosted' | 'rds' | 'cloud-sql' | 'elasticache' | 'azure-db'

export interface DbReplication {
  role: 'primary' | 'replica' | 'standalone'
  replicaCount: number
  lagSeconds?: number          // replica lag (undefined for primary/standalone)
}

export interface DatabaseInstance {
  id: string
  name: string
  engine: DbEngine
  version: string
  hosting: DbHosting
  namespace: string
  status: HealthStatus
  // Connections
  connectionPoolSize: number
  connectionsActive: number
  connectionsIdle: number
  connectionsWaiting: number   // queued / blocked
  // Performance
  qpsRead: number              // queries per second
  qpsWrite: number
  avgQueryMs: number
  p99QueryMs: number
  slowQueriesPerMin: number
  // Storage
  dataSizeGiB: number
  storageCapacityGiB: number
  // Memory (Redis / Elasticsearch)
  memoryUsedMiB?: number
  memoryCapacityMiB?: number
  // Replication
  replication: DbReplication
  // Backups
  lastBackupAt: string
  backupStatus: 'ok' | 'failed' | 'running' | 'never'
  // Meta
  node: string
  uptime: number               // hours
  linkedIncidentId?: string    // if this DB is linked to an active incident
}

export interface K8sEvent {
  id: string
  type: 'Normal' | 'Warning'
  reason: string
  message: string
  involvedObject: { kind: string; name: string; namespace: string }
  count: number
  firstTime: string
  lastTime: string
  linkedIncidentId?: string   // if this event is referenced in an incident timeline
  namespace?: string          // shorthand accessor
}

// ── Metrics ──────────────────────────────────────────────────
export interface ClusterMetrics {
  cpuUsage: number            // percent
  memoryUsage: number         // percent
  networkInBytes: number
  networkOutBytes: number
  diskReadBytes: number
  diskWriteBytes: number
  podRestartRate: number
  errorRate: number
  p50Latency: number          // ms
  p99Latency: number          // ms
  requestRate: number         // req/s
  history: {
    cpu: TimeSeriesPoint[]
    memory: TimeSeriesPoint[]
    requests: TimeSeriesPoint[]
    errors: TimeSeriesPoint[]
    latency: TimeSeriesPoint[]
  }
}

export interface ServiceMetric {
  name: string
  namespace: string
  requestRate: number
  errorRate: number
  p50Latency: number
  p99Latency: number
  availability: number
  status: HealthStatus
  dependsOn: string[]
  history: TimeSeriesPoint[]
}

// ── Topology ─────────────────────────────────────────────────
export type TopologyNodeType = 'service' | 'database' | 'queue' | 'gateway' | 'external' | 'pod' | 'ingress'

export interface TopologyNode {
  id: string
  label: string
  type: TopologyNodeType
  status: HealthStatus
  namespace?: string
  metadata: {
    requestRate?: number
    errorRate?: number
    latency?: number
    version?: string
  }
  x?: number
  y?: number
}

export interface TopologyEdge {
  id: string
  source: string
  target: string
  requestRate: number
  errorRate: number
  latency: number
  protocol: 'http' | 'grpc' | 'tcp' | 'amqp' | 'redis'
}

// ── RBAC ─────────────────────────────────────────────────────
export interface K8sRoleRule {
  verbs: string[]
  apiGroups: string[]
  resources: string[]
  resourceNames?: string[]
  nonResourceURLs?: string[]
}

export interface K8sRole {
  name: string
  namespace?: string        // undefined = ClusterRole
  isCluster: boolean
  rules: K8sRoleRule[]
  createdAt: string
}

export interface K8sRoleBinding {
  name: string
  namespace?: string
  isCluster: boolean
  roleRef: { kind: string; name: string }
  subjects: { kind: string; name: string; namespace?: string }[]
  createdAt: string
}

// ── Ingress ───────────────────────────────────────────────────
export interface K8sIngressPath {
  path: string
  pathType: string
  serviceName: string
  servicePort: string | number
}

export interface K8sIngress {
  name: string
  namespace: string
  className?: string
  annotations?: Record<string, string>
  rules: { host?: string; paths: K8sIngressPath[] }[]
  tls: { hosts: string[]; secretName: string }[]
  loadBalancerIPs: string[]
  createdAt: string
}

// ── TLS Certificate (from kubernetes.io/tls secrets) ─────────
export interface TlsCert {
  name: string
  namespace: string
  subject: string
  issuer: string
  dnsNames: string[]
  ipAddresses: string[]
  notBefore: string
  notAfter: string
  daysRemaining: number
  isExpired: boolean
  isExpiringSoon: boolean
}

// ── NetworkPolicy ─────────────────────────────────────────────
export interface K8sNetworkPolicyPeer {
  podSelector?: Record<string, string>
  namespaceSelector?: Record<string, string>
  ipBlock?: { cidr: string; except?: string[] }
}

export interface K8sNetworkPolicy {
  name: string
  namespace: string
  podSelector: Record<string, string>
  policyTypes: string[]
  ingressRules: number
  egressRules: number
  ingress: { from: K8sNetworkPolicyPeer[]; ports: { port: string | number; protocol: string }[] }[]
  egress:  { to:   K8sNetworkPolicyPeer[]; ports: { port: string | number; protocol: string }[] }[]
  createdAt: string
}

// ── Container metrics (actual runtime, from Prometheus) ───────
export interface K8sContainerMetrics {
  container: string
  pod: string
  namespace: string
  cpuUsageCores: number       // actual cores
  cpuUsagePct?: number        // vs limit (if limit set)
  memUsageMiB: number
  memUsagePct?: number
  sparkCpu: number[]          // last 20 data points (5min window)
  sparkMem: number[]
}

export interface TopologyGraph {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  updatedAt: string
}

// ── Security ─────────────────────────────────────────────────
export type ThreatCategory = 'runtime' | 'network' | 'container' | 'secret' | 'privilege' | 'compliance'

export interface SecurityThreat {
  id: string
  title: string
  category: ThreatCategory
  severity: Severity
  description: string
  affectedResource: string
  namespace?: string
  detectedAt: string
  mitigated: boolean
  cve?: string
  remediation: string
  aiExplanation?: string
}

export interface ComplianceCheck {
  id: string
  name: string
  framework: 'CIS' | 'NIST' | 'SOC2' | 'PCI-DSS' | 'HIPAA'
  passed: boolean
  severity: Severity
  description: string
  remediation: string
}

// ── FinOps ───────────────────────────────────────────────────
export interface CloudCostSummary {
  totalMonthly: number
  projected: number
  savings: number
  wastedResources: number
  byService: { name: string; cost: number; trend: number }[]
  byProvider: { provider: CloudProvider; cost: number }[]
  history: TimeSeriesPoint[]
  optimizationSuggestions: {
    id: string
    title: string
    savings: number
    effort: 'low' | 'medium' | 'high'
  }[]
}

// ── AI ───────────────────────────────────────────────────────
export interface AIChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  ts: string
  thinking?: boolean
  sources?: { title: string; type: string }[]
  actions?: AIAction[]
}

export interface AIAction {
  id: string
  label: string
  type: 'kubectl' | 'script' | 'api' | 'notify'
  command: string
  riskLevel: 'safe' | 'caution' | 'dangerous'
  requiresApproval: boolean
}

export interface AIInsight {
  id: string
  type: 'anomaly' | 'prediction' | 'recommendation' | 'rca' | 'cost'
  title: string
  description: string
  confidence: number    // 0-1
  severity: Severity
  affectedServices: string[]
  ts: string
  dismissed: boolean
  actions?: AIAction[]
}

// ── Navigation ───────────────────────────────────────────────
export interface NavItem {
  id: string
  label: string
  href: string
  icon: string          // lucide icon name
  badge?: number | string
  children?: NavItem[]
}

// ── User & Auth ──────────────────────────────────────────────
export interface User {
  id: string
  name: string
  email: string
  avatar?: string
  role: 'admin' | 'editor' | 'viewer' | 'on-call'
  team: string
}

export interface Environment {
  id: string
  name: string
  type: 'production' | 'staging' | 'development'
  cluster: string
  region: string
  color: string
}

// ── Deployment Tracking ───────────────────────────────────────
export type DeployStatus = 'success' | 'failed' | 'in-progress' | 'rolled-back'
export type DeployMethod = 'rolling' | 'canary' | 'blue-green' | 'recreate'

export interface DeploymentChange {
  type: 'image' | 'config' | 'replicas' | 'resource' | 'env'
  field: string
  from: string
  to: string
}

export interface DeploymentEvent {
  id: string
  service: string
  version: string
  previousVersion: string
  previousRsName?: string | null
  environment: 'production' | 'staging' | 'development'
  namespace: string
  cluster: string
  deployer: string
  method: DeployMethod
  status: DeployStatus
  startedAt: string
  completedAt?: string
  durationSeconds: number
  isEstimated?: boolean        // true when duration is derived from heuristic/proxy, not real K8s timestamp
  changes: DeploymentChange[]
  linkedIncidentId?: string   // set when this deploy caused an incident
  riskScore: number            // 0-100, AI-predicted pre-deploy risk
  rollbackOf?: string          // id of the deploy being reverted
  replicas: { desired: number; ready: number }
  commitSha: string
  branch: string
}

// ── Distributed Tracing ───────────────────────────────────────
export interface TraceSpan {
  id: string
  parentId?: string
  service: string
  operation: string
  startOffset: number   // ms from trace start
  duration: number      // ms
  status: 'ok' | 'error' | 'slow'
  tags?: Record<string, string>
  depth: number
}

export interface Trace {
  id: string
  rootOperation: string
  rootService: string
  totalDuration: number
  spanCount: number
  status: 'ok' | 'error' | 'slow'
  startedAt: string
  spans: TraceSpan[]
}

