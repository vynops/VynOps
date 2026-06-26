# VynOps AI â€" Implemented Features (v0.7.0)

> **Stack:** Next.js 15 Â· React 19 Â· TypeScript Â· Tailwind CSS Â· Zustand Â· Framer Motion Â· Recharts Â· date-fns Â· NextAuth v5 Â· Vercel AI SDK v4 Â· Groq (llama-4-scout)  
> **Status:** Full-stack production backend: real K8s API, Prometheus metrics, Groq AI, incident management, SLA auto-escalation (L3), auto-runbook trigger (L4), AI remediation plans (L5), autonomous healing loop, runtime config, Slack + PagerDuty + SMTP alerts, one-click CIS security fixes, topology incident intelligence

---

## 1. App Shell & Navigation

### Persistent Left Navigation Rail
- 15-section navigation (Home, Observability, Infrastructure, Kubernetes, Cloud, **Deployments**, Incidents, Topology, AI Copilot, Automation, Security, Analytics, FinOps, Business KPIs, Settings)
- Animated collapse/expand (56px â†” 220px) with Framer Motion
- Active route highlighting with cyan accent
- Live badge counters on Incidents (open count) and Observability (firing alert count)
- AI Copilot section highlighted with gradient treatment
- Brand logo with "VynOps AI Platform" label

### Top Header Bar
- Global search button (opens Command Palette)
- Real-time toggle with animated pulsing green dot indicator
- Time range selector: Last 5m / 15m / 30m / 1h / 3h / 6h / 12h / 24h / 7d
- Environment switcher: Production / Staging / Development / DR with color-coded dots
- Notification bell with firing alert count badge, dropdown showing alert list
- **Authenticated user menu** â€” shows name, email, role badge (color-coded by permission level)
- **Sign out** button via NextAuth `signOut()`

### Right AI Intelligence Sidebar
- Persistent slide-out panel (280px wide, animated open/close)
- Active incident banner with RCA summary at top
- AI insights feed with confidence percentage bars
- Suggested remediation actions list
- Blast radius summary (affected services, users, revenue)
- Toggle button integrated into header

### Command Palette (Cmd+K)
- Full-screen overlay triggered by Cmd+K or header button
- 15 navigation commands across all sections
- Incident quick-jump shortcuts (INC-001, INC-002, INC-003)
- AI query shortcuts
- Keyboard: Enter to navigate, Escape to close
- Built with `cmdk` library

---

## 2. Executive Dashboard (`/dashboard`)

- **Global Health Score** KPI card â€” animated score with status color (healthy/degraded/critical), trend indicator
- **6 KPI Cards**: Health Score, Active Incidents, Firing Alerts, Uptime %, P99 Latency, Monthly Cost
- **Critical Incident Banner** â€” red animated banner when a critical incident is active, with direct Investigate CTA
- **Service Health Table** â€” all 12 services with: status badge, sparkline chart, req/s, error %, p50/p99 latency, availability %
- **Cluster Summary Cards** â€” 4 clusters with CPU/memory utilization bars, provider/region labels
- **4 Metric Sparkline Cards** â€” CPU, Memory, Error Rate, Request Rate with mini area charts
- **Active Incidents List** â€” using IncidentRow component with severity bar, state badge, owner, affected users, time
- **AI Insights Feed** â€” 5 AI-generated insights with type icons, confidence scores, severity, dismiss action
- Staggered fade-up entry animations throughout

---

## 3. Observability (`/dashboard/observability`)

### Metrics Tab
- 4 real-time metric cards: CPU, Memory, Request Rate, Error Rate with full MetricChart
- Service Metrics Table: all 12 services Ã— 7 columns (status, req/s, error%, p50, p99, availability)
- Search/filter by service name

### Logs Tab
- **Log volume bar chart** â€” 24 five-minute buckets across 2 hours, stacked bars (ERROR/WARN/INFO), error spike window highlighted
- **Level filter pills** with live counts: All, ERROR, WARN, INFO, DEBUG
- **Full-text search** by pod name, namespace, or message
- Log entries: timestamp (monospace) Â· level pill (color-coded) Â· pod Â· namespace Â· message â€” all sourced from 36 realistic mock log lines
- **Expandable rows** â€” click to reveal full message + tag metadata (namespace, pod, level, trace_id)
- Row background tinted red for ERROR, amber for WARN
- Live indicator dot in header

