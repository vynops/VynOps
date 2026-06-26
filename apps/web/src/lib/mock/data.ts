import type {
  Alert, Incident, K8sCluster, K8sNode, K8sPod, K8sDeployment,
  K8sEvent, TopologyGraph, SecurityThreat, CloudCostSummary,
  ServiceMetric, ClusterMetrics, AIInsight, GlobalHealthScore,
  TimeSeriesPoint, IncidentTimelineEvent, BlastRadius, RCAFinding,
  PersistentVolume, DatabaseInstance, StorageClass, ResourceQuota,
} from '@/types'
import { subMinutes, subHours, subDays, formatISO, addMinutes } from 'date-fns'

// ?? Utility ??????????????????????????????????????????????????
const now = () => new Date()
const ts = (offsetMinutes = 0) => formatISO(subMinutes(now(), offsetMinutes))
const rand = (min: number, max: number) => Math.random() * (max - min) + min
const randInt = (min: number, max: number) => Math.floor(rand(min, max))
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)] as T
const id = () => Math.random().toString(36).slice(2, 10)

// Generate a time series going back `count` points every `intervalMins`
export function generateTimeSeries(
  baseValue: number,
  variance: number,
  count = 60,
  intervalMins = 1,
): TimeSeriesPoint[] {
  let value = baseValue
  return Array.from({ length: count }, (_, i) => {
    value = Math.max(0, value + rand(-variance, variance))
    return {
      ts: subMinutes(now(), (count - i) * intervalMins).getTime(),
      value: Math.round(value * 100) / 100,
    }
  })
}

// ?? Global Health ????????????????????????????????????????????
export const mockHealthScore: GlobalHealthScore = {
  score: 87,
  status: 'degraded',
  uptime: 99.94,
  mttr: 23,
  mttd: 4.5,
  changeFailureRate: 3.2,
  deploymentFrequency: 18,
  trend: 'up',
}

// ?? Alerts ???????????????????????????????????????????????????
export const mockAlerts: Alert[] = [
  {
    id: 'alert-001',
    name: 'HighCPUUsage',
    severity: 'critical',
    state: 'firing',
    summary: 'CPU usage exceeds 95% on payment-service',
    description: 'payment-service pods are consuming >95% CPU for more than 5 minutes. Possible connection pool exhaustion or memory leak.',
    labels: { service: 'payment-service', namespace: 'payments', env: 'production', cluster: 'eks-prod-us-east' },
    annotations: { runbook: 'https://runbooks.internal/high-cpu' },
    startsAt: ts(12),
    source: 'prometheus',
    affectedServices: ['payment-service', 'checkout-api', 'fraud-detection'],
    aiCorrelated: true,
    incidentId: 'inc-001',
  },
  {
    id: 'alert-002',
    name: 'PodCrashLooping',
    severity: 'critical',
    state: 'firing',
    summary: 'payment-worker pods are CrashLoopBackOff',
    description: '3 out of 5 payment-worker pods are in CrashLoopBackOff state. OOMKill detected.',
    labels: { service: 'payment-worker', namespace: 'payments', env: 'production' },
    annotations: {},
    startsAt: ts(8),
    source: 'kubernetes',
    affectedServices: ['payment-worker', 'payment-service'],
    aiCorrelated: true,
    incidentId: 'inc-001',
  },
  {
    id: 'alert-003',
    name: 'DatabaseConnectionPoolExhausted',
    severity: 'critical',
    state: 'firing',
    summary: 'PostgreSQL connection pool at 99%',
    description: 'The payment PostgreSQL database connection pool is at 99% utilization. New connections are being refused.',
    labels: { service: 'postgres-payment', namespace: 'databases', tier: 'data' },
    annotations: {},
    startsAt: ts(15),
    source: 'prometheus',
    affectedServices: ['payment-service', 'payment-worker', 'billing-service'],
    aiCorrelated: true,
    incidentId: 'inc-001',
  },
  {
    id: 'alert-004',
    name: 'HighErrorRate',
    severity: 'high',
    state: 'firing',
    summary: 'Error rate on checkout-api exceeds 8%',
    description: 'checkout-api is returning 5xx errors at 8.3% rate, up from baseline of <0.1%.',
    labels: { service: 'checkout-api', namespace: 'commerce', env: 'production' },
    annotations: {},
    startsAt: ts(6),
    source: 'prometheus',
    affectedServices: ['checkout-api'],
    aiCorrelated: true,
    incidentId: 'inc-001',
  },
  {
    id: 'alert-005',
    name: 'NodeMemoryPressure',
    severity: 'high',
    state: 'firing',
    summary: 'Node ip-10-0-1-42 under memory pressure',
    description: 'Node is experiencing memory pressure. Available memory < 256Mi. Pod evictions may occur.',
    labels: { node: 'ip-10-0-1-42', zone: 'us-east-1a' },
    annotations: {},
    startsAt: ts(22),
    source: 'kubernetes',
    affectedServices: ['payment-service', 'auth-service'],
    aiCorrelated: false,
  },
  {
    id: 'alert-006',
    name: 'CertificateExpiringSoon',
    severity: 'medium',
    state: 'firing',
    summary: 'TLS certificate expires in 7 days',
    description: 'TLS certificate for api.VynOps.internal expires in 7 days.',
    labels: { domain: 'api.VynOps.internal' },
    annotations: {},
    startsAt: ts(120),
    source: 'custom',
    affectedServices: ['api-gateway'],
    aiCorrelated: false,
  },
  {
    id: 'alert-007',
    name: 'RecommendationServiceLatency',
    severity: 'medium',
    state: 'acknowledged',
    summary: 'p99 latency on recommendation-engine > 2000ms',
    description: 'recommendation-engine p99 latency has increased to 2.4s, up from 380ms baseline.',
    labels: { service: 'recommendation-engine', namespace: 'ml' },
    annotations: {},
    startsAt: ts(45),
    acknowledgedBy: 'sarah@VynOps.io',
    acknowledgedAt: ts(40),
    source: 'prometheus',
    affectedServices: ['recommendation-engine'],
    aiCorrelated: false,
  },
  {
    id: 'alert-008',
    name: 'KafkaConsumerLag',
    severity: 'low',
    state: 'firing',
    summary: 'Kafka consumer lag exceeds 10k messages',
    description: 'event-processor consumer group has accumulated 14,832 unprocessed messages.',
    labels: { topic: 'order-events', group: 'event-processor' },
    annotations: {},
    startsAt: ts(30),
    source: 'prometheus',
    affectedServices: ['event-processor'],
    aiCorrelated: false,
  },
]

