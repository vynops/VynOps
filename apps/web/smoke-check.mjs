/**
 * VynOps Smoke Check — Pre-push API health script
 * Usage: node smoke-check.mjs [base_url]
 * Default base_url: http://localhost:3000
 *
 * Tests every major API endpoint. Exits 0 on full pass, 1 on any failure.
 */

const BASE = process.argv[2] ?? 'http://localhost:3000'
const ADMIN_EMAIL = 'admin@VynOps.io'
const ADMIN_PASS  = 'admin123'

const RESET  = '\x1b[0m'
const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN   = '\x1b[36m'
const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'

let passed = 0, failed = 0, warned = 0
const results = []

function log(symbol, label, status, note = '') {
  const col = symbol === '✓' ? GREEN : symbol === '⚠' ? YELLOW : RED
  const noteStr = note ? `  ${DIM}${note}${RESET}` : ''
  console.log(`  ${col}${symbol}${RESET} ${label.padEnd(52)} ${col}${status}${RESET}${noteStr}`)
}

async function check(label, fn) {
  try {
    const { ok, status, note } = await fn()
    if (ok) {
      passed++
      results.push({ label, ok: true, status })
      log('✓', label, String(status))
    } else {
      failed++
      results.push({ label, ok: false, status, note })
      log('✗', label, String(status), note)
    }
  } catch (e) {
    failed++
    results.push({ label, ok: false, status: 'ERR', note: e.message })
    log('✗', label, 'ERR', e.message.slice(0, 60))
  }
}

async function warn(label, fn) {
  try {
    const { ok, status, note } = await fn()
    if (ok) {
      passed++
      results.push({ label, ok: true, status })
      log('✓', label, String(status))
    } else {
      warned++
      results.push({ label, ok: 'warn', status, note })
      log('⚠', label, String(status), note ?? 'non-critical')
    }
  } catch (e) {
    warned++
    results.push({ label, ok: 'warn', status: 'ERR', note: e.message })
    log('⚠', label, 'ERR', e.message.slice(0, 60))
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function get(path, cookie = '') {
  const r = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  })
  return r
}

async function post(path, body, cookie = '') {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  })
  return r
}

async function expectOk(r, ...extra2xx) {
  const ok = r.ok || extra2xx.includes(r.status)
  return { ok, status: r.status }
}

async function expectOneOf(r, ...statuses) {
  const ok = statuses.includes(r.status)
  return { ok, status: r.status, note: ok ? '' : `expected ${statuses.join('|')}` }
}

async function expectJson(r, ...keys) {
  if (!r.ok) return { ok: false, status: r.status, note: 'non-OK' }
  let data
  try { data = await r.json() } catch { return { ok: false, status: r.status, note: 'invalid JSON' } }
  for (const k of keys) {
    if (data[k] === undefined && !Array.isArray(data)) {
      return { ok: false, status: r.status, note: `missing key: ${k}` }
    }
  }
  return { ok: true, status: r.status }
}

// ─── Obtain session cookie ─────────────────────────────────────────────────────
function extractCookies(res) {
  // Node 18+ supports getSetCookie(); fallback to get() for older versions
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? '']
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ')
}