### Traces Tab
- **Trace list panel** (left) â€” 5 clickable traces with status dot, root operation, service, span count, total latency
- **Span waterfall view** (right) â€” selected trace renders all spans as offset + proportional duration bars:
  - Service name column (color-coded per service) + operation column
  - Duration bar positioned by `startOffset / totalDuration`, width = `duration / totalDuration`
  - Bar colors: ok=brand-500, slow=warning, error=danger
  - Depth-indented service labels (16px per level) showing parent â†’ child relationships
- **Error spans detail panel** below waterfall â€” lists only failing spans with service, operation, and error tag value
- Trace-001 shows full checkout â†’ payment-service â†’ postgres cascade failure (12 spans, 4823ms)

### Events Tab
- Alert feed with severity dot, name, summary, timestamp
- Sourced from live alert store

---

## 4. Infrastructure (`/dashboard/infrastructure`)

### Cluster Summary Cards (4 cards)
- CPU bar: used / capacity in cores (raw + %)
- Memory bar: used / capacity in GiB (raw + %)
- **Storage bar**: used / capacity in TiB (new)
- Node count, pod count, namespace count stats strip
- K8s version badge (new)
- **Network ingress/egress** in Mbps per cluster (new)
- Color thresholds: ≥90% danger, ≥75% warning

### Cluster-Wide KPI Strip (new)
- Total CPU across all clusters (cores used / total)
- Total Memory (GiB used / total)
- Total Disk (GiB used / total, with utilization bar)
- Total Network (aggregate ingress + egress Mbps)

### Tabs: Nodes · Storage · Network (new tab layout)

#### Nodes Tab
- Expandable node rows — click to reveal full detail panel
- Columns: expand toggle, node name (monospace), status, role, **instance type** (new), CPU (% + raw cores), Memory (% + raw GiB), **Disk** (% + raw GiB, new), Pods (used/capacity), **Conditions** (new)
- **Node Conditions badges** per row: Ready, MemoryPressure, DiskPressure, PIDPressure — green when normal, red when triggered
- Critical node rows highlighted in red (NotReady, CPU ≥90%, memory ≥90%, disk ≥90%)
- **Expanded detail panel** (3 columns, new):
  - Disk: per-device (device path, mount point, used/capacity GiB bar, read/write IOPS, latency ms)
  - Network: bandwidth utilization bar, in/out Mbps, capacity, packet drop rate
  - System: instance type, OS image, kernel version, container runtime, uptime, pod density

#### Storage Tab (new)
- 4 KPI cards: total PVs, bound count, released/available count, total capacity GiB
- **Node Disk Utilization** table: per-node, per-device — device path, mount, usage bar (%, GiB), IOPS read/write, disk latency
- **Persistent Volumes table**: name, status badge (Bound/Available/Released/Failed), capacity, used GiB (%), storage class, access mode, provisioner, claim reference
- Filter tabs: All / Bound / Released / Available
- Rows tinted red when usage ≥90%, amber ≥80%
- 10 mock PVs across postgres, kafka, prometheus, redis, elasticsearch, grafana

#### Network Tab (new)
- 4 KPI cards: total ingress Mbps, total egress Mbps, nodes with packet drops (>0.5%), saturated NICs (>70% bandwidth)
- **Per-Node Network table**: node, role, ingress Mbps (↓), egress Mbps (↑), NIC capacity, bandwidth utilization bar + %, packet drop rate (highlighted amber if >0.5%)
- **Cluster Network Summary table**: per-cluster ingress/egress

#### Databases Tab (new)
- **4 KPI cards**: Critical/Degraded count, Connection Pool Exhausted count, Total Slow Queries/min, Backup Failures
- **Per-database cards** (7 databases: 3× postgres, redis, kafka, elasticsearch, 1 more postgres):
  - Engine + version badge (color-coded: postgres=blue, redis=red, kafka=orange, elasticsearch=yellow)
  - Namespace badge, replication role badge (primary · NR, replica), replication lag warning badge
  - **⚡ Incident badge** — pulsing red when database is linked to an active incident (postgres-payments linked to INC-001)
  - Hosting type, uptime, node name
  - **Connection Pool panel**: active/max utilization bar (red ≥90%, amber ≥70%), idle count, waiting connections (red if >0)
  - **Query Performance panel**: QPS read/write, avg latency (color-coded: >1s red, >100ms amber, else green), P99 latency, slow queries/min
  - **Storage & Memory panel**: disk used/capacity bar, memory used/capacity bar (Redis/Elasticsearch only)
  - Backup status icon: ✓ OK, ⚠ FAILED, spinner for in-progress