// ?? Incidents ????????????????????????????????????????????????
const mockTimeline: IncidentTimelineEvent[] = [
  { id: id(), ts: ts(15), type: 'alert', title: 'DB connection pool alert fired', description: 'PostgreSQL connection pool reached 99% utilization', severity: 'critical' },
  { id: id(), ts: ts(13), type: 'ai_insight', title: 'AI correlation started', description: 'AI detected 3 related alerts ? correlating into incident', actor: 'VynOps AI' },
  { id: id(), ts: ts(12), type: 'alert', title: 'CPU spike on payment-service', description: 'CPU usage >95% on all payment-service pods', severity: 'critical' },
  { id: id(), ts: ts(11), type: 'ai_insight', title: 'Root cause identified', description: 'AI traced root cause to deployment build v2.13.1 ? memory leak in DB connection handler', actor: 'VynOps AI', severity: 'critical' },
  { id: id(), ts: ts(10), type: 'deployment', title: 'Deployment flagged', description: 'payment-service v2.13.1 deployed 18 minutes before incident start', metadata: { version: 'v2.13.1', deployer: 'ci-bot' } },
  { id: id(), ts: ts(8), type: 'alert', title: 'CrashLoopBackOff on payment-worker', description: '3/5 pods entering crash loop due to OOMKill', severity: 'critical' },
  { id: id(), ts: ts(7), type: 'user_action', title: 'Incident opened by on-call', description: 'alex@VynOps.io opened INC-001 and joined Slack #inc-payment-0511', actor: 'alex@VynOps.io' },
  { id: id(), ts: ts(6), type: 'escalation', title: 'Escalated to payments team', description: 'Incident escalated to payments engineering lead', actor: 'PagerDuty' },
  { id: id(), ts: ts(5), type: 'user_action', title: 'Rollback initiated', description: 'alex@VynOps.io triggered rollback to payment-service v2.12.8', actor: 'alex@VynOps.io' },
  { id: id(), ts: ts(3), type: 'k8s_event', title: 'Pods recovering', description: 'payment-service pods restarting with v2.12.8 image', severity: 'info', eventId: 'evt-002' },
  { id: id(), ts: ts(1), type: 'ai_insight', title: 'AI predicts resolution in 2min', description: 'Connection pool draining, CPU returning to baseline', actor: 'VynOps AI' },
]

const mockBlastRadius: BlastRadius = {
  affectedServices: ['payment-service', 'checkout-api', 'fraud-detection', 'billing-service', 'order-service'],
  affectedUsers: 14_832,
  affectedRegions: ['us-east-1', 'eu-west-1'],
  revenueImpact: 4_200,
  slaBreached: false,
  dependentServices: ['mobile-app', 'web-frontend', 'partner-api'],
}

const mockRCA: RCAFinding = {
  id: 'rca-001',
  rootCause: 'Memory leak in PostgreSQL connection handler introduced in payment-service v2.13.1',
  confidence: 0.94,
  evidence: [
    'Deployment of v2.13.1 occurred 18 minutes before incident start',
    'DB connection pool exhaustion directly correlates with pod memory growth',
    'OOMKill events confirm memory leak hypothesis',
    'No connection pool exhaustion seen in v2.12.x history',
    'Code diff shows new async connection handler not releasing connections on timeout',
  ],
  affectedComponents: ['payment-service', 'postgres-payment'],
  triggerEvent: 'Deployment of payment-service v2.13.1 at 09:47 UTC',
  contributingFactors: [
    'Missing connection timeout in new async handler',
    'Insufficient memory limits on payment-service pods',
    'No canary deployment ? change went to 100% of pods simultaneously',
  ],
  recommendation: 'Roll back to v2.12.8 immediately. Fix connection timeout in async handler before next release. Implement canary deployments for payment-service.',
  generatedAt: ts(11),
}

export const mockIncidents: Incident[] = [
  {
    id: 'inc-001',
    title: 'Payment Service Cascade Failure',
    description: 'Critical: payment-service experiencing cascade failure due to DB connection pool exhaustion following deployment v2.13.1. Active blast radius affecting checkout flow.',
    severity: 'critical',
    state: 'investigating',
    owner: 'alex@VynOps.io',
    team: 'Payments Engineering',
    service: 'payment-service',
    environment: 'production',
    labels: { team: 'payments', tier: '1', region: 'us-east-1' },
    createdAt: ts(13),
    updatedAt: ts(1),
    slaDeadline: formatISO(addMinutes(now(), 47)),
    slaBreached: false,
    alerts: mockAlerts.filter(a => a.incidentId === 'inc-001'),
    timeline: mockTimeline,
    blastRadius: mockBlastRadius,
    rca: mockRCA,
    runbookUrl: 'https://runbooks.internal/payment-service-recovery',
    slackChannel: '#inc-payment-0511',
    linkedDeployments: ['payment-service-v2.13.1'],
  },
  {
    id: 'inc-002',
    title: 'Recommendation Engine Degradation',
    description: 'recommendation-engine p99 latency elevated. ML model serving experiencing high inference times. No customer impact to core checkout flow.',
    severity: 'medium',
    state: 'identified',
    owner: 'priya@VynOps.io',
    team: 'ML Platform',
    service: 'recommendation-engine',
    environment: 'production',
    labels: { team: 'ml', tier: '2' },
    createdAt: ts(50),
    updatedAt: ts(38),
    slaDeadline: formatISO(addMinutes(now(), 130)),
    slaBreached: false,
    alerts: [mockAlerts[6] as Alert],
    timeline: [
      { id: id(), ts: ts(50), type: 'alert', title: 'Latency alert fired', description: 'p99 > 2000ms threshold breached', severity: 'medium' },
      { id: id(), ts: ts(45), type: 'ai_insight', title: 'AI identified GPU throttling', description: 'Inference pods experiencing GPU memory pressure', actor: 'VynOps AI' },
      { id: id(), ts: ts(38), type: 'user_action', title: 'Assigned to ML team', description: 'priya@VynOps.io took ownership', actor: 'priya@VynOps.io' },
    ],
    blastRadius: {
      affectedServices: ['recommendation-engine'],
      affectedUsers: 0,
      affectedRegions: ['us-east-1'],
      slaBreached: false,
      dependentServices: ['web-frontend'],
    },
    linkedDeployments: [],
  },
  {
    id: 'inc-003',
    title: 'Kafka Consumer Lag Spike',
    description: 'event-processor consumer group has accumulated significant lag. No data loss, processing will catch up.',
    severity: 'low',
    state: 'monitoring',
    owner: 'james@VynOps.io',
    team: 'Platform',
    service: 'event-processor',
    environment: 'production',
    labels: { team: 'platform', tier: '2' },
    createdAt: ts(35),
    updatedAt: ts(10),
    slaDeadline: formatISO(addMinutes(now(), 240)),
    slaBreached: false,
    alerts: [mockAlerts[7] as Alert],
    timeline: [],
    blastRadius: {
      affectedServices: ['event-processor'],
      affectedUsers: 0,
      affectedRegions: ['us-east-1'],
      slaBreached: false,
      dependentServices: [],
    },
    linkedDeployments: [],
  },
]

