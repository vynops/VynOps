# VynOps — Windows to Linux Migration Guide

This guide is specific to the **VynOps monorepo** at `D:\vynops`.
The project runs a custom Next.js server (`server.mjs`) with WebSocket support and a Turbo monorepo structure.

---

## What is and is NOT in Git

Before migrating, understand what `.gitignore` excludes — these must be transferred manually:

| Path | Why excluded | Action |
|------|-------------|--------|
| `node_modules/` (root + apps/web) | Platform binaries | Re-run `npm install` on Linux |
| `apps/web/.next/` | Build cache (1.26 GB) | Rebuilt by `npm run dev` / `npm run build` |
| `apps/web/.env.local` | Contains secrets | Copy manually |
| `apps/web/config.runtime.json` | Runtime config (Slack, SMTP, Groq key) | Copy manually |
| `apps/web/data/` | Runtime data (clusters, users, incidents) | Copy manually |
| `apps/web/audit.log.jsonl` | Audit log | Copy manually (optional) |
| `apps/web/notifications.log.jsonl` | Notification log | Copy manually (optional) |

---

## Step 1 — Prepare the Linux machine

### 1a. Install Node.js 20+ via nvm
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node --version   # must be v20.x.x or higher
npm --version    # must be v10+
```

### 1b. Install kubectl (required — app proxies K8s API through it)
```bash
curl -LO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl
sudo mv kubectl /usr/local/bin/
kubectl version --client
```

### 1c. Install git
```bash
sudo apt update && sudo apt install -y git   # Debian/Ubuntu
# or
sudo dnf install -y git                       # RHEL/Fedora
```

---

## Step 2 — Get the source code onto Linux

### Option A — Git (recommended)

On **Windows** (commit anything uncommitted first):
```powershell
cd d:\vynops
git add .
git commit -m "pre-migration snapshot"
git remote add origin https://github.com/yourname/vynops.git   # if not already set
git push -u origin main
```

On **Linux**:
```bash
git clone https://github.com/yourname/vynops.git
cd vynops
```

### Option B — Direct copy via SCP (no Git)

On **Windows**, exclude the large generated folders before copying:
```powershell
# From PowerShell — copy source excluding node_modules and .next
robocopy D:\vynops \\wsl$\Ubuntu\home\user\vynops /E /XD node_modules .next .turbo
```
Or zip and SCP:
```powershell
# Zip (PowerShell 5+ supports -ExcludePattern via 7zip — use 7zip for accuracy)
7z a -xr!node_modules -xr!.next -xr!.turbo vynops-src.zip D:\vynops\*
scp vynops-src.zip user@linux-ip:/home/user/
```
On Linux:
```bash
unzip vynops-src.zip -d vynops
cd vynops
```

---

## Step 3 — Transfer runtime files (not in Git)

Run these from **Windows PowerShell** — replace `user@linux-ip` with your Linux host:

```powershell
# .env.local — secrets and service URLs
scp D:\vynops\apps\web\.env.local user@linux-ip:/home/user/vynops/apps/web/

# Runtime config — Slack webhook, SMTP, Groq key, alert routing, SLA settings
scp D:\vynops\apps\web\config.runtime.json user@linux-ip:/home/user/vynops/apps/web/

# Data directory — clusters, users, incidents, oncall, autonomous plans
scp -r D:\vynops\apps\web\data user@linux-ip:/home/user/vynops/apps/web/
```

**Data files transferred:**
| File | Contents |
|------|----------|
| `data/clusters.json` | Registered K8s clusters with URLs and `isDefault` flag |
| `data/users.json` | User accounts with hashed passwords |
| `data/oncall.json` | On-call schedules |
| `data/incidents-manual.json` | Manually created/updated incidents |
| `data/autonomous.plans.jsonl` | Autonomous remediation plans |
| `data/automation.log.jsonl` | Automation action history |
| `data/ai-usage.jsonl` | AI token usage log |

> **Tip:** You can skip `data/` entirely and start fresh — open Settings on first launch to reconfigure clusters, Groq key, Slack, SMTP, and recreate users.

---

## Step 4 — Install dependencies

Run from the **monorepo root** (installs all workspaces in one command):
```bash
cd vynops
npm install
```

This rebuilds all `node_modules` with Linux binaries (esbuild, sharp, @swc/core, etc.). Takes 1–3 minutes.

> If you see `EACCES` permission errors during install, do **not** use `sudo npm install`. Instead fix npm's permissions: `mkdir -p ~/.npm && chown -R $(whoami) ~/.npm`

---

## Step 5 — Update `.env.local` for Linux

The `.env.local` you copied has Windows/network-specific URLs. Update them for the Linux environment:

```bash
nano apps/web/.env.local
```

Key values to update:

```env
# ── Authentication (required) ────────────────────────────────
# AUTH_SECRET is used by NextAuth v5 (next-auth@5 / @auth/core)
AUTH_SECRET=Xh+ocxTI1lG7JzUjPX5zpC88LmJlKJR0oxOlbLR0qxE=
# NEXTAUTH_URL must match the URL you'll access the app from
NEXTAUTH_URL=http://localhost:3000