- postgres-payments shows: 99/100 connections, 47 waiting, 4.8s avg query, 18.2s P99, 142 slow queries/min — reflects the payment cascade incident
- postgres-payments-replica shows: 184s replication lag badge

### New Type Definitions
- `K8sCluster` extended: `storageCapacity`, `storageUsed`, `networkInMbps`, `networkOutMbps`
- `K8sNode` extended: `podCapacity`, `disks: NodeStorageDisk[]`, `networkInMbps`, `networkOutMbps`, `networkBandwidthMbps`, `packetDropRate`, `osImage`, `kernelVersion`, `containerRuntime`, `uptime`
- **New**: `NodeStorageDisk` interface: device, mountPath, capacityGiB, usedGiB, iopsRead, iopsWrite, latencyMs
- **New**: `PersistentVolume` interface: name, capacity, storageClass, accessMode, reclaimPolicy, status, claimRef, provisioner
- **New**: `DatabaseInstance` interface: engine, hosting, connectionPoolSize, active/idle/waiting connections, QPS read/write, avg/P99 query latency, slow queries/min, storage, optional memory, replication (role, replica count, lag), backup status, linkedIncidentId
- **New**: `DbEngine` type: postgres | mysql | redis | kafka | elasticsearch | mongodb
- **New**: `DbReplication` interface: role, replicaCount, lagSeconds

---

## 5. Kubernetes (`/dashboard/kubernetes`)

### Cluster Summary Strip
- Horizontal scrollable cluster pills showing name, health dot, node count, pod count

### Pods Tab (default)
- Full pod table with: pod name (monospace), namespace, status badge, node, CPU millicores, memory MiB, restart count, age
- CrashLoopBackOff / OOMKilled pods highlighted in red
- High restart count highlighted in red
- Search filter by pod name / namespace

### Clusters Tab
- Grid of 4 cluster cards with node/pod/namespace counts and CPU/memory bars

### Events Tab
- Kubernetes events feed with Warning/Normal color coding
- Reason, involvedObject (Kind/Name), message, repeat count badge

---

## 6. Deployments & Change Correlation (`/dashboard/deployments`)

- **4 KPI cards**: Deploys Today, Success Rate (7d), Avg Deploy Time, Change Failures
- **Status filter tabs**: All / Success / Failed / Rollback / In Progress with live counts
- **Search bar**: filter by service name, branch, deployer, or version
- **Deployment timeline** â€” events grouped by day (Today / Yesterday / N days ago):
  - Status icon (CheckCircle, XCircle, RotateCcw, Zap)
  - Service badge (color-coded per service, 12 distinct palettes)
  - Version number (monospace)
  - **Animated "BROKE IT" badge** â€” pulsing red alert on any deploy with a linked incident ID
  - **Rollback badge** â€” amber indicator when `rollbackOf` is set
  - AI Risk Score badge: red â‰¥70, amber â‰¥40, green <40
  - Deployer, branch, deploy method (Rolling/Canary/Blue-Green/Recreate), duration, commit SHA
  - Relative timestamp
- **Sliding detail panel** (340px) opens on row click:
  - Replica readiness gauge (desired vs ready)
  - Duration, method, AI risk score stats grid
  - **Change diff list** â€” each change shows type (image/config/replicas/resource/env), field name, `- from` (red strikethrough) and `+ to` (green)
  - Full metadata: namespace, environment, commit SHA, branch
  - Incident correlation warning when `linkedIncidentId` is set
- **Correlation footer banner** â€” appears when a "broke it" deploy is selected:
  - Shows service, version, time of deploy, time until first error
  - **94% correlation confidence** badge
  - Direct link to the correlated incident war room
- 20 mock deployment events across 7 days (7 services, failed deploys with matching rollbacks)

---

## 7. Cloud (`/dashboard/cloud`)

- Multi-cloud resource inventory (AWS, Azure, GCP)
- 3 provider summary cards with resource count and monthly cost
- Resource table: 8 resources Ã— 6 columns (name, type, provider badge, region, health status, monthly cost)
- Provider color-coding: AWS=orange, Azure=blue, GCP=green
- High-cost resources highlighted in amber

---

## 8. Incident Command Center

### Incident List (`/dashboard/incidents`)
- Filter tabs: All / Open / Investigating / Identified / Monitoring / Resolved with live counts
- Search by title or incident ID
- Staggered animated list using IncidentRow component
- New incident button
- MTTR KPI shown in header