// ?? Kubernetes ???????????????????????????????????????????????
export const mockClusters: K8sCluster[] = [
  { id: 'eks-prod-us-east', name: 'eks-prod-us-east', provider: 'aws', region: 'us-east-1', version: '1.31', status: 'degraded', nodeCount: 42, podCount: 856, namespaceCount: 28, cpuCapacity: 336, cpuUsed: 218, memoryCapacity: 1344, memoryUsed: 892, storageCapacity: 20480, storageUsed: 14200, networkInMbps: 4820, networkOutMbps: 3210, createdAt: ts(60 * 24 * 180) },
  { id: 'eks-prod-eu-west', name: 'eks-prod-eu-west', provider: 'aws', region: 'eu-west-1', version: '1.31', status: 'healthy', nodeCount: 28, podCount: 512, namespaceCount: 24, cpuCapacity: 224, cpuUsed: 134, memoryCapacity: 896, memoryUsed: 512, storageCapacity: 12288, storageUsed: 6800, networkInMbps: 2410, networkOutMbps: 1890, createdAt: ts(60 * 24 * 120) },
  { id: 'aks-staging', name: 'aks-staging', provider: 'azure', region: 'eastus', version: '1.30', status: 'healthy', nodeCount: 12, podCount: 198, namespaceCount: 16, cpuCapacity: 96, cpuUsed: 42, memoryCapacity: 384, memoryUsed: 168, storageCapacity: 4096, storageUsed: 1200, networkInMbps: 620, networkOutMbps: 480, createdAt: ts(60 * 24 * 90) },
  { id: 'gke-dev', name: 'gke-dev', provider: 'gcp', region: 'us-central1', version: '1.31', status: 'healthy', nodeCount: 8, podCount: 124, namespaceCount: 12, cpuCapacity: 64, cpuUsed: 18, memoryCapacity: 256, memoryUsed: 64, storageCapacity: 2048, storageUsed: 412, networkInMbps: 210, networkOutMbps: 180, createdAt: ts(60 * 24 * 45) },
]

const INSTANCE_TYPES = ['m5.2xlarge', 'm5.4xlarge', 'c5.2xlarge', 'r5.2xlarge'] as const
type InstanceType = typeof INSTANCE_TYPES[number]
const OS_IMAGES = ['Amazon Linux 2 Kernel 5.10', 'Ubuntu 22.04.3 LTS', 'Bottlerocket OS 1.15.1']
const RUNTIMES = ['containerd://1.7.2', 'containerd://1.6.24']
const KERNEL_VERSIONS = ['5.10.198-187.748.amzn2.x86_64', '5.15.0-1041-aws', '6.1.57+']
const KUBELET_VERSIONS = ['v1.31.2', 'v1.31.1', 'v1.30.5', 'v1.31.0']