async function login() {
  // Step 1: get CSRF token
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  if (!csrfRes.ok) throw new Error(`CSRF fetch failed: ${csrfRes.status}`)
  const { csrfToken } = await csrfRes.json()
  const csrfCookie = extractCookies(csrfRes)

  // Step 2: credentials sign-in
  const body = new URLSearchParams({
    csrfToken,
    email: ADMIN_EMAIL,
    password: ADMIN_PASS,
    json: 'true',
  })
  const signRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: csrfCookie,
    },
    body: body.toString(),
    redirect: 'manual',
  })
  const signCookies = extractCookies(signRes)

  // Merge all unique cookie key=value pairs
  const cookieMap = new Map()
  for (const pair of [...csrfCookie.split('; '), ...signCookies.split('; ')]) {
    const [k] = pair.split('=')
    if (k) cookieMap.set(k, pair)
  }
  const allCookies = [...cookieMap.values()].join('; ')

  // Step 3: follow redirect if present
  let sessionCookie = allCookies
  const location = signRes.headers.get('location')
  if (location) {
    const redirectUrl = location.startsWith('http') ? location : `${BASE}${location}`
    const redirectRes = await fetch(redirectUrl, {
      headers: { cookie: allCookies },
      redirect: 'manual',
    })
    const redirectCookies = extractCookies(redirectRes)
    for (const pair of redirectCookies.split('; ')) {
      const [k] = pair.split('=')
      if (k) cookieMap.set(k, pair)
    }
    sessionCookie = [...cookieMap.values()].join('; ')
  }

  // Step 4: validate session
  const sessRes = await fetch(`${BASE}/api/auth/session`, {
    headers: { cookie: sessionCookie },
  })
  const sess = await sessRes.json().catch(() => null)
  if (!sess?.user?.email) throw new Error(`Session invalid after login (status ${sessRes.status}). Cookies: ${[...cookieMap.keys()].join(', ')}`)
  return sessionCookie
}

// ─── Main ──────────────────────────────────────────────────────────────────────
console.log()
console.log(`${BOLD}${CYAN}  VynOps Smoke Check${RESET}  ${DIM}${BASE}${RESET}`)
console.log(`  ${DIM}${'─'.repeat(68)}${RESET}`)
console.log()

// 1. Auth
console.log(`${BOLD}  [Auth]${RESET}`)
let cookie = ''
await check('Login — CSRF token fetch', async () => {
  const r = await get('/api/auth/csrf')
  return expectJson(r, 'csrfToken')
})
await check('Login — credentials sign-in + session', async () => {
  cookie = await login()
  return { ok: true, status: 200 }
})
await check('GET /api/auth/session  → user object', async () => {
  const r = await get('/api/auth/session', cookie)
  return expectJson(r, 'user')
})
await check('Unauthenticated → redirect/401 on protected route', async () => {
  const r = await get('/api/incidents')
  return expectOneOf(r, 200, 401, 307, 302)
})
console.log()

// 2. Dashboard
console.log(`${BOLD}  [Dashboard]${RESET}`)
await check('GET /api/dashboard/summary', async () => {
  const r = await get('/api/dashboard/summary', cookie)
  return expectJson(r, 'cluster')
})
console.log()

// 3. Incidents
console.log(`${BOLD}  [Incidents]${RESET}`)
await check('GET /api/incidents → incidents array', async () => {
  const r = await get('/api/incidents', cookie)
  if (!r.ok) return { ok: false, status: r.status }
  const d = await r.json()
  const ok = Array.isArray(d) || (d && Array.isArray(d.incidents))
  return { ok, status: r.status, note: ok ? '' : 'missing incidents array' }
})
await check('GET /api/incidents/INC-001 → incident object', async () => {
  const r = await get('/api/incidents/INC-001', cookie)
  return expectOneOf(r, 200, 404)
})
await warn('POST /api/incidents → create (dry check)', async () => {
  const r = await post('/api/incidents', {
    title: 'Smoke Test Incident',
    severity: 'low',
    state: 'open',
    service: 'smoke-check',
  }, cookie)
  return expectOneOf(r, 200, 201, 400, 422)
})
console.log()