### Incident War Room (`/dashboard/incidents/[id]`)
- **Incident Header**: ID, severity badge, state badge, owner, team, Slack channel, age
- **Blast Radius Panel**: affected users count, affected services count, revenue/min impact, SLA breach indicator
- **Affected Services** listed as tags
- **AI RCA Panel**: root cause statement, confidence %, evidence bullet list, recommendation
- **Incident Timeline**: chronological events with actor, title, description, timestamp
- **Quick Action Buttons**: Rollback, Scale replicas, Restart pods, Increase DB pool (with "review" warning)
- **Linked Resources**: Runbook link, Slack channel, Topology view
- **Alert List**: all correlated alerts with severity styling
- 3-column layout (timeline+RCA | actions+links+alerts)

---

## 9. AI Copilot Workspace (`/dashboard/ai-copilot`)

- **3-column layout**: investigations sidebar | chat center | context panel
- **Investigations panel**: history of past conversations, related open incidents list
- **Chat interface** â€” powered by Vercel AI SDK `useChat` hook streaming real GPT-4o responses:
  - Message bubbles with user/assistant differentiation
  - Gradient AI avatar with sparkle icon
  - Animated loader while AI is querying infrastructure data
  - Markdown-like **bold** + `` `code` `` rendering in responses
  - **Tool call badges** â€” shows which data sources AI queried (Incidents, Alerts, Cluster health, Pod status, Service metrics, Remediation plan)
  - Suggested prompt chips: 5 pre-built queries with colored icons
  - Form submit (Enter to send), disabled while streaming
  - **Demo mode banner** when `OPENAI_API_KEY` is not set
- **Context panel**: live incident count from store, AI skill list
- **5 AI tools** with real infrastructure data access (see section 21)
- Falls back gracefully to 503 when API key is missing

---

## 10. Service Topology (`/dashboard/topology`)

- **SVG-based service graph** â€” 15 nodes, 15 edges
- Force-directed pre-computed node positions
- **Node colors by health**: green (healthy), amber (degraded), red (critical)
- **Animated pulse ring** on critical nodes (CSS SVG animation)
- **Edge rendering**: solid lines for healthy flows, dashed red lines for error-rate edges
- **Request rate labels** on edges
- **Click to inspect**: node detail panel slides in (type, health, namespace, replicas)
- **Search**: highlight matching node, dim others
- **Legend**: Healthy / Degraded / Critical color guide
- Dot-grid background pattern

### Incident Intelligence on Degraded Nodes (L3)
- Detail panel for degraded/critical nodes shows **Active Incidents** section:
  - Filters open incidents from global store matching the node's service name
  - Each incident shown as a clickable link with severity badge â†' opens the incident war room
  - "No active incidents" shown when service is clean
- **Run Diagnosis** button — fires the `diagnose-crash-loop` runbook for the node's namespace/service via `POST /api/automation/execute`
  - Shows spinner during execution
  - Operator/admin only (hidden for Viewer role)

---

## 11. Automation Studio (`/dashboard/automation`)

### Runbook Library (real execution)
- **10 runbooks** across 3 categories (Kubernetes, Application, Infrastructure):
  - `diagnose-crash-loop` â€" fetch pod status + logs + events (read-only)
  - `oom-patch-restart` â€" patch memory limit +256Mi, rollout restart
  - `debug-imagepull` â€" check pod events for image pull errors
  - `high-restart-pods` â€" list pods sorted by restart count
  - `force-delete-terminating` â€" delete stuck Terminating pods
  - `rollback-deployment` â€" roll back deployment to previous revision
  - `cleanup-evicted` â€" delete Evicted pods in namespace
  - `audit-tls-certs` â€" list secrets with `type=kubernetes.io/tls`
  - `scale-deployment` â€" scale replica count by +1
  - `check-resource-limits` â€" dump CPU/memory limits across deployments
- **SVG workflow canvas** with node type color coding (Trigger=cyan, Condition=amber, Action=green, Notify=purple)
- **Run Now** â€" executes real K8s API calls, streams step output
- **Execution history** per runbook with status badges, duration, triggeredBy
- `[auto]` badge on runs triggered by incident pattern matching
- **Incident ID link** on auto-triggered runs