export const mockNodes: K8sNode[] = Array.from({ length: 12 }, (_, i) => {
  const isBad = i === 3
  const isHighLoad = i === 7
  const cpuCap = 8
  const memCap = 32
  const cpuUsed = isBad ? 7.8 : isHighLoad ? 7.1 : rand(2, 6)
  const memUsed = isBad ? 30.2 : isHighLoad ? 28.4 : rand(8, 24)
  const diskCap = pick([500, 1000, 2000])
  const diskUsed = isBad ? diskCap * 0.91 : rand(diskCap * 0.2, diskCap * 0.75)
  const bwCap = 10000 // 10 Gbps NIC
  const netIn = isBad ? rand(3800, 4200) : rand(200, 2000)
  const netOut = isBad ? rand(2900, 3400) : rand(150, 1800)

  return {
    name: `ip-10-0-${i < 3 ? 1 : randInt(2, 4)}-${randInt(10, 250)}`,
    status: isBad ? 'NotReady' : 'Ready',
    role: i < 3 ? 'control-plane' : 'worker',
    instanceType: pick([...INSTANCE_TYPES]) as InstanceType,
    region: 'us-east-1',
    zone: pick(['us-east-1a', 'us-east-1b', 'us-east-1c']),
    cpuCapacity: cpuCap,
    cpuUsed,
    memoryCapacity: memCap,
    memoryUsed: memUsed,
    podCount: isBad ? 0 : randInt(8, 28),
    podCapacity: 110,
    conditions: isBad
      ? [
          { type: 'Ready', status: 'False', lastTransitionTime: ts(60 * 8) },
          { type: 'MemoryPressure', status: 'True', lastTransitionTime: ts(60 * 8) },
          { type: 'DiskPressure', status: 'True', lastTransitionTime: ts(60 * 6) },
          { type: 'PIDPressure', status: 'False', lastTransitionTime: ts(60 * 24 * 30) },
        ]
      : isHighLoad
        ? [
            { type: 'Ready', status: 'True', lastTransitionTime: ts(60 * 24 * 14) },
            { type: 'MemoryPressure', status: 'False', lastTransitionTime: ts(60 * 24 * 14) },
            { type: 'DiskPressure', status: 'False', lastTransitionTime: ts(60 * 24 * 14) },
            { type: 'PIDPressure', status: 'False', lastTransitionTime: ts(60 * 24 * 14) },
          ]
        : [
            { type: 'Ready', status: 'True', lastTransitionTime: ts(60 * 24 * randInt(10, 90)) },
            { type: 'MemoryPressure', status: 'False', lastTransitionTime: ts(60 * 24 * randInt(10, 90)) },
            { type: 'DiskPressure', status: 'False', lastTransitionTime: ts(60 * 24 * randInt(10, 90)) },
            { type: 'PIDPressure', status: 'False', lastTransitionTime: ts(60 * 24 * randInt(10, 90)) },
          ],
    taints: isBad
      ? [
          { key: 'node.kubernetes.io/not-ready', effect: 'NoExecute' as const },
          { key: 'node.kubernetes.io/memory-pressure', effect: 'NoSchedule' as const },
        ]
      : i < 3
        ? [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' as const }]
        : [],
    kubeletVersion: pick(KUBELET_VERSIONS),
    disks: [
      {
        device: '/dev/nvme0n1',
        mountPath: '/',
        capacityGiB: diskCap,
        usedGiB: Math.round(diskUsed),
        iopsRead: isBad ? randInt(18000, 22000) : randInt(3000, 8000),
        iopsWrite: isBad ? randInt(14000, 18000) : randInt(1500, 5000),
        latencyMs: isBad ? rand(8, 15) : rand(0.2, 2),
      },
      ...(i % 3 === 0 ? [{
        device: '/dev/nvme1n1',
        mountPath: '/var/lib/kubelet',
        capacityGiB: 200,
        usedGiB: randInt(20, 120),
        iopsRead: randInt(2000, 6000),
        iopsWrite: randInt(1000, 4000),
        latencyMs: rand(0.1, 1.5),
      }] : []),
    ],
    networkInMbps: netIn,
    networkOutMbps: netOut,
    networkBandwidthMbps: bwCap,
    packetDropRate: isBad ? rand(0.02, 0.08) : rand(0, 0.002),
    osImage: pick(OS_IMAGES),
    kernelVersion: pick(KERNEL_VERSIONS),
    containerRuntime: pick(RUNTIMES),
    uptime: isBad ? randInt(2, 12) : randInt(200, 2000),
    createdAt: ts(60 * 24 * randInt(30, 180)),
    labels: { 'kubernetes.io/role': i < 3 ? 'control-plane' : 'worker' },
  }
})

export const mockPVs: import('@/types').PersistentVolume[] = [
  { name: 'pvc-payment-postgres-data', capacityGiB: 500, usedGiB: 412, storageClass: 'gp3-encrypted', accessMode: 'ReadWriteOnce', reclaimPolicy: 'Retain', status: 'Bound', claimRef: 'payments/postgres-data-0', volumeMode: 'Filesystem', provisioner: 'ebs.csi.aws.com', createdAt: ts(60 * 24 * 90) },
  { name: 'pvc-payment-postgres-wal', capacityGiB: 100, usedGiB: 87, storageClass: 'gp3-encrypted', accessMode: 'ReadWriteOnce', reclaimPolicy: 'Retain', status: 'Bound', claimRef: 'payments/postgres-wal-0', volumeMode: 'Filesystem', provisioner: 'ebs.csi.aws.com', createdAt: ts(60 * 24 * 90) },
  { name: 'pvc-kafka-broker-0', capacityGiB: 1000, usedGiB: 620, storageClass: 'gp3-high-iops', accessMode: 'ReadWriteOnce', reclaimPolicy: 'Retain', status: 'Bound', claimRef: 'platform/kafka-0', volumeMode: 'Filesystem', provisioner: 'ebs.csi.aws.com', createdAt: ts(60 * 24 * 120) },
  { name: 'pvc-kafka-broker-1', capacityGiB: 1000, usedGiB: 598, storageClass: 'gp3-high-iops', accessMode: 'ReadWriteOnce', reclaimPolicy: 'Retain', status: 'Bound', claimRef: 'platform/kafka-1', volumeMode: 'Filesystem', provisioner: 'ebs.csi.aws.com', createdAt: ts(60 * 24 * 120) },
  { name: 'pvc-prometheus-tsdb', capacityGiB: 2000, usedGiB: 1340, storageClass: 'gp3-encrypted', accessMode: 'ReadWriteOnce', reclaimPolicy: 'Retain', status: 'Bound', claimRef: 'monitoring/prometheus-0', volumeMode: 'Filesystem', provisioner: 'ebs.csi.aws.com', createdAt: ts(60 * 24 * 60) },
  { name: 'pvc-redis-master', capacityGiB: 50, usedGiB: 38, storageClass: 'io1-premium', accessMode: 'ReadWriteOnce', reclaimPolicy: 'Retain', status: 'Bound', claimRef: 'commerce/redis-master-0', volumeMode: 'Filesystem', provisioner: 'ebs.csi.aws.com', createdAt: ts(60 * 24 * 45) },
  { name: 'pvc-elasticsearch-data-0', capacityGiB: 3000, usedGiB: 2100, storageClass: 'gp3-encrypted', accessMode: 'ReadWriteOnce', reclaimPolicy: 'Retain', status: 'Bound', claimRef: 'monitoring/elasticsearch-0', volumeMode: 'Filesystem', provisioner: 'ebs.csi.aws.com', createdAt: ts(60 * 24 * 30) },
  { name: 'pvc-grafana-data', capacityGiB: 20, usedGiB: 14, storageClass: 'gp3-encrypted', accessMode: 'ReadWriteOnce', reclaimPolicy: 'Delete', status: 'Bound', claimRef: 'monitoring/grafana-0', volumeMode: 'Filesystem', provisioner: 'ebs.csi.aws.com', createdAt: ts(60 * 24 * 60) },
  { name: 'pvc-old-batch-data', capacityGiB: 200, usedGiB: 0, storageClass: 'sc1-cold', accessMode: 'ReadWriteOnce', reclaimPolicy: 'Retain', status: 'Released', volumeMode: 'Filesystem', provisioner: 'ebs.csi.aws.com', createdAt: ts(60 * 24 * 200) },
  { name: 'pvc-ml-training-tmp', capacityGiB: 500, usedGiB: 0, storageClass: 'gp3-encrypted', accessMode: 'ReadWriteMany', reclaimPolicy: 'Delete', status: 'Available', volumeMode: 'Filesystem', provisioner: 'efs.csi.aws.com', createdAt: ts(60 * 24 * 5) },
]

// ?? Databases ?????????????????????????????????????????????????
export const mockDatabases: DatabaseInstance[] = [
  {
    id: 'pg-payments-primary',
    name: 'postgres-payments',
    engine: 'postgres',
    version: '15.4',
    hosting: 'self-hosted',
    namespace: 'payments',
    status: 'critical',
    connectionPoolSize: 100,
    connectionsActive: 99,
    connectionsIdle: 0,
    connectionsWaiting: 47,
    qpsRead: 12400,
    qpsWrite: 3820,
    avgQueryMs: 4821,
    p99QueryMs: 18200,
    slowQueriesPerMin: 142,
    dataSizeGiB: 412,
    storageCapacityGiB: 500,
    replication: { role: 'primary', replicaCount: 2, lagSeconds: undefined },
    lastBackupAt: ts(60 * 14),
    backupStatus: 'ok',
    node: 'ip-10-0-3-187',
    uptime: 8,
    linkedIncidentId: 'inc-001',
  },
  {
    id: 'pg-payments-replica-1',
    name: 'postgres-payments-replica-1',
    engine: 'postgres',
    version: '15.4',
    hosting: 'self-hosted',
    namespace: 'payments',
    status: 'degraded',
    connectionPoolSize: 50,
    connectionsActive: 12,
    connectionsIdle: 28,
    connectionsWaiting: 0,
    qpsRead: 8200,
    qpsWrite: 0,
    avgQueryMs: 320,
    p99QueryMs: 1100,
    slowQueriesPerMin: 4,
    dataSizeGiB: 412,
    storageCapacityGiB: 500,
    replication: { role: 'replica', replicaCount: 0, lagSeconds: 184 },
    lastBackupAt: ts(60 * 14),
    backupStatus: 'ok',
    node: 'ip-10-0-2-94',
    uptime: 8,
    linkedIncidentId: 'inc-001',
  },
  {
    id: 'redis-commerce',
    name: 'redis-commerce',
    engine: 'redis',
    version: '7.2',
    hosting: 'self-hosted',
    namespace: 'commerce',
    status: 'healthy',
    connectionPoolSize: 500,
    connectionsActive: 142,
    connectionsIdle: 310,
    connectionsWaiting: 0,
    qpsRead: 48200,
    qpsWrite: 12400,
    avgQueryMs: 0.4,
    p99QueryMs: 2.1,
    slowQueriesPerMin: 0,
    dataSizeGiB: 38,
    storageCapacityGiB: 50,
    memoryUsedMiB: 12800,
    memoryCapacityMiB: 16384,
    replication: { role: 'primary', replicaCount: 1 },
    lastBackupAt: ts(60 * 6),
    backupStatus: 'ok',
    node: 'ip-10-0-2-211',
    uptime: 1420,
  },
  {
    id: 'pg-auth',
    name: 'postgres-auth',
    engine: 'postgres',
    version: '15.4',
    hosting: 'self-hosted',
    namespace: 'auth',
    status: 'healthy',
    connectionPoolSize: 50,
    connectionsActive: 18,
    connectionsIdle: 28,
    connectionsWaiting: 0,
    qpsRead: 4200,
    qpsWrite: 820,
    avgQueryMs: 12,
    p99QueryMs: 48,
    slowQueriesPerMin: 0,
    dataSizeGiB: 24,
    storageCapacityGiB: 100,
    replication: { role: 'primary', replicaCount: 1, lagSeconds: undefined },
    lastBackupAt: ts(60 * 8),
    backupStatus: 'ok',
    node: 'ip-10-0-2-188',
    uptime: 2840,
  },
  {
    id: 'kafka-platform',
    name: 'kafka-platform',
    engine: 'kafka',
    version: '3.6',
    hosting: 'self-hosted',
    namespace: 'platform',
    status: 'healthy',
    connectionPoolSize: 2000,
    connectionsActive: 840,
    connectionsIdle: 1020,
    connectionsWaiting: 0,
    qpsRead: 182000,
    qpsWrite: 94000,
    avgQueryMs: 1.2,
    p99QueryMs: 8.4,
    slowQueriesPerMin: 0,
    dataSizeGiB: 620,
    storageCapacityGiB: 1000,
    replication: { role: 'primary', replicaCount: 2 },
    lastBackupAt: ts(60 * 24),
    backupStatus: 'ok',
    node: 'ip-10-0-3-102',
    uptime: 3200,
  },
  {
    id: 'elasticsearch-monitoring',
    name: 'elasticsearch-monitoring',
    engine: 'elasticsearch',
    version: '8.11',
    hosting: 'self-hosted',
    namespace: 'monitoring',
    status: 'degraded',
    connectionPoolSize: 200,
    connectionsActive: 88,
    connectionsIdle: 64,
    connectionsWaiting: 12,
    qpsRead: 6400,
    qpsWrite: 18200,
    avgQueryMs: 84,
    p99QueryMs: 420,
    slowQueriesPerMin: 8,
    dataSizeGiB: 2100,
    storageCapacityGiB: 3000,
    memoryUsedMiB: 28672,
    memoryCapacityMiB: 32768,
    replication: { role: 'primary', replicaCount: 2 },
    lastBackupAt: ts(60 * 48),
    backupStatus: 'failed',
    node: 'ip-10-0-4-77',
    uptime: 420,
  },
  {
    id: 'pg-orders',
    name: 'postgres-orders',
    engine: 'postgres',
    version: '14.10',
    hosting: 'self-hosted',
    namespace: 'commerce',
    status: 'healthy',
    connectionPoolSize: 80,
    connectionsActive: 24,
    connectionsIdle: 48,
    connectionsWaiting: 0,
    qpsRead: 8400,
    qpsWrite: 2100,
    avgQueryMs: 18,
    p99QueryMs: 72,
    slowQueriesPerMin: 1,
    dataSizeGiB: 184,
    storageCapacityGiB: 500,
    replication: { role: 'primary', replicaCount: 1, lagSeconds: undefined },
    lastBackupAt: ts(60 * 10),
    backupStatus: 'ok',
    node: 'ip-10-0-2-144',
    uptime: 1840,
  },
]

const services = ['payment-service', 'checkout-api', 'auth-service', 'recommendation-engine', 'order-service', 'notification-service', 'fraud-detection', 'billing-service', 'user-service', 'inventory-service', 'search-service', 'api-gateway']
const namespaces = ['payments', 'commerce', 'auth', 'ml', 'notifications', 'databases', 'platform', 'monitoring']

export const mockPods: any[] = services.flatMap(svc =>
  Array.from({ length: randInt(2, 5) }, (_, i) => ({
    name: `${svc}-${id()}-${id().slice(0,5)}`,
    namespace: pick(namespaces),
    status: svc === 'payment-service' && i === 0 ? 'CrashLoopBackOff' : svc === 'payment-service' && i === 1 ? 'OOMKilled' : 'Running',
    node: `ip-10-0-${randInt(0,4)}-${randInt(10,250)}`,
    containers: randInt(1, 3),
    restarts: svc === 'payment-service' ? randInt(4, 18) : randInt(0, 2),
    age: `${randInt(1, 24)}h`,
    cpuUsage: svc === 'payment-service' ? randInt(900, 1100) : randInt(50, 600),
    memoryUsage: svc === 'payment-service' ? randInt(900, 1024) : randInt(64, 512),
    image: `registry.VynOps.io/${svc}:v${randInt(1,3)}.${randInt(0,20)}.${randInt(0,9)}`,
    labels: { app: svc, env: 'production' },
    ownerKind: 'Deployment',
    ownerName: svc,
    ip: `10.${randInt(0,255)}.${randInt(0,255)}.${randInt(1,254)}`,
    readyContainers: svc === 'payment-service' && i < 2 ? 0 : randInt(1, 3),
  }))
)

export const mockDeployments: any[] = services.map(svc => ({
  name: svc,
  namespace: pick(namespaces),
  replicas: randInt(2, 8),
  readyReplicas: svc === 'payment-service' ? 2 : randInt(2, 8),
  updatedReplicas: randInt(2, 8),
  image: `registry.VynOps.io/${svc}:v2.${randInt(10,15)}.${randInt(0,9)}`,
  createdAt: ts(60 * 24 * randInt(30, 180)),
  lastDeployedAt: svc === 'payment-service' ? ts(33) : ts(randInt(60, 2880)),
  strategy: 'RollingUpdate',
  status: svc === 'payment-service' ? 'degraded' : 'healthy',
  annotations: {},
  labels: { app: svc },
}))

// ?? Metrics ??????????????????????????????????????????????????
export const mockClusterMetrics: ClusterMetrics = {
  cpuUsage: 64.8,
  memoryUsage: 66.4,
  networkInBytes: 125_000_000,
  networkOutBytes: 89_000_000,
  diskReadBytes: 45_000_000,
  diskWriteBytes: 32_000_000,
  podRestartRate: 2.3,
  errorRate: 8.4,
  p50Latency: 420,
  p99Latency: 2340,
  requestRate: 18_432,
  history: {
    cpu: generateTimeSeries(64, 8, 60),
    memory: generateTimeSeries(66, 4, 60),
    requests: generateTimeSeries(18000, 2000, 60),
    errors: generateTimeSeries(8, 3, 60),
    latency: generateTimeSeries(2200, 300, 60),
  },
}

export const mockServiceMetrics: ServiceMetric[] = services.map(svc => ({
  name: svc,
  namespace: pick(namespaces),
  requestRate: svc === 'payment-service' ? rand(200, 800) : rand(500, 8000),
  errorRate: svc === 'payment-service' ? rand(6, 12) : svc === 'checkout-api' ? rand(3, 9) : rand(0.01, 0.5),
  p50Latency: svc === 'payment-service' ? rand(800, 1500) : rand(20, 120),
  p99Latency: svc === 'payment-service' ? rand(3000, 6000) : rand(80, 500),
  availability: svc === 'payment-service' ? rand(88, 94) : rand(99.5, 99.99),
  status: svc === 'payment-service' ? 'critical' : svc === 'checkout-api' ? 'degraded' : 'healthy',
  dependsOn: svc === 'checkout-api' ? ['payment-service', 'order-service'] : [],
  history: generateTimeSeries(svc === 'payment-service' ? 5 : 0.1, svc === 'payment-service' ? 3 : 0.05, 60),
}))

// ?? Topology ?????????????????????????????????????????????????
export const mockTopology: TopologyGraph = {
  nodes: [
    { id: 'api-gateway', label: 'API Gateway', type: 'gateway', status: 'healthy', metadata: { requestRate: 18432, errorRate: 0.2, latency: 12 } },
    { id: 'checkout-api', label: 'Checkout API', type: 'service', status: 'degraded', namespace: 'commerce', metadata: { requestRate: 4200, errorRate: 8.3, latency: 450 } },
    { id: 'payment-service', label: 'Payment Service', type: 'service', status: 'critical', namespace: 'payments', metadata: { requestRate: 820, errorRate: 11.2, latency: 4200 } },
    { id: 'fraud-detection', label: 'Fraud Detection', type: 'service', status: 'degraded', namespace: 'payments', metadata: { requestRate: 820, errorRate: 4.1, latency: 280 } },
    { id: 'order-service', label: 'Order Service', type: 'service', status: 'healthy', namespace: 'commerce', metadata: { requestRate: 3800, errorRate: 0.1, latency: 45 } },
    { id: 'inventory-service', label: 'Inventory', type: 'service', status: 'healthy', namespace: 'commerce', metadata: { requestRate: 2100, errorRate: 0.05, latency: 32 } },
    { id: 'user-service', label: 'User Service', type: 'service', status: 'healthy', namespace: 'auth', metadata: { requestRate: 6200, errorRate: 0.02, latency: 18 } },
    { id: 'recommendation-engine', label: 'Recommendation', type: 'service', status: 'degraded', namespace: 'ml', metadata: { requestRate: 1200, errorRate: 0.8, latency: 2400 } },
    { id: 'notification-service', label: 'Notifications', type: 'service', status: 'healthy', namespace: 'notifications', metadata: { requestRate: 890, errorRate: 0.1, latency: 28 } },
    { id: 'postgres-payment', label: 'Postgres (Payment)', type: 'database', status: 'critical', namespace: 'databases', metadata: { requestRate: 2400, errorRate: 12, latency: 3800 } },
    { id: 'postgres-orders', label: 'Postgres (Orders)', type: 'database', status: 'healthy', namespace: 'databases', metadata: { requestRate: 1800, errorRate: 0.05, latency: 8 } },
    { id: 'redis-cache', label: 'Redis Cache', type: 'database', status: 'healthy', namespace: 'databases', metadata: { requestRate: 12000, errorRate: 0.01, latency: 2 } },
    { id: 'kafka-events', label: 'Kafka', type: 'queue', status: 'healthy', namespace: 'platform', metadata: { requestRate: 8400, errorRate: 0.2, latency: 5 } },
    { id: 'billing-service', label: 'Billing Service', type: 'service', status: 'degraded', namespace: 'payments', metadata: { requestRate: 420, errorRate: 5.2, latency: 980 } },
    { id: 'external-payments', label: 'Stripe', type: 'external', status: 'healthy', metadata: { latency: 220 } },
  ],
  edges: [
    { id: 'e1', source: 'api-gateway', target: 'checkout-api', requestRate: 4200, errorRate: 0.1, latency: 12, protocol: 'http' },
    { id: 'e2', source: 'api-gateway', target: 'user-service', requestRate: 6200, errorRate: 0.02, latency: 8, protocol: 'http' },
    { id: 'e3', source: 'api-gateway', target: 'order-service', requestRate: 3800, errorRate: 0.1, latency: 10, protocol: 'http' },
    { id: 'e4', source: 'checkout-api', target: 'payment-service', requestRate: 1200, errorRate: 11.2, latency: 4200, protocol: 'http' },
    { id: 'e5', source: 'checkout-api', target: 'order-service', requestRate: 3800, errorRate: 0.1, latency: 22, protocol: 'grpc' },
    { id: 'e6', source: 'checkout-api', target: 'recommendation-engine', requestRate: 1200, errorRate: 0.8, latency: 2400, protocol: 'http' },
    { id: 'e7', source: 'payment-service', target: 'postgres-payment', requestRate: 2400, errorRate: 12, latency: 3800, protocol: 'tcp' },
    { id: 'e8', source: 'payment-service', target: 'fraud-detection', requestRate: 820, errorRate: 4.1, latency: 280, protocol: 'grpc' },
    { id: 'e9', source: 'payment-service', target: 'external-payments', requestRate: 420, errorRate: 3.2, latency: 220, protocol: 'http' },
    { id: 'e10', source: 'order-service', target: 'postgres-orders', requestRate: 1800, errorRate: 0.05, latency: 8, protocol: 'tcp' },
    { id: 'e11', source: 'order-service', target: 'kafka-events', requestRate: 1200, errorRate: 0.1, latency: 5, protocol: 'amqp' },
    { id: 'e12', source: 'user-service', target: 'redis-cache', requestRate: 8000, errorRate: 0.01, latency: 2, protocol: 'redis' },
    { id: 'e13', source: 'billing-service', target: 'postgres-payment', requestRate: 480, errorRate: 8.4, latency: 2800, protocol: 'tcp' },
    { id: 'e14', source: 'billing-service', target: 'kafka-events', requestRate: 200, errorRate: 0.2, latency: 5, protocol: 'amqp' },
    { id: 'e15', source: 'notification-service', target: 'kafka-events', requestRate: 890, errorRate: 0.1, latency: 4, protocol: 'amqp' },
  ],
  updatedAt: ts(0),
}

// ?? Security ?????????????????????????????????????????????????
export const mockThreats: SecurityThreat[] = [
  { id: id(), title: 'Privilege escalation attempt detected', category: 'privilege', severity: 'critical', description: 'Container in payments namespace attempted to access host PID namespace', affectedResource: 'payment-worker', namespace: 'payments', detectedAt: ts(25), mitigated: false, remediation: 'Review RBAC policies. Add PodSecurityPolicy restrictions.' },
  { id: id(), title: 'Unauthorized API server access', category: 'network', severity: 'high', description: 'Repeated failed authentication attempts to K8s API server from 185.220.101.x (Tor exit node)', affectedResource: 'kube-apiserver', detectedAt: ts(45), mitigated: true, remediation: 'Block IP range at network policy level. Review audit logs.' },
  { id: id(), title: 'Secret exposed in environment variable', category: 'secret', severity: 'high', description: 'AWS_SECRET_ACCESS_KEY found in plaintext in pod environment variables', affectedResource: 'billing-service', namespace: 'payments', detectedAt: ts(120), mitigated: false, remediation: 'Migrate secrets to Kubernetes Secrets or Vault. Remove from env vars immediately.' },
  { id: id(), title: 'Container running as root', category: 'container', severity: 'medium', description: '4 containers are running as root user (UID 0)', affectedResource: 'multiple', detectedAt: ts(200), mitigated: false, remediation: 'Add securityContext.runAsNonRoot: true to pod specs.' },
  { id: id(), title: 'Outdated base image with CVE-2024-1234', category: 'runtime', severity: 'medium', description: 'recommendation-engine using node:18-alpine with known CVEs', affectedResource: 'recommendation-engine', namespace: 'ml', detectedAt: ts(1440), mitigated: false, cve: 'CVE-2024-1234', remediation: 'Update base image to node:20-alpine or later.' },
]

// ?? Cost / FinOps ?????????????????????????????????????????????
export const mockCostSummary: CloudCostSummary = {
  totalMonthly: 48_420,
  projected: 52_800,
  savings: 8_640,
  wastedResources: 6_200,
  byService: [
    { name: 'eks-prod-us-east', cost: 22_400, trend: 8.2 },
    { name: 'RDS (payment-db)', cost: 8_800, trend: 14.1 },
    { name: 'eks-prod-eu-west', cost: 11_200, trend: -2.3 },
    { name: 'S3 + CloudFront', cost: 3_400, trend: 1.8 },
    { name: 'Data Transfer', cost: 2_620, trend: 5.4 },
  ],
  byProvider: [
    { provider: 'aws', cost: 38_400 },
    { provider: 'azure', cost: 7_200 },
    { provider: 'gcp', cost: 2_820 },
  ],
  history: generateTimeSeries(1600, 200, 30, 60 * 24),
  optimizationSuggestions: [
    { id: id(), title: 'Rightsize over-provisioned RDS instances', savings: 3_200, effort: 'low' },
    { id: id(), title: 'Move dev workloads to spot instances', savings: 2_800, effort: 'low' },
    { id: id(), title: 'Consolidate idle staging clusters', savings: 1_640, effort: 'medium' },
    { id: id(), title: 'Enable S3 Intelligent-Tiering', savings: 420, effort: 'low' },
    { id: id(), title: 'Reserve 1yr for production RDS', savings: 580, effort: 'medium' },
  ],
}

// ?? AI Insights ???????????????????????????????????????????????
export const mockAIInsights: AIInsight[] = [
  { id: id(), type: 'rca', title: 'Root cause identified: memory leak in v2.13.1', description: 'AI traced the payment cascade failure to a memory leak in the DB connection handler introduced in v2.13.1. Confidence: 94%. Recommended action: rollback immediately.', confidence: 0.94, severity: 'critical', affectedServices: ['payment-service', 'postgres-payment'], ts: ts(11), dismissed: false },
  { id: id(), type: 'prediction', title: 'Memory saturation predicted on node ip-10-0-1-42 in ~2h', description: 'Based on current memory growth trend, node will reach 95% utilization in approximately 2 hours. Proactive scaling recommended.', confidence: 0.81, severity: 'high', affectedServices: ['payment-service', 'auth-service'], ts: ts(5), dismissed: false },
  { id: id(), type: 'anomaly', title: 'Unusual traffic pattern detected on api-gateway', description: 'Traffic from EU region shows 340% spike vs 7-day baseline. Could indicate bot traffic or regional incident.', confidence: 0.76, severity: 'medium', affectedServices: ['api-gateway'], ts: ts(18), dismissed: false },
  { id: id(), type: 'recommendation', title: 'Add HPA for payment-service', description: 'payment-service lacks Horizontal Pod Autoscaler. Adding HPA with CPU target 70% would have prevented this incident.', confidence: 0.88, severity: 'medium', affectedServices: ['payment-service'], ts: ts(8), dismissed: false },
  { id: id(), type: 'cost', title: 'Idle RDS instances wasting $3,200/month', description: 'AI detected 4 RDS instances with <2% average CPU utilization over 30 days. Rightsizing or termination recommended.', confidence: 0.95, severity: 'low', affectedServices: [], ts: ts(120), dismissed: false },
]

// ?? K8s Events ???????????????????????????????????????????????
export const mockK8sEvents: K8sEvent[] = [
  { id: 'evt-001', type: 'Warning', reason: 'OOMKilled', message: 'Container payment-processor was OOM killed. Memory limit: 2Gi, Usage at kill: 2.1Gi', involvedObject: { kind: 'Pod', name: 'payment-worker-6d8f9b-xk2p7', namespace: 'payments' }, count: 14, firstTime: ts(120), lastTime: ts(4), linkedIncidentId: 'inc-001' },
  { id: 'evt-002', type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container payment-processor in pod payment-worker-6d8f9b-xk2p7', involvedObject: { kind: 'Pod', name: 'payment-worker-6d8f9b-xk2p7', namespace: 'payments' }, count: 38, firstTime: ts(110), lastTime: ts(2), linkedIncidentId: 'inc-001' },
  { id: 'evt-003', type: 'Warning', reason: 'FailedScheduling', message: 'No nodes are available that match all of the following predicates: Insufficient memory (3 nodes), node(s) had taints that the pod did not tolerate (1 node)', involvedObject: { kind: 'Pod', name: 'payment-worker-6d8f9b-pending', namespace: 'payments' }, count: 5, firstTime: ts(45), lastTime: ts(8), linkedIncidentId: 'inc-001' },
  { id: 'evt-004', type: 'Warning', reason: 'NodeNotReady', message: 'Node ip-10-0-1-42 is not ready: kubelet stopped posting node status (memory pressure)', involvedObject: { kind: 'Node', name: 'ip-10-0-1-42', namespace: '' }, count: 1, firstTime: ts(480), lastTime: ts(480) },
  { id: 'evt-005', type: 'Warning', reason: 'Evicted', message: 'The node was low on resource: memory. Threshold quantity: 100Mi, available: 72Mi. Container payment-processor was using 1948Mi above its request', involvedObject: { kind: 'Pod', name: 'payment-worker-5f6b4c-evicted', namespace: 'payments' }, count: 1, firstTime: ts(490), lastTime: ts(490), linkedIncidentId: 'inc-001' },
  { id: 'evt-006', type: 'Warning', reason: 'FailedMount', message: 'MountVolume.SetUp failed for volume "pvc-payment-postgres-wal": Unable to attach EBS volume, attachment quota exceeded', involvedObject: { kind: 'Pod', name: 'postgres-payments-0', namespace: 'databases' }, count: 3, firstTime: ts(30), lastTime: ts(12), linkedIncidentId: 'inc-001' },
  { id: 'evt-007', type: 'Warning', reason: 'Unhealthy', message: 'Readiness probe failed: connection refused - postgres-payments liveness check timed out after 5s', involvedObject: { kind: 'Pod', name: 'postgres-payments-0', namespace: 'databases' }, count: 22, firstTime: ts(90), lastTime: ts(1), linkedIncidentId: 'inc-001' },
  { id: 'evt-008', type: 'Warning', reason: 'ScalingReplicaSet', message: 'Scaled down replica set checkout-api-7c9f5b698 to 2 from 4 due to resource pressure', involvedObject: { kind: 'Deployment', name: 'checkout-api', namespace: 'commerce' }, count: 1, firstTime: ts(35), lastTime: ts(35) },
  { id: 'evt-009', type: 'Warning', reason: 'DNSConfigForming', message: 'Search Line limits exceeded, some search paths have been omitted. Max 6 search paths allowed', involvedObject: { kind: 'Pod', name: 'recommendation-engine-abc12', namespace: 'ml' }, count: 8, firstTime: ts(200), lastTime: ts(60) },
  { id: 'evt-010', type: 'Warning', reason: 'NetworkPluginNotReady', message: 'Container runtime network not ready: NetworkReady=false reason:NetworkPlugin is not ready for graceful node shutdown', involvedObject: { kind: 'Node', name: 'ip-10-0-2-88', namespace: '' }, count: 1, firstTime: ts(15), lastTime: ts(15) },
  { id: 'evt-011', type: 'Warning', reason: 'FailedCreate', message: 'Error creating: pods "fraud-detection-" is forbidden: exceeded quota: compute-quota, requested: limits.memory=4Gi, used: limits.memory=78Gi, limited: limits.memory=80Gi', involvedObject: { kind: 'ReplicaSet', name: 'fraud-detection-7f8b4d', namespace: 'payments' }, count: 2, firstTime: ts(20), lastTime: ts(18) },
  { id: 'evt-012', type: 'Warning', reason: 'ProvisioningFailed', message: 'Failed to provision volume with StorageClass "gp3-high-iops": RPC error: could not create volume in EC2: VolumeInUse: vol-0a1b2c3d4e already attached', involvedObject: { kind: 'PersistentVolumeClaim', name: 'kafka-broker-2', namespace: 'platform' }, count: 4, firstTime: ts(55), lastTime: ts(22) },
  { id: 'evt-013', type: 'Normal', reason: 'Pulled', message: 'Successfully pulled image "payment-service:v2.14.0" in 8.2s (8.2s including waiting)', involvedObject: { kind: 'Pod', name: 'payment-service-new-xxxx', namespace: 'payments' }, count: 1, firstTime: ts(180), lastTime: ts(180) },
  { id: 'evt-014', type: 'Warning', reason: 'SandboxChanged', message: 'Pod sandbox changed, it will be killed and re-created', involvedObject: { kind: 'Pod', name: 'auth-service-5d7c9b-rqzl4', namespace: 'auth' }, count: 3, firstTime: ts(300), lastTime: ts(140) },
  { id: 'evt-015', type: 'Warning', reason: 'TopologyAffinityError', message: 'Resources requested by pod do not satisfy topology constraints: CPU core allocation failed across NUMA nodes', involvedObject: { kind: 'Pod', name: 'elasticsearch-monitoring-0', namespace: 'monitoring' }, count: 1, firstTime: ts(420), lastTime: ts(420) },
]

// ?? Storage Classes ???????????????????????????????????????????
export const mockStorageClasses: StorageClass[] = [
  { name: 'gp3', provisioner: 'ebs.csi.aws.com', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: true, isDefault: true, parameters: { type: 'gp3', iops: '3000', throughput: '125' } },
  { name: 'gp3-encrypted', provisioner: 'ebs.csi.aws.com', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: true, isDefault: false, parameters: { type: 'gp3', encrypted: 'true', iops: '3000' } },
  { name: 'gp3-high-iops', provisioner: 'ebs.csi.aws.com', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: false, isDefault: false, parameters: { type: 'io2', iops: '32000', encrypted: 'true' } },
  { name: 'io1-premium', provisioner: 'ebs.csi.aws.com', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: false, isDefault: false, parameters: { type: 'io1', iops: '64000' } },
  { name: 'efs-sc', provisioner: 'efs.csi.aws.com', reclaimPolicy: 'Retain', volumeBindingMode: 'Immediate', allowVolumeExpansion: false, isDefault: false, parameters: { provisioningMode: 'efs-ap', fileSystemId: 'fs-0a1b2c3d' } },
  { name: 'standard', provisioner: 'kubernetes.io/no-provisioner', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: false, isDefault: false },
]

// ?? Resource Quotas ???????????????????????????????????????????
export const mockResourceQuotas: ResourceQuota[] = [
  { name: 'default', namespace: 'payments',   cpuRequestUsed: 28.4, cpuRequestLimit: 40,  cpuLimitUsed: 56.2, cpuLimitLimit: 80,  memRequestUsed: 54,  memRequestLimit: 80,  memLimitUsed: 108,  memLimitLimit: 160, podUsed: 42, podLimit: 50,  pvcUsed: 8,  pvcLimit: 10 },
  { name: 'default', namespace: 'commerce',   cpuRequestUsed: 14.2, cpuRequestLimit: 24,  cpuLimitUsed: 26.8, cpuLimitLimit: 48,  memRequestUsed: 28,  memRequestLimit: 48,  memLimitUsed: 52,   memLimitLimit: 96,  podUsed: 28, podLimit: 40,  pvcUsed: 4,  pvcLimit: 8  },
  { name: 'default', namespace: 'monitoring', cpuRequestUsed: 18.6, cpuRequestLimit: 20,  cpuLimitUsed: 36.4, cpuLimitLimit: 40,  memRequestUsed: 44,  memRequestLimit: 48,  memLimitUsed: 88,   memLimitLimit: 96,  podUsed: 18, podLimit: 25,  pvcUsed: 6,  pvcLimit: 8  },
  { name: 'default', namespace: 'ml',         cpuRequestUsed: 7.2,  cpuRequestLimit: 32,  cpuLimitUsed: 12.4, cpuLimitLimit: 64,  memRequestUsed: 36,  memRequestLimit: 128, memLimitUsed: 64,   memLimitLimit: 256, podUsed: 8,  podLimit: 20,  pvcUsed: 2,  pvcLimit: 5  },
  { name: 'default', namespace: 'auth',       cpuRequestUsed: 4.8,  cpuRequestLimit: 8,   cpuLimitUsed: 8.2,  cpuLimitLimit: 16,  memRequestUsed: 12,  memRequestLimit: 16,  memLimitUsed: 20,   memLimitLimit: 32,  podUsed: 14, podLimit: 20,  pvcUsed: 1,  pvcLimit: 4  },
  { name: 'default', namespace: 'platform',   cpuRequestUsed: 12.4, cpuRequestLimit: 16,  cpuLimitUsed: 22.8, cpuLimitLimit: 32,  memRequestUsed: 32,  memRequestLimit: 48,  memLimitUsed: 58,   memLimitLimit: 96,  podUsed: 22, podLimit: 30,  pvcUsed: 5,  pvcLimit: 6  },
  { name: 'default', namespace: 'databases',  cpuRequestUsed: 9.6,  cpuRequestLimit: 12,  cpuLimitUsed: 18.4, cpuLimitLimit: 24,  memRequestUsed: 56,  memRequestLimit: 64,  memLimitUsed: 112,  memLimitLimit: 128, podUsed: 12, podLimit: 15,  pvcUsed: 10, pvcLimit: 12 },
  { name: 'default', namespace: 'staging',    cpuRequestUsed: 2.1,  cpuRequestLimit: 16,  cpuLimitUsed: 3.8,  cpuLimitLimit: 32,  memRequestUsed: 8,   memRequestLimit: 32,  memLimitUsed: 14,   memLimitLimit: 64,  podUsed: 6,  podLimit: 30 },
]