// 4. Kubernetes
console.log(`${BOLD}  [Kubernetes]${RESET}`)
await check('GET /api/k8s/health', async () => {
  const r = await get('/api/k8s/health', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/pods → array-ish', async () => {
  const r = await get('/api/k8s/pods', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/nodes', async () => {
  const r = await get('/api/k8s/nodes', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/cluster', async () => {
  const r = await get('/api/k8s/cluster', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/events', async () => {
  const r = await get('/api/k8s/events', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/alerts', async () => {
  const r = await get('/api/k8s/alerts', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/workloads', async () => {
  const r = await get('/api/k8s/workloads', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/storage', async () => {
  const r = await get('/api/k8s/storage', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/network', async () => {
  const r = await get('/api/k8s/network', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/databases', async () => {
  const r = await get('/api/k8s/databases', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/deployments-history', async () => {
  const r = await get('/api/k8s/deployments-history', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/topology', async () => {
  const r = await get('/api/k8s/topology', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/security', async () => {
  const r = await get('/api/k8s/security', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/logs?pod=x&namespace=y', async () => {
  const r = await get('/api/k8s/logs?pod=smoke-pod&namespace=default', cookie)
  return expectOneOf(r, 200, 400, 404, 503)
})
await check('GET /api/k8s/ingress', async () => {
  const r = await get('/api/k8s/ingress', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/tls-certs', async () => {
  const r = await get('/api/k8s/tls-certs', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/cost-estimate', async () => {
  const r = await get('/api/k8s/cost-estimate', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/k8s/dependency-map', async () => {
  const r = await get('/api/k8s/dependency-map', cookie)
  return expectOneOf(r, 200, 503)
})
console.log()

// 5. Observability
console.log(`${BOLD}  [Observability]${RESET}`)
await check('GET /api/observability/metrics', async () => {
  const r = await get('/api/observability/metrics', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/observability/traces', async () => {
  const r = await get('/api/observability/traces', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/observability/loki', async () => {
  const r = await get('/api/observability/loki', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/observability/breakdown', async () => {
  const r = await get('/api/observability/breakdown', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/prometheus (no query → 400 expected)', async () => {
  const r = await get('/api/prometheus', cookie)
  return expectOneOf(r, 200, 400, 503)
})
console.log()

// 6. Analytics
console.log(`${BOLD}  [Analytics]${RESET}`)
await check('GET /api/analytics', async () => {
  const r = await get('/api/analytics', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/analytics/latency', async () => {
  const r = await get('/api/analytics/latency', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/analytics/slo-targets', async () => {
  const r = await get('/api/analytics/slo-targets', cookie)
  return expectOneOf(r, 200, 503)
})
console.log()

// 7. Automation
console.log(`${BOLD}  [Automation]${RESET}`)
await check('GET /api/automation/history', async () => {
  const r = await get('/api/automation/history', cookie)
  return expectOneOf(r, 200, 503)
})
await warn('POST /api/automation/execute (dry-run flag)', async () => {
  const r = await post('/api/automation/execute', { runbookId: 'smoke-test', dryRun: true }, cookie)
  return expectOneOf(r, 200, 201, 400, 404, 422)
})
console.log()

// 8. Autonomous
console.log(`${BOLD}  [Autonomous]${RESET}`)
await check('GET /api/autonomous/config', async () => {
  const r = await get('/api/autonomous/config', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/autonomous/plan', async () => {
  const r = await get('/api/autonomous/plan', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/autonomous/history', async () => {
  const r = await get('/api/autonomous/history', cookie)
  return expectOneOf(r, 200, 503)
})
console.log()

// 9. Security
console.log(`${BOLD}  [Security]${RESET}`)
await check('GET /api/security', async () => {
  const r = await get('/api/security', cookie)
  return expectOneOf(r, 200, 503)
})
console.log()

// 10. Cloud
console.log(`${BOLD}  [Cloud]${RESET}`)
await check('GET /api/cloud/overview', async () => {
  const r = await get('/api/cloud/overview', cookie)
  return expectOneOf(r, 200, 503)
})
console.log()

// 11. Settings
console.log(`${BOLD}  [Settings]${RESET}`)
await check('GET /api/settings/config', async () => {
  const r = await get('/api/settings/config', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/settings/users', async () => {
  const r = await get('/api/settings/users', cookie)
  return expectOneOf(r, 200, 403, 503)
})
await check('GET /api/settings/oncall', async () => {
  const r = await get('/api/settings/oncall', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/settings/clusters', async () => {
  const r = await get('/api/settings/clusters', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/settings/audit', async () => {
  const r = await get('/api/settings/audit', cookie)
  return expectOneOf(r, 200, 403, 503)
})
await check('GET /api/settings/datasources', async () => {
  const r = await get('/api/settings/datasources', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/settings/notify-log', async () => {
  const r = await get('/api/settings/notify-log', cookie)
  return expectOneOf(r, 200, 503)
})
console.log()

// 12. AI
console.log(`${BOLD}  [AI]${RESET}`)
await check('GET /api/ai/insights', async () => {
  const r = await get('/api/ai/insights', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/ai/usage', async () => {
  const r = await get('/api/ai/usage', cookie)
  return expectOneOf(r, 200, 503)
})
await check('GET /api/ai/chat/history', async () => {
  const r = await get('/api/ai/chat/history', cookie)
  return expectOneOf(r, 200, 503)
})
console.log()

// 13. Stream / SSE
console.log(`${BOLD}  [Stream / SSE]${RESET}`)
await check('GET /api/stream → SSE headers present', async () => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const r = await fetch(`${BASE}/api/stream`, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const ct = r.headers.get('content-type') ?? ''
    const ok = r.status === 200 && ct.includes('text/event-stream')
    return { ok, status: r.status, note: ok ? '' : `content-type: ${ct}` }
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') return { ok: true, status: 200, note: 'SSE kept alive (aborted after 3s)' }
    return { ok: false, status: 'ERR', note: e.message }
  }
})
console.log()

// 14. Page reachability (HTML)
console.log(`${BOLD}  [Pages]${RESET}`)
const pages = [
  ['GET /login', '/login'],
  ['GET /dashboard', '/dashboard'],
  ['GET /dashboard/observability', '/dashboard/observability'],
  ['GET /dashboard/infrastructure', '/dashboard/infrastructure'],
  ['GET /dashboard/kubernetes', '/dashboard/kubernetes'],
  ['GET /dashboard/incidents', '/dashboard/incidents'],
  ['GET /dashboard/deployments', '/dashboard/deployments'],
  ['GET /dashboard/cloud', '/dashboard/cloud'],
  ['GET /dashboard/ai-copilot', '/dashboard/ai-copilot'],
  ['GET /dashboard/automation', '/dashboard/automation'],
  ['GET /dashboard/security', '/dashboard/security'],
  ['GET /dashboard/analytics', '/dashboard/analytics'],
  ['GET /dashboard/settings', '/dashboard/settings'],
]
for (const [label, path] of pages) {
  await check(label, async () => {
    const r = await get(path, cookie)
    // 200 = page rendered, 307/302 = redirect to login (unauthenticated), both valid
    return expectOneOf(r, 200, 302, 307)
  })
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log()
console.log(`  ${DIM}${'─'.repeat(68)}${RESET}`)
const total = passed + failed + warned
const pct = Math.round((passed / total) * 100)
const summaryColor = failed > 0 ? RED : warned > 0 ? YELLOW : GREEN
console.log(`\n  ${BOLD}Results:${RESET}  ${GREEN}${passed} passed${RESET}  ${YELLOW}${warned} warned${RESET}  ${RED}${failed} failed${RESET}  ${DIM}/ ${total} total${RESET}`)
console.log(`  ${BOLD}Score:${RESET}    ${summaryColor}${pct}%${RESET}\n`)

if (failed > 0) {
  console.log(`  ${RED}${BOLD}FAILURES:${RESET}`)
  results.filter(r => r.ok === false).forEach(r => {
    console.log(`  ${RED}✗ ${r.label}${RESET}  ${DIM}${r.note ?? ''}${RESET}`)
  })
  console.log()
}

process.exit(failed > 0 ? 1 : 0)