### Auto-Trigger System (`/api/automation/auto-trigger`)
- **Pattern â†' runbook mapping**: CrashLoop â†' diagnose-crash-loop, OOM â†' oom-patch-restart, ImagePull â†' debug-imagepull, high-restart â†' high-restart-pods, Terminating â†' force-delete-terminating, rollback â†' rollback-deployment, evicted â†' cleanup-evicted, TLS â†' audit-tls-certs, scale â†' scale-deployment
- **Default locked/unlocked**: diagnosis runbooks on by default, remediation runbooks require explicit opt-in
- **1-hour cooldown** per incident+runbook combo (no repeated triggers)
- **Per-runbook toggle**: enable/disable auto-trigger per runbook in Settings UI
- **Master on/off switch** in Automation page header
- **Timeline injection**: appends `actor: 'system'` event to incident when auto-triggered
- Called every 5 minutes by the autonomous loop
- Gated by `cfg.auto_runbook_enabled`

---

## 12. Security Intelligence (`/dashboard/security`)

### Threats Tab (default)
- 5 AI-detected threats with severity, type, source, target, detection time, status (active/resolved)
- Severity badges with color-coded borders

### Compliance Tab
- 4 compliance frameworks: CIS Kubernetes Benchmark, SOC2 Type II, PCI-DSS v4.0, NIST 800-190
- Score percentage with progress bar and color thresholds (â‰¥90% green, â‰¥80% amber, <80% red)
- Failed check counts

### Vulnerabilities Tab
- CVE table: CVE ID (monospace), package, severity badge, image:tag, fixed-in version
- 4 CVEs (1 critical, 2 high, 1 medium)

### One-Click CIS Fix Buttons (L3)
- **Fix API** (`/api/security/fix`) — 4 remediation actions, operator/admin only, audit logged:
  - `set_no_priv_esc` — patches `allowPrivilegeEscalation: false` via strategic-merge-patch
  - `remove_host_network` — patches `hostNetwork: false` on the owning deployment
  - `add_psa_label` — adds `pod-security.kubernetes.io/enforce: baseline` to namespace
  - `add_resource_limits` — sets `cpu: 500m / memory: 256Mi` on all containers in deployment
- All actions resolve pod â†' ReplicaSet â†' Deployment owner chain before patching
- **FixButton** component in Workloads tab: appears on No Resource Limits, Host Network Pods, Allow Privilege Escalation rows
- **Namespace table**: Fix button on PSA enforcement `None` cells
- **FixModal** — confirmation dialog before executing any fix:
  - Lists the affected namespace + target resource
  - **Warning block** shown for `remove_host_network` (may break network-dependent pods) and `add_resource_limits` (OOM risk if limits too low)
  - Disabled for Viewer role users

---

## 13. FinOps Intelligence (`/dashboard/finops`)

- **4 KPI cards**: Monthly Cost ($48,420), Potential Savings ($8,640), Daily Average, Forecast
- **Cost by Provider bar chart**: AWS / Azure / GCP with proportional bars
- **Cost by Service bar chart**: 5 services with trend indicators (up/down arrows)
- **Daily Cost 30d chart**: MetricChart area chart
- **AI Optimization Recommendations**: 5 suggestions with effort level badge (low/medium) and monthly savings amount

---

## 14. Analytics & SLA (`/dashboard/analytics`)

- **4 DORA Metrics cards**: Deployment Frequency (18/day), Lead Time (2.4h), Change Failure Rate (3.2%), MTTR (23 min) â€” each with week-over-week trend
- **Request Rate 7d chart** and **Error Rate 7d chart**
- **SLA Compliance table**: 6 services Ã— 5 columns (service, SLA target, actual %, error budget used, status badge)
- Services with breached SLA shown in red, at-risk in amber

---

## 15. Business KPIs (`/dashboard/business`)

- Revenue-at-risk banner in header ($6,000/min)
- **6 KPI cards**: Revenue today, Active Users, Orders, Conversion Rate, Avg Order Value, Churn Rate â€” each with day-over-day trend
- **Revenue Rate chart** (area chart, 60 data points)
- **Infrastructure â†’ Business Impact table**: maps service health to revenue impact ($/min) and affected user count

---

## 16. Settings (`/dashboard/settings`)

### Profile Tab
- User avatar with gradient background
- Editable fields: Full Name, Email, Team, Timezone
- Save changes button

### Integrations Tab
- 8 integrations: Prometheus âœ“, Grafana âœ“, PagerDuty âœ“, Slack âœ“, GitHub âœ“, ArgoCD âœ“, Datadog (disconnected), Jira (disconnected)
- Connect button for disconnected integrations
- Status indicators with CheckCircle icons

---

## 17. Design System