# ── K8s + Services ───────────────────────────────────────────
# These are last-resort fallbacks. Primary source = data/clusters.json (isDefault cluster).
# Fallback order: (1) request header → (2) isDefault in clusters.json → (3) env var
K8S_API_URL=http://127.0.0.1:8001         # kubectl proxy address on Linux
PROMETHEUS_URL=http://127.0.0.1:9090      # update to your Prometheus address
ALERTMANAGER_URL=http://127.0.0.1:8001/api/v1/namespaces/monitoring/services/monitoring-kube-prometheus-alertmanager:9093/proxy
LOKI_URL=http://127.0.0.1:8001/api/v1/namespaces/monitoring/services/loki:3100/proxy
JAEGER_QUERY_URL=http://127.0.0.1:16686
GRAFANA_URL=http://127.0.0.1:8001/api/v1/namespaces/monitoring/services/monitoring-grafana:80/proxy

# ── Timing ───────────────────────────────────────────────────
K8S_TIMEOUT_MS=15000    # increase to 20000-30000 for VPN/remote clusters

# ── AI ───────────────────────────────────────────────────────
GROQ_API_KEY=your_groq_key_here
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct

# ── Notifications ────────────────────────────────────────────
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
# PAGERDUTY_ROUTING_KEY=your_32char_key
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
# SMTP_PASS=your-app-password
```

> **Important:** The app uses `AUTH_SECRET` (NextAuth v5), not `NEXTAUTH_SECRET`. Both are in the file — `AUTH_SECRET` takes precedence.

---

## Step 6 — Start kubectl proxy (required for K8s API access)

The app routes all K8s API calls through `kubectl proxy`. This must be running before you start the app.

```bash
# Point kubectl to your cluster first
kubectl config use-context your-cluster-name
kubectl cluster-info   # verify connection

# Start proxy — binds to all interfaces so the app can reach it
kubectl proxy --port=8001 --address=0.0.0.0 --accept-hosts='.*' &

# Or as a background service — keep running after terminal closes:
nohup kubectl proxy --port=8001 --address=0.0.0.0 --accept-hosts='.*' > /tmp/kubectl-proxy.log 2>&1 &
echo $! > /tmp/kubectl-proxy.pid
```

Then update `K8S_API_URL` in `.env.local` and `k8sUrl` in `data/clusters.json` to `http://127.0.0.1:8001`.

---

## Step 7 — Fix file permissions

Linux enforces permissions strictly. The app writes to `data/` and `config.runtime.json` at runtime:

```bash
cd vynops/apps/web

# Data directory must be writable by the app process
mkdir -p data
chmod 755 data
chmod 644 data/*.json data/*.jsonl 2>/dev/null || true

# config.runtime.json — writable (Settings page updates it)
touch config.runtime.json
chmod 644 config.runtime.json

# .env.local — readable only by owner (contains secrets)
chmod 600 .env.local
```

---

## Step 8 — Run the app

The app uses a **custom Node.js server** (`server.mjs`), not plain `next dev`. This is required for WebSocket support (terminal exec into pods).

### Development mode
```bash
cd vynops
npm run dev
# Starts via: node --max-old-space-size=1536 server.mjs
# App available at http://localhost:3000
```

### Production mode
```bash
cd vynops

# Build first
npm run build   # runs: turbo build → next build

# Start production server
npm start       # runs: next start (from apps/web)
```

### Keep running after disconnect (production)
```bash
npm install -g pm2

# Run the custom server.mjs (not "npm start" — that uses next start without WebSocket)
cd vynops/apps/web
pm2 start server.mjs --name vynops --node-args="--max-old-space-size=1536"
pm2 save
pm2 startup    # prints a command — run it to enable auto-start on reboot
```

---

## Step 9 — Verify everything works

Open `http://localhost:3000` and check:

- [ ] Login page loads
- [ ] Dashboard loads without errors
- [ ] Cluster selector shows your cluster (top header)
- [ ] Observability → Metrics shows Prometheus data
- [ ] Incidents page shows live alerts from Prometheus
- [ ] AI Copilot responds (Groq key active)
- [ ] Settings → Clusters → Test Connection succeeds
- [ ] Terminal (pod exec) works — requires kubectl proxy running

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot find module 'next'` | `node_modules` not installed | Run `npm install` from monorepo root |
| Login fails / "JWT decode error" | `AUTH_SECRET` mismatch | Ensure `.env.local` has same `AUTH_SECRET` as Windows |
| Dashboard shows "No cluster" | `data/clusters.json` not transferred | SCP the `data/` folder or add cluster via Settings |
| K8s API 403/connection refused | `kubectl proxy` not running | Start `kubectl proxy --port=8001` |
| "Prometheus not reachable" | Wrong `PROMETHEUS_URL` | Check URL in `.env.local` and `data/clusters.json` |
| WebSocket terminal fails | `server.mjs` not used | Make sure you're running `npm run dev`, not `next dev` |
| `EACCES` on `data/` writes | File permission | `chmod 755 apps/web/data` |
| Port 3000 already in use | Another process | `lsof -i :3000` then kill it, or set `PORT=3001` in `.env.local` |
| `sharp` install errors | Native module rebuild | `cd apps/web && npm rebuild sharp` |
| `CRLF` line endings in scripts | Windows line endings | `git config --global core.autocrlf input` before cloning |
| Out of memory during build | Low RAM | Increase swap: `sudo fallocate -l 4G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |
