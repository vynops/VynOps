<div align="center">

# VynOps AI Platform

### AI-Powered Kubernetes Operations Platform

**Self-hosted · Open Source · Enterprise Ready**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-38B2AC?logo=tailwind-css&logoColor=white)](https://tailwindcss.com)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?logo=kubernetes&logoColor=white)](https://kubernetes.io)
[![Playwright](https://img.shields.io/badge/Tested_with-Playwright-2EAD33?logo=playwright&logoColor=white)](apps/web/tests/e2e)
[![Live Demo](https://img.shields.io/badge/Live_Demo-vynops.online-6366f1)](https://vynops.online)

*Observe. Predict. Remediate. All from one intelligent dashboard.*

</div>

---

## Overview

VynOps is a production-grade, self-hosted AIOps platform for Kubernetes. It unifies observability, incident management, cost intelligence, security posture, and autonomous remediation into a single AI-assisted interface — eliminating the need to switch between Prometheus dashboards, Grafana, kubectl, spreadsheets, and Slack during incidents.

Built on **Next.js 15 App Router** with a real-time custom WebSocket server, VynOps connects directly to your Kubernetes cluster via `kubectl proxy` and your existing Prometheus/Loki/Jaeger stack — no agents, no sidecars, no vendor lock-in.

> **Design philosophy:** VynOps does not replace your monitoring stack. It sits on top of it and adds intelligence.

---

## Screenshots

> _Screenshots coming soon — contributions welcome!_

| Dashboard | AI Copilot | Incident Detail |
|-----------|------------|----------------|
| _(coming soon)_ | _(coming soon)_ | _(coming soon)_ |

---

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
  - [Local Development](#local-development)
  - [Remote / Cloud Server](#remote--cloud-server)
  - [Production with PM2](#production-with-pm2)
- [Configuration](#configuration)
- [Adding Clusters](#adding-clusters)
- [AI Copilot](#ai-copilot)
- [Autonomous Operations](#autonomous-operations)
- [Notifications](#notifications)
- [Security](#security)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Tech Stack](#tech-stack)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### 🔭 Observability
- **Live metrics** — CPU, memory, disk, network from Prometheus with configurable time ranges (15m → 30d)
- **Log streaming** — Loki integration with label browser, live tail, and log-level filtering
- **Distributed tracing** — Jaeger trace viewer with service dependency maps
- **Grafana embeds** — Surface existing dashboards directly inside VynOps

### 🚨 Incident Management
- **Auto-generated incidents** — Prometheus alerts grouped into incidents with SLA tracking and escalation levels
- **Blast radius analysis** — Affected services, dependent services, revenue impact estimation
- **Timeline** — Full audit trail from alert fire to resolution
- **Manual incidents** — Create, assign, and track non-alert incidents
- **SLA breach warnings** — Real-time countdown before SLA deadline

### 🤖 AI Copilot
- **Conversational interface** — Ask in plain English: *"Why is my payments service slow?"*
- **Root cause analysis** — AI correlates metrics, logs, events, and alert history automatically
- **Runbook generation** — Produces step-by-step remediation with kubectl commands
- **kubectl command builder** — Describe what you want, get the command
- **Conversation history** — Full chat history with token usage tracking
- **Powered by Groq** — Sub-second responses with llama-4-scout-17b (30K TPM free tier)

### ⚡ Autonomous Operations
- **Auto-heal crash loops** — Detects pods with 20+ restarts, triggers rolling restart with 30-min cooldown
- **Remediation plans** — AI-generated plans with per-step approval gates
- **Audit trail** — Every autonomous action logged to `data/autonomous.plans.jsonl`
- **Configurable policies** — Enable/disable per action type; dry-run mode available

### ☁️ Cloud & FinOps
- **Real cost model** — CPU, memory, storage costs derived from K8s resource requests (not estimated)
- **Per-namespace breakdown** — Cost share %, efficiency score, waste per namespace
- **Right-sizing recommendations** — kubectl-ready patches with risk level (low/medium/high)
- **Node health** — Per-node CPU/mem usage, pod capacity, headroom, uptime
- **Cost rate editor** — Configure $/core/hr, $/GiB/hr, $/GiB/mo to match your cloud contract

### 🔒 Security
- **Privileged container detection** — Flags containers running with `privileged: true`
- **Missing resource limits** — Identifies pods without CPU/memory limits
- **TLS certificate expiry** — Scans Ingress TLS certs and warns before expiry
- **RBAC analysis** — Overly broad ClusterRoleBindings and wildcard permissions
- **Container image scanner** — Flags pods running `latest` tag or deprecated images
- **API deprecation scanner** — Detects resources using deprecated/removed K8s API versions

### 🗺️ Topology & Dependencies
- **Service topology map** — Interactive graph of pod-to-pod connections via Cytoscape.js
- **Dependency map** — Which services call which, with latency and error rates
- **Network policies** — Visualise and validate NetworkPolicy coverage

### 🚀 Deployments
- **Deployment history** — Rollout timeline per deployment with replica status
- **Rollback** — One-click rollback to previous revision
- **Canary/rollout tracking** — Progress bars for rolling updates

### 📊 Analytics & Business KPIs
- **SLA compliance %** — Across all incidents over time
- **MTTR trending** — Mean time to resolution over 7d/30d
- **Alert volume** — Noise vs signal analysis
- **Business KPI overlays** — Map infrastructure events to business metrics

### 🔔 Notifications
- **Slack** — Rich block kit messages with severity routing
- **Email / SMTP** — Alert emails with HTML templates
- **Configurable routing** — critical → Slack, warning → Slack, info → Slack
- **30-minute cooldown** — Deduplication prevents alert fatigue
- **On-call schedules** — Built-in on-call rotation management

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (React 19)                       │
│  Dashboard · Incidents · AI Copilot · K8s Browser · FinOps      │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP / WebSocket
┌────────────────────────────▼────────────────────────────────────┐
│                  Next.js 15 App Router                          │
│  server.mjs (custom Node.js — adds WebSocket for pod exec)      │
│                                                                 │
│  /api/k8s/*      → kubectl proxy → Kubernetes API               │
│  /api/ai/*       → Groq (llama-4-scout)                         │
│  /api/incidents  → Prometheus ALERTS query                      │
│  /api/cloud/*    → K8s + Prometheus resource/cost queries       │
│  /api/settings/* → data/*.json (disk-backed store)              │
└──────┬──────────────┬───────────────┬────────────────┬──────────┘
       │              │               │                │
  kubectl proxy   Prometheus       Groq API        data/*.json
  (K8s API)      /Alertmanager    (AI models)     (clusters, users,
                 /Loki/Jaeger                      incidents, oncall)
                 /Grafana
```

**Key design decisions:**
- No database — all persistent state in JSON files on disk (simple, portable, backup-friendly)
- No agents — connects to standard K8s and Prometheus APIs only
- Cluster headers — `x-k8s-url`, `x-prom-url` etc. route each request to the correct cluster
- Auth — NextAuth v5 with bcrypt-hashed passwords stored in `data/users.json`

---

## Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | **20+** | Install via [nvm](https://github.com/nvm-sh/nvm) |
| npm | **10+** | Bundled with Node 20 |
| kubectl | any | Configured and pointing at your cluster |
| Kubernetes | 1.24+ | k3s, k3d, EKS, GKE, AKS, OKE all tested |
| Prometheus | 2.x+ | Required for metrics, alerts, cost data |
| Groq API key | — | Free tier at [console.groq.com](https://console.groq.com) |

**Optional integrations** (app works without them, features degrade gracefully):

| Service | Feature unlocked |
|---------|-----------------|
| Loki | Log streaming and search |
| Jaeger | Distributed tracing |
| Grafana | Embedded dashboards |
| Alertmanager | Alert silencing/inhibition |
| Slack | Push notifications |
| SMTP | Email alerts |

---

## Installation

### Local Development

```bash
# 1. Clone
git clone https://github.com/YOUR-USERNAME/vynops.git
cd vynops

# 2. Install all workspace dependencies
npm install

# 3. Configure environment
cp apps/web/.env.local.example apps/web/.env.local
```

Edit `apps/web/.env.local` — minimum required values:
```env
AUTH_SECRET=<output of: openssl rand -base64 32>
NEXTAUTH_URL=http://localhost:3030
GROQ_API_KEY=gsk_...          # free at https://console.groq.com
```

```bash
# 4. Start kubectl proxy (in a separate terminal)
kubectl proxy --port=8001

# 5. Start VynOps
npm run dev
# → http://localhost:3030
```

**Default credentials:**
| Field | Value |
|-------|-------|
| Email | `admin@vynops.local` |
| Password | `changeme` |

> ⚠️ Change the default password immediately via **Settings → Users**.

> ⚠️ Demo credentials are only active when `data/users.json` does not exist. Once you create your first user through the UI, demo users are disabled.

---

### Remote / Cloud Server

When running on a remote VM accessed by its public IP:

```bash
# In apps/web/.env.local on the server:
AUTH_SECRET=<same strong secret as generated above>
NEXTAUTH_URL=http://YOUR-SERVER-IP:3000
ALLOWED_DEV_ORIGINS=YOUR-SERVER-IP
GROQ_API_KEY=gsk_...
K8S_API_URL=http://127.0.0.1:8001
PROMETHEUS_URL=http://127.0.0.1:9090
```

Start kubectl proxy with access from all local interfaces:
```bash
kubectl proxy --port=8001 --address=127.0.0.1 &
```

```bash
npm run dev
# → http://YOUR-SERVER-IP:3030
```

> **Port conflict:** If port 3030 is taken, set `PORT=4030` in `.env.local` and update `NEXTAUTH_URL` to match.

---

### Production with PM2

VynOps uses a **custom Node.js server** (`server.mjs`) that adds WebSocket support for interactive pod terminal (`kubectl exec`). You must use this server — not `next start` — in production too.

```bash
# Install PM2 globally
npm install -g pm2

# Start VynOps (from the apps/web directory)
cd vynops/apps/web
pm2 start server.mjs --name vynops --node-args="--max-old-space-size=1536"

# Save process list and enable auto-start on reboot
pm2 save
pm2 startup     # run the command it prints

# Useful PM2 commands
pm2 status      # view running processes
pm2 logs vynops # tail logs
pm2 restart vynops   # restart after config changes
pm2 stop vynops      # stop
```

---

## Configuration

All configuration lives in `apps/web/.env.local`. Copy from `.env.local.example` to get started.

### Authentication

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_SECRET` | ✅ | Session encryption key. Generate: `openssl rand -base64 32` |
| `NEXTAUTH_URL` | ✅ | Full URL the app is accessed from. Must match exactly (including port). |

### AI

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GROQ_API_KEY` | ✅ | — | Groq API key. Free at [console.groq.com](https://console.groq.com) — supports llama-4-scout (30K TPM free) |
| `GROQ_MODEL` | ❌ | `meta-llama/llama-4-scout-17b-16e-instruct` | Model for AI Copilot. See [Groq models](https://console.groq.com/docs/models) |

### Kubernetes & Observability

> These are **last-resort fallbacks** only. The preferred method is to register clusters via **Settings → Clusters** in the UI.

| Variable | Default | Description |
|----------|---------|-------------|
| `K8S_API_URL` | `http://127.0.0.1:8001` | kubectl proxy address |
| `PROMETHEUS_URL` | `http://127.0.0.1:9090` | Prometheus base URL |
| `ALERTMANAGER_URL` | — | Alertmanager URL |
| `LOKI_URL` | — | Loki base URL |
| `JAEGER_QUERY_URL` | `http://127.0.0.1:16686` | Jaeger query URL |
| `GRAFANA_URL` | — | Grafana base URL |
| `K8S_TIMEOUT_MS` | `15000` | API request timeout in ms. Increase to 25000+ for VPN/remote clusters |

**Proxied service URLs** (when services are not directly exposed):
```env
# Route through kubectl proxy — no extra firewall rules needed
ALERTMANAGER_URL=http://127.0.0.1:8001/api/v1/namespaces/monitoring/services/monitoring-kube-prometheus-alertmanager:9093/proxy
LOKI_URL=http://127.0.0.1:8001/api/v1/namespaces/monitoring/services/loki:3100/proxy
GRAFANA_URL=http://127.0.0.1:8001/api/v1/namespaces/monitoring/services/monitoring-grafana:80/proxy
```

### Notifications

| Variable | Description |
|----------|-------------|
| `SLACK_WEBHOOK_URL` | Incoming webhook URL from [Slack API](https://api.slack.com/messaging/webhooks) |
| `SMTP_HOST` | SMTP hostname, e.g. `smtp.gmail.com` |
| `SMTP_PORT` | SMTP port, e.g. `587` |
| `SMTP_USER` | SMTP username / email address |
| `SMTP_PASS` | SMTP password or [Gmail app password](https://myaccount.google.com/apppasswords) |
| `SMTP_FROM` | Sender address, e.g. `VynOps <alerts@company.com>` |

Fine-tune notification behaviour via **Settings → Notifications** in the UI (saved to `config.runtime.json`).

### Advanced

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default: `3030`) |
| `ALLOWED_DEV_ORIGINS` | Comma-separated IPs/hostnames allowed to access the dev server remotely. Leave unset for local development. |
| `CRON_SECRET` | Secret for internal cron jobs. Auto-generated at startup if not set. |

---

## Adding Clusters

VynOps supports multiple Kubernetes clusters. Cluster configuration is stored in `apps/web/data/clusters.json` and managed through the UI — no restart required.

**Via the UI (recommended):**
1. Open **Settings → Clusters**
2. Click **Add Cluster**
3. Enter a name and the `kubectl proxy` URL for that cluster
4. Click **Test Connection** to verify reachability
5. Optionally configure Prometheus, Loki, Jaeger, Grafana, and Alertmanager URLs per cluster
6. Click **Set Default** to make it the active cluster on page load

**Request routing:**  
Each API request carries cluster-specific headers (`x-k8s-url`, `x-prom-url`, `x-loki-url`, etc.) set by the frontend based on the active cluster. This means switching clusters in the header dropdown immediately reroutes all API calls — no page refresh needed.

**Fallback order** (per request):
1. Request header (`x-k8s-url` etc.)
2. `isDefault: true` cluster in `data/clusters.json`
3. Environment variable (`K8S_API_URL` etc.)

---

## AI Copilot

The AI Copilot provides a conversational interface to your cluster powered by **Groq** (llama-4-scout-17b, 30K tokens/min on free tier).

**What it can do:**
- Answer questions about your cluster state in plain English
- Perform root cause analysis by correlating metrics, logs, and events
- Generate and explain kubectl commands
- Produce step-by-step remediation runbooks
- Silence Prometheus alerts
- Scale deployments
- Trigger autonomous remediation workflows

**Model strategy:**
| Model | Use case | Limit |
|-------|----------|-------|
| `llama-4-scout-17b-16e-instruct` | Primary — fast, large context (16K) | 30K TPM free |
| `llama-3.3-70b-versatile` | Deep RCA and complex analysis | 6K TPM free |

Switch models via `GROQ_MODEL` in `.env.local` or by upgrading to Groq Dev Tier for higher limits.

---

## Autonomous Operations

VynOps can take automated remediation actions when issues are detected.

**Currently automated:**
- **CrashLoop auto-restart** — pods with 20+ restarts trigger a rolling restart of the parent Deployment, with a 30-minute cooldown per deployment and a `vynops.ai/last-auto-heal` annotation to prevent re-firing

**Approval-gated plans** (AI generates, human approves each step):
- Right-sizing resource limits
- Scaling deployments up/down
- Rolling back failed deployments

**Audit trail:**  
Every autonomous action is appended to `data/autonomous.plans.jsonl` and displayed in **Autonomous Ops** page with full step-by-step history.

**Enable/disable per action type:**  
Settings → Autonomous Ops → toggle individual action types on/off.

---

## Notifications

VynOps sends notifications automatically when critical events occur.

**Notification events:**
| Event | Default channels | Cooldown |
|-------|-----------------|---------|
| Auto-heal (deployment restarted) | Slack | None |
| Critical incidents (health < 60) | Slack | 30 min |
| Deployment failures | Slack | 30 min |
| Node not ready | Slack | 30 min |
| High restart rate | Slack | 30 min |
| Disk > 80% | Slack | 30 min |
| SLA at risk | Slack | 30 min |

**Configure routing** via Settings → Notifications:
```json
{
  "alert_routing": {
    "critical": ["slack"],
    "warning": ["slack"],
    "info": ["slack"]
  },
  "notify_cooldown_minutes": 30
}
```

## Security

### Authentication
- Session-based auth via NextAuth v5 with JWT
- Passwords hashed with bcrypt (10 salt rounds)
- User accounts stored in `data/users.json` — never committed to git
- `AUTH_SECRET` must be a cryptographically random 32-byte base64 string

### Role-based access
| Role | Capabilities |
|------|-------------|
| `admin` | Full access — manage users, clusters, settings |
| `sre` | All operational features — incidents, deployments, K8s actions |
| `viewer` | Read-only — dashboards, metrics, incidents (no actions) |

### Data security
- `data/` directory is gitignored — cluster URLs, user passwords, and API keys never leave the server
- `config.runtime.json` (Slack webhook, Groq key, SMTP password) is gitignored
- `.env.local` is gitignored

### Network security
- All K8s API calls go through `kubectl proxy` — no cluster credentials are stored in the app
- `kubectl proxy` should bind to `127.0.0.1` only (not `0.0.0.0`) in production
- Run VynOps behind a reverse proxy (nginx/Caddy) with TLS in production

### Content Security
- No outbound calls except: Groq API, Slack webhook, PagerDuty Events API (all configurable)
- No telemetry, no usage tracking, no phone-home

---

## Project Structure

```
vynops/
├── apps/
│   └── web/                          # Next.js 15 application
│       ├── src/
│       │   ├── app/
│       │   │   ├── (dashboard)/      # All UI pages (client components)
│       │   │   │   ├── ai-copilot/   # AI chat interface
│       │   │   │   ├── analytics/    # SLA/MTTR analytics
│       │   │   │   ├── automation/   # Automation rules
│       │   │   │   ├── autonomous/   # Autonomous ops plans
│       │   │   │   ├── business/     # Business KPIs
│       │   │   │   ├── cloud/        # Cloud/FinOps (cost + nodes)
│       │   │   │   ├── deployments/  # Deployment management
│       │   │   │   ├── incidents/    # Incident list + detail
│       │   │   │   ├── infrastructure/ # Node/cluster overview
│       │   │   │   ├── kubernetes/   # Full K8s resource browser
│       │   │   │   ├── observability/ # Metrics, logs, traces
│       │   │   │   ├── security/     # Security posture
│       │   │   │   ├── settings/     # All settings pages
│       │   │   │   └── topology/     # Service topology map
│       │   │   ├── api/              # All API routes (server-side)
│       │   │   │   ├── ai/           # Chat, insights, usage
│       │   │   │   ├── autonomous/   # Loop, plan, history
│       │   │   │   ├── cloud/        # Cost overview
│       │   │   │   ├── incidents/    # Incident CRUD + escalation
│       │   │   │   ├── k8s/          # K8s proxy (40+ endpoints)
│       │   │   │   ├── observability/ # Metrics, logs, traces
│       │   │   │   ├── prometheus/   # Direct Prometheus queries
│       │   │   │   └── settings/     # Clusters, users, config, oncall
│       │   │   └── login/            # Login page
│       │   ├── components/
│       │   │   ├── shell/            # TopHeader, LeftNav, RightAISidebar
│       │   │   ├── charts/           # Recharts wrappers
│       │   │   ├── k8s/              # K8s-specific components
│       │   │   └── providers/        # Auth, query, theme providers
│       │   ├── lib/
│       │   │   ├── cluster.ts        # Per-request cluster URL resolver
│       │   │   ├── auth.ts           # NextAuth config
│       │   │   ├── notify.ts         # Slack/PagerDuty/Email helpers
│       │   │   └── utils.ts          # cn(), formatCurrency(), etc.
│       │   ├── store/
│       │   │   └── index.ts          # Zustand global state
│       │   └── types/                # Shared TypeScript types
│       ├── data/                     # Runtime data (gitignored except seeds)
│       │   ├── clusters.json         # Registered K8s clusters
│       │   ├── users.json            # User accounts (hashed passwords)
│       │   ├── incidents-manual.json # Manually created incidents
│       │   └── oncall.json           # On-call schedules
│       ├── tests/
│       │   └── e2e/                  # Playwright end-to-end test suites
│       │       ├── 01-auth.spec.ts
│       │       ├── 02-dashboard.spec.ts
│       │       ├── 03-observability.spec.ts
│       │       ├── 04-infrastructure.spec.ts
│       │       ├── 05-kubernetes.spec.ts
│       │       ├── 06-incidents.spec.ts
│       │       ├── 07-deployments.spec.ts
│       │       ├── 08-ai-copilot.spec.ts
│       │       ├── 09-security-automation-cloud.spec.ts
│       │       ├── 10-navigation.spec.ts
│       │       └── helpers/auth.ts   # Login fixtures
│       ├── smoke-check.mjs           # Pre-deploy API health check (65 endpoints)
│       └── playwright.config.ts      # Playwright test runner config
│       ├── server.mjs                # Custom Node.js server (WebSocket for exec)
│       ├── next.config.ts            # Next.js configuration
│       └── .env.local                # Secrets (never committed)
├── .gitignore
├── .gitattributes                    # LF line endings enforcement
├── .env.local.example                # Environment variable template
├── turbo.json                        # Turbo monorepo config
├── package.json                      # Root workspace package
├── README.md                         # This file
├── LINUX_MIGRATION.md                # Windows → Linux migration guide
└── GITHUB_PUSH_GUIDE.md              # GitHub setup and cross-platform guide
```

---

## API Reference

VynOps exposes a REST API under `/api/`. All endpoints require authentication (session cookie).

### Cluster routing headers
Every API request can be routed to a specific cluster by including these headers:

| Header | Description |
|--------|-------------|
| `x-k8s-url` | Kubernetes API URL (kubectl proxy) |
| `x-prom-url` | Prometheus base URL |
| `x-loki-url` | Loki base URL |
| `x-jaeger-url` | Jaeger query URL |
| `x-grafana-url` | Grafana base URL |
| `x-alertmanager-url` | Alertmanager URL |

### Key endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/ai/insights` | AI-generated cluster insights from live K8s + Prometheus data |
| `POST` | `/api/ai/chat` | AI Copilot chat (streaming) |
| `GET` | `/api/incidents` | List all incidents (auto from Prometheus + manual) |
| `GET` | `/api/cloud/overview` | Cost, node, storage, and optimization data |
| `GET` | `/api/k8s/pods` | All pods across all namespaces |
| `GET` | `/api/k8s/nodes` | Node list with status and resource usage |
| `GET` | `/api/k8s/deployments` | Deployments with replica status |
| `GET` | `/api/k8s/logs` | Pod/container logs |
| `WS` | `/api/k8s/exec` | WebSocket exec into a container |
| `GET` | `/api/settings/clusters` | List registered clusters |
| `POST` | `/api/settings/clusters` | Add a cluster |
| `PATCH` | `/api/settings/clusters?setDefault=1` | Set default cluster |
| `GET` | `/api/observability/metrics` | Prometheus metrics for charts |
| `GET` | `/api/security` | Security posture scan results |
| `POST` | `/api/autonomous/loop` | Trigger autonomous remediation check |

---

## Tech Stack

| Category | Technology | Version |
|----------|-----------|---------|
| Framework | Next.js | 15 (App Router) |
| Language | TypeScript | 5.5 |
| UI Library | React | 19 |
| Styling | Tailwind CSS | 3.4 |
| Animation | Framer Motion | 11 |
| State management | Zustand | 5 |
| Data fetching | TanStack Query | 5 |
| Auth | NextAuth / @auth/core | v5 |
| AI SDK | Groq via ai SDK | 4.x |
| Charts | Recharts | 2.x |
| Graph / topology | Cytoscape.js | 3.x |
| Flow diagrams | React Flow | 11 |
| Icons | Lucide React | 0.468 |
| Component primitives | Radix UI | latest |
| Validation | Zod | 3.x |
| Testing | Vitest | 4.x |
| Build system | Turbo (monorepo) | 2.x |
| Custom server | Node.js + ws | 20+ |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| API routes returning 404 | Stale Windows `.next` cache on Linux | `rm -rf .next && npm run dev` |
| Login fails / auth error | `AUTH_SECRET` not set or `NEXTAUTH_URL` wrong | Check both in `.env.local` |
| "No cluster" in header | No cluster registered | Settings → Clusters → Add Cluster |
| Prometheus data missing | kubectl proxy not running | `kubectl proxy --port=8001 &` |
| Pod terminal (exec) doesn't work | Using `next dev` instead of `npm run dev` | Always use `npm run dev` — it uses `server.mjs` |
| Port 3000 already in use | Another process on port 3000 | `lsof -i :3000` to find it, or set `PORT=3001` in `.env.local` |
| `NEXTAUTH_URL` mismatch | Accessing via different IP/port than configured | Update `NEXTAUTH_URL` to match your actual access URL |
| Loki "not configured" | Active cluster has empty `lokiUrl` | Edit cluster in Settings → Clusters, set Loki URL |
| AI Copilot not responding | Groq key missing or invalid | Check `GROQ_API_KEY` in `.env.local` |
| Slow responses on VPN | Default 15s timeout too short | Set `K8S_TIMEOUT_MS=25000` in `.env.local` |
| Low memory / OOM during build | Node.js heap too small | Already handled: `--max-old-space-size=1536` in `npm run dev` |
| `EACCES` on `data/` writes | Linux file permissions | `chmod 755 apps/web/data` |
| `sharp` native module errors | Platform mismatch (Windows → Linux) | `npm install` on the Linux machine (rebuilds natively) |

---

## Contributing

Contributions are welcome.

```bash
# Fork and clone
git clone https://github.com/YOUR-USERNAME/vynops.git
cd vynops
npm install

# Create a feature branch
git checkout -b feature/your-feature-name

# Make changes, then typecheck and lint
npm run type-check
npm run lint

# Run tests
npm test

# Commit and push
git add .
git commit -m "feat: describe your change"
git push origin feature/your-feature-name
```

Then open a Pull Request.

**Before submitting:**
- [ ] TypeScript compiles with no errors (`npm run type-check`)
- [ ] No new hardcoded credentials, IPs, or absolute paths
- [ ] New env vars documented in `.env.local.example`
- [ ] Sensitive data gitignored

---

## Part of the VynOps Suite

| Product | Purpose | Repo |
|---|---|---|
| **VynOps** | Kubernetes operations platform | [vynops/VynOps](https://github.com/vynops/VynOps) |
| **VynAI** | Ollama fleet manager and AI gateway | [vynops/VynAI](https://github.com/vynops/VynAI) |
| **VynCost** | Cloud cost visibility | [vynops/VynCost](https://github.com/vynops/VynCost) |
| **VynDB** | Database operations | [vynops/VynDB](https://github.com/vynops/VynDB) |
| **VynDC** | Data center management | [vynops/VynDC](https://github.com/vynops/VynDC) |
| **VynCICD** | CI/CD pipeline management | [vynops/VynCICD](https://github.com/vynops/VynCICD) |

---
## License

MIT License — see [LICENSE](LICENSE) for details.

---

<div align="center">
  <sub>Built with ❤️ for platform engineers who are tired of switching between 12 tabs during an incident.</sub>
</div>