| Token | Value |
|-------|-------|
| Background | `#020617` (surface-950) |
| Surface | `#0f172a` â†’ `#334155` (900â†’700) |
| Brand accent | `#06b6d4` (cyan) |
| Danger | `#ef4444` |
| Warning | `#f59e0b` |
| Success | `#22c55e` |
| Font | Inter (sans) + JetBrains Mono (code) |

**Component classes**: `.glass-card`, `.hover-glow`, `.status-dot` (4 states), `.severity-critical/high/medium/low`, `.metric-chip`, `.ai-gradient`, `.skeleton`, `.timeline-item`, `.nav-item`

**Animations**: float, slideUp, fadeIn, pulse-slow, custom shadows (glow-brand, glow-danger, card)

---

## 18. Shared Components

| Component | Description |
|-----------|-------------|
| `KPICard` | Animated metric card with status glow, trend arrow, pulse dot |
| `Sparkline` | Mini inline area/line chart (Recharts, 40px default) |
| `MetricChart` | Full chart with axes, grid, custom tooltip, brand colors |
| `IncidentRow` | Incident list item with severity bar, badges, meta |
| `SeverityBadge` | Severity pill with border color |
| `StatusDot` | Health dot with optional label |

---

## 19. State Management

**`useDashboardStore`** (Zustand):
- Global health score, alerts (8), incidents (3), AI insights (5)
- 4 clusters, 12 nodes, 60+ pods, 12 deployments
- Service metrics (12 services), cluster metrics (60-point history)
- Topology graph (15 nodes, 15 edges)
- Security threats (5), cost summary
- UI state: command palette open, right sidebar open, active incident, realtime toggle, time range, environment, global search

**`useAIStore`** (Zustand):
- Chat messages, streaming state, conversation ID, investigations list

---

## 20. Authentication & RBAC (NextAuth v5)

### Login Page (`/login`)
- Dark branded login page with VynOps gradient logo
- Email + password form with validation
- **3 demo credential chips** â€” click to autofill, one per role
- Error message on invalid credentials
- Loading spinner state during sign-in
- Redirects back to original `callbackUrl` after login

### Demo Accounts
| Email | Password | Role |
|-------|----------|------|
| `admin@VynOps.io` | `admin123` | Admin (full access) |
| `operator@VynOps.io` | `operator123` | Operator (acknowledge, run automations) |
| `viewer@VynOps.io` | `viewer123` | Viewer (read-only) |

### Middleware Protection
- All `/dashboard/*` routes protected â€” unauthenticated users redirected to `/login?callbackUrl=...`
- Authenticated users redirected away from `/login` back to dashboard
- JWT session strategy (no database required)

### RBAC (`src/lib/rbac.ts`)
- `can(role, action)` permission check with wildcard support (`*`, `view:*`)
- **Admin**: all permissions
- **Operator**: `view:*`, `acknowledge:incident`, `resolve:incident`, `create:incident`, `run:automation`, `mute:alert`
- **Viewer**: `view:*` only
- `RoleGate` client component â€” hides children when user lacks permission

### Session-Aware Components
- TopHeader shows real authenticated user name, email, role badge
- Role badge color-coded: cyan (admin), amber (operator), gray (viewer)

---

## 21. AI Agents (Vercel AI SDK + GPT-4o)

### API Route (`/api/ai/chat`)
- `streamText` with GPT-4o model, system prompt with SRE persona
- Returns `toDataStreamResponse()` for true token-by-token streaming
- Graceful 503 fallback when `OPENAI_API_KEY` not configured
- `maxSteps: 5` for multi-tool chaining (e.g. fetch incidents â†’ then get pod status)

### AI Tools (real infrastructure data)
| Tool | Description |
|------|-------------|
| `get_incidents` | Filtered by severity + state; returns blast radius, RCA, timeline |
| `get_alerts` | Filtered by state + limit; returns source, labels, affected services |
| `get_cluster_health` | All clusters: CPU%, memory%, node/pod count, health score |
| `get_pod_status` | Filtered by phase + namespace; returns restarts, resource usage |
| `get_service_metrics` | p50/p99 latency, error rate, availability per service |
| `suggest_remediation` | Ranked kubectl steps + escalation path for a given incident/problem |

---

## 22. Real-Time SSE Streaming

### API Route (`/api/stream`)
- Server-Sent Events endpoint using `ReadableStream`
- Emits metric snapshot every **5 seconds** with realistic jitter
- Payload: `cpuUsage`, `memoryUsage`, `requestRate`, `errorRate`, `p99Latency`, `activePods`
- Mean-reverting random walk â€” values stay in realistic bounds
- Auto-closes after 10 minutes; ping every 30s to keep alive
- `X-Accel-Buffering: no` header for nginx/proxy compatibility

### `useRealtimeStream` hook
- Connects `EventSource('/api/stream')` when `isRealtimeActive` is true in the store
- Dispatches `updateClusterMetrics(payload)` on every message
- Auto-disconnects when realtime is toggled off or component unmounts
- Mounted via `RealtimeProvider` in the dashboard layout (all pages benefit)

### Zustand Store Update
- Added `updateClusterMetrics(update)` action â€” merges partial metric updates
- Live toggle in TopHeader directly controls SSE connection lifecycle

---

## 23. Data Engine (Mock)
- 3 incidents (INC-001 critical with full timeline/RCA/blast radius, INC-002 high, INC-003 resolved)
- 4 K8s clusters (EKS prod US, EKS prod EU, AKS staging, GKE dev)
- 5 security threats with CVEs
- Realistic payment service failure scenario throughout (memory leak â†’ pool exhaustion â†’ cascade)- **20 deployment events** across 7 days — 7 services, includes failed deploy (`dep-bad-001`) and matching rollback (`dep-rollback-001`) correlated to INC-001; billing-service failure + rollback pair
- **5 distributed traces** — checkout cascade (4823ms, 12 spans, ERROR), payments/charge (3921ms, 8 spans, ERROR), recommendations GPU throttle (2441ms, SLOW), orders (312ms, OK), user profile (18ms, OK)
- **36 log entries** — ERROR/WARN/INFO/DEBUG covering the full payment incident window
- **24 log volume buckets** (5-min intervals, 2h window) with realistic error spike at 10–35 min ago

## 24. Real K8s & Prometheus Backend

### Kubernetes API Integration
- Direct K8s API proxy at configurable `K8S_API_URL` (no kubectl required)
- Pod list, describe, logs, exec endpoints
- Deployment list, rollout restart, scale, patch memory limits
- Event stream per namespace
- ReplicaSet owner-chain resolution for healing targets
- `resolveK8sUrl()` reads `x-k8s-url` request header, falls back to `K8S_API_URL` env
- Configurable `K8S_TIMEOUT_MS` (default 15s)

### Prometheus Integration
- Scrapes `/api/v1/query_range` for CPU, memory, error rate, request rate
- Auto-discovery of alerting rules and firing alerts
- Feeds AI Copilot tools and the autonomous healing loop
- Graceful fallback to mock data when Prometheus unreachable

---

## 25. Incident Management Backend

### API (`/api/incidents`)
- `GET` merges Prometheus-derived auto-incidents with `data/incidents-manual.json` store
- `POST` creates manual incident (persisted to disk)
- `PATCH /:id` updates state, severity, assignee, timeline (persisted)
- SLA window per severity read from runtime config (`sla_minutes_critical/high/medium/low`)
- `slaBreached` and `slaMinutesRemaining` computed on every read
- `escalationLevel` tracked per incident (0-4)

### Auto-Escalation (`/api/incidents/auto-escalate`)
- Scans all open incidents every 5 minutes via autonomous loop
- Fires next escalation level when cumulative delay threshold reached: L1=0 min, L2=15 min, L3=45 min
- Calls `notifyEscalation()` to Slack with SLA status and "Triggered by: Auto-escalation"
- Appends `actor: 'system'` timeline event on each escalation
- Gated by `cfg.auto_escalate_enabled`
- Incident detail page shows `[auto]` blue badge on system timeline events

### Configurable SLA Windows (Settings -> On-Call)
- Per-severity inputs: Critical (30 min), High (120), Medium (480), Low (1440)
- Auto-escalation master toggle
- Saved to `config.runtime.json`, loaded on page mount

---

## 26. Autonomous Operations

### L2 - Autonomous Healing Loop (`/api/autonomous/loop`)
- Runs every 5 minutes via `useAutonomousLoop` hook
- Polls AI insights (restart trends, OOM kills, CPU throttle, memory pressure)
- Qualifies predictions by severity (critical/high) AND confidence >= threshold
- 1-hour per-workload cooldown prevents healing storms
- Resolves Pod -> ReplicaSet -> Deployment owner chain before patching
- Dry-run mode: logged only; Live mode: patches K8s + Slack + audit log
- Outcome verification: checks each healed workload 15 min later, marks resolved/persisted
- Adaptive learning: per-pattern success rate in `data/autonomous.outcomes.jsonl`, adjusts effective confidence threshold

### L3 - SLA Auto-Escalation
*(See Section 25)*

### L4 - Auto-Runbook Trigger
*(See Section 11)*

### L5 - AI Remediation Plans (`/api/autonomous/plan`)
- Plan generation: Groq (llama-4-scout) generates multi-step plans for open critical/high incidents
- Bounded vocabulary: LLM chooses from 12 validated action primitives only - cannot invent commands
  - Read-only (low risk): `check_pod_status`, `check_pod_logs`, `check_rollout_history`, `check_events`, `check_resource_usage`
  - Remediation (medium risk): `restart_deployment`, `rollback_deployment`, `scale_deployment`, `patch_memory_limit`, `delete_crashed_pod`, `verify_health`
- Live context injection: real pod status, deployment state, and warning events included in LLM prompt
- Confidence scoring: LLM self-assesses 0-100; plans with confidence 0 are discarded
- Human review mode (default): plans shown as cards for Approve/Dismiss
- Auto-execute mode: when `auto_execute_plans=true` and `confidence >= auto_execute_threshold`, fires approve endpoint
- Plans persisted to `data/autonomous.plans.jsonl`
- Approve endpoint (`/api/autonomous/plan/[id]/approve`): executes steps sequentially via real K8s API
- Stops on remediation failure, continues through read failures
- Sends Slack Block Kit notification with per-step results on completion
- Appends audit log entry (`data/audit.log.jsonl`) per execution

### Autonomous Ops Page (`/autonomous`)
- Live healing loop status: last run, actions count, outcomes
- Pattern success rate table with adaptive threshold multipliers
- AI Remediation Plans section:
  - Config strip: plan generation toggle, auto-execute toggle, confidence threshold slider (50-99%)
  - Plan cards: severity badge, status, reasoning text, confidence bar, step count
  - Expandable step list with action name, target, reason, and post-execution result output
  - Approve & Execute / Dismiss buttons (pending plans only)
  - `[auto]` purple badge on system-approved plans
  - "Generate now" on-demand button, pending-only / all filter toggle

---

## 27. Runtime Configuration System

### `config.runtime.json`
- Read/write via `readConfig()` / `writeConfig()` helpers
- `GET /api/settings/config` returns full config
- `POST /api/settings/config` merges partial updates, Zod-validated, appends audit log

### Config Fields

| Field | Default | Description |
|-------|---------|-------------|
| `groq_model` | llama-4-scout | Groq model for AI features |
| `auto_escalate_enabled` | false | SLA auto-escalation toggle |
| `sla_minutes_critical` | 30 | SLA window in minutes |
| `sla_minutes_high` | 120 | SLA window in minutes |
| `sla_minutes_medium` | 480 | SLA window in minutes |
| `sla_minutes_low` | 1440 | SLA window in minutes |
| `auto_runbook_enabled` | false | Auto-trigger runbooks on patterns |
| `auto_runbook_allowed` | {} | Per-runbook opt-in map |
| `auto_plan_enabled` | false | AI remediation plan generation |
| `auto_execute_plans` | false | Auto-execute plans above threshold |
| `auto_execute_threshold` | 85 | Confidence % for auto-execute |

### Slack Notifications (`/lib/notify.ts`)
- `notifyEscalation()`: Slack Block Kit with incident details, SLA status, escalation level
- `autoTriggered` flag adds "Triggered by: Auto-escalation" + SLA status block
- Gracefully skipped when `SLACK_WEBHOOK_URL` not set

---

## What Is NOT Yet Built

| Feature | Category |
|---------|----------|
| LangGraph multi-agent orchestration | AI Backend |
| Kafka / NATS event pipeline | Data Pipeline |
| SSO via Okta / Auth0 / SAML | Auth |
| Alert rule configuration UI (create/edit Prometheus rules) | Config |
| Runbook editor (create custom workflows) | Automation |
| Mobile / responsive layout | UI |
| Dark/light theme toggle | UI |
| Multi-tenancy / workspace isolation | Platform |
| Export to PDF / CSV | Reporting |
| OpsGenie alerting destination | Alerting |
| Helm chart / K8s deployment manifests | DevOps |
| Chrome extension for quick access | Extension |
| AI plan step editor (modify before approve) | Autonomous |
| Long-term metric retention (Thanos / VictoriaMetrics) | Observability |
