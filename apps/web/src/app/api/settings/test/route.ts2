const K8S_TIMEOUT_MS = parseInt(process.env.K8S_TIMEOUT_MS ?? '15000', 10)
import { NextResponse }                        from 'next/server'
import { auth }                                from '@/lib/auth'
import net                                      from 'net'
import { readConfig, writeConfig, appendAuditLog } from '../config/shared'

// Record a successful test to config.last_tested
function recordTestResult(action: string, ok: boolean, msg: string) {
  try {
    const cfg = readConfig()
    cfg.last_tested = cfg.last_tested ?? {}
    cfg.last_tested[action] = { ts: new Date().toISOString(), ok, msg }
    writeConfig(cfg)
  } catch { /* non-critical */ }
}

// ── Per-user rate limiter (max 10 tests/min) ────────────────────
const _testRateMap = new Map<string, { n: number; resetAt: number }>()
function checkRateLimit(email: string): boolean {
  const now = Date.now()
  const e   = _testRateMap.get(email)
  if (!e || e.resetAt < now) { _testRateMap.set(email, { n: 1, resetAt: now + 60_000 }); return true }
  if (e.n >= 10) return false
  e.n++; return true
}

// ── POST /api/settings/test ──────────────────────────────────
// body: { action: 'slack' | 'alertmanager' | 'ai', ...params }
export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userEmail = (session.user as any)?.email ?? 'anon'
  if (!checkRateLimit(userEmail)) {
    return NextResponse.json({ ok: false, error: 'Rate limit: max 10 tests per minute' }, { status: 429 })
  }

  const body = await req.json()
  const { action } = body as { action: string }

  // ── Slack ─────────────────────────────────────────────────
  if (action === 'slack') {
    const url: string = body.url ?? ''
    if (!url) return NextResponse.json({ ok: false, error: 'No webhook URL provided' })
    if (!url.startsWith('https://hooks.slack.com/')) {
      return NextResponse.json({ ok: false, error: 'Invalid Slack webhook URL format' })
    }
    try {
      const t0 = Date.now()
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: '*✅ VynOps — Slack connection verified*' } },
            { type: 'section', fields: [
              { type: 'mrkdwn', text: '*Status*\nConnected' },
              { type: 'mrkdwn', text: '*Source*\nSettings page test' },
            ]},
          ],
        }),
        signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      })
      const latencyMs = Date.now() - t0
      if (!r.ok) return NextResponse.json({ ok: false, error: `Slack returned HTTP ${r.status}` })
      recordTestResult('slack', true, `Connected · ${latencyMs}ms`)
      return NextResponse.json({ ok: true, latencyMs, message: 'Test message sent to Slack' })
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message ?? 'Unreachable' })
    }
  }

  // ── Microsoft Teams webhook ──────────────────────────────
  if (action === 'teams') {
    const url: string = body.url ?? ''
    if (!url) return NextResponse.json({ ok: false, error: 'No Teams webhook URL provided' })
    try {
      const parsedUrl = new URL(url)
      if (parsedUrl.protocol !== 'https:') {
        return NextResponse.json({ ok: false, error: 'Teams webhook URL must use HTTPS' })
      }
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid Teams webhook URL format' })
    }
    try {
      const t0 = Date.now()
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          '@type': 'MessageCard',
          '@context': 'http://schema.org/extensions',
          summary: 'VynOps Teams connection verified',
          themeColor: '22c55e',
          title: 'VynOps — Microsoft Teams connection verified',
          sections: [{ facts: [
            { name: 'Status', value: 'Connected' },
            { name: 'Source', value: 'VynOps Settings page test' },
          ] }],
        }),
        signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      })
      const latencyMs = Date.now() - t0
      if (!r.ok) return NextResponse.json({ ok: false, error: `Teams returned HTTP ${r.status}`, latencyMs })
      recordTestResult('teams', true, `Connected · ${latencyMs}ms`)
      return NextResponse.json({ ok: true, latencyMs, message: 'Test message sent to Microsoft Teams' })
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message ?? 'Unreachable' })
    }
  }

  // ── Alertmanager ──────────────────────────────────────────
  if (action === 'alertmanager') {
    const url: string = body.url ?? ''
    if (!url) return NextResponse.json({ ok: false, error: 'No Alertmanager URL provided' })
    try {
      const t0 = Date.now()
      const r = await fetch(`${url.replace(/\/$/, '')}/api/v2/status`, {
        signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
        cache: 'no-store',
      })
      const latencyMs = Date.now() - t0
      if (!r.ok) return NextResponse.json({ ok: false, error: `HTTP ${r.status}`, latencyMs })
      const data = await r.json()
      recordTestResult('alertmanager', true, `v${data.versionInfo?.version ?? '?'} · ${latencyMs}ms`)
      return NextResponse.json({
        ok: true, latencyMs,
        version: data.versionInfo?.version ?? 'unknown',
        cluster: data.cluster?.status ?? 'unknown',
      })
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message ?? 'Unreachable' })
    }
  }

  // ── Groq API key ──────────────────────────────────────────
  if (action === 'groq') {
    const apiKey: string = body.apiKey ?? ''
    const model:  string = body.model  ?? 'llama-3.3-70b-versatile'
    if (!apiKey || apiKey === '****' || apiKey.startsWith('****')) {
      return NextResponse.json({ ok: false, error: 'Provide a valid API key (not masked value)' })
    }
    try {
      const t0 = Date.now()
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      })
      const latencyMs = Date.now() - t0
      if (r.status === 401) return NextResponse.json({ ok: false, error: 'Invalid API key — unauthorized' })
      if (!r.ok) return NextResponse.json({ ok: false, error: `Groq returned HTTP ${r.status}`, latencyMs })
      const data = await r.json()
      const models: string[] = (data.data ?? []).map((m: any) => m.id)
      const modelAvailable = models.includes(model)
      return NextResponse.json({
        ok: true, latencyMs,
        modelAvailable,
        message: modelAvailable
          ? `API key valid · ${model} is available`
          : `API key valid · ${model} not found — check model ID`,
      })
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message ?? 'Unreachable' })
    }
  }

  // ── AI provider connection ───────────────────────────────
  if (action === 'ai') {
    const provider = body.provider ?? 'groq'
    const apiKey: string = body.apiKey ?? ''
    const model: string = body.model ?? ''
    const baseUrl = String(body.baseUrl ?? '').replace(/\/$/, '')
    if (!apiKey || apiKey.startsWith('****')) return NextResponse.json({ ok: false, error: 'Provide a valid API key (not masked value)' })
    if (!model) return NextResponse.json({ ok: false, error: 'Select or enter a model first' })
    const endpoints: Record<string, string> = {
      groq: 'https://api.groq.com/openai/v1/models',
      openai: 'https://api.openai.com/v1/models',
      custom: `${baseUrl}/models`,
    }
    try {
      const t0 = Date.now()
      if (provider === 'google') {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
        const latencyMs = Date.now() - t0
        if (!r.ok) return NextResponse.json({ ok: false, error: `Google returned HTTP ${r.status}`, latencyMs })
        return NextResponse.json({ ok: true, latencyMs, message: `API key valid · ${model} is available` })
      }
      if (provider === 'anthropic') {
        const r = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
        const latencyMs = Date.now() - t0
        if (!r.ok) return NextResponse.json({ ok: false, error: `Anthropic returned HTTP ${r.status}`, latencyMs })
        const models: string[] = ((await r.json()).data ?? []).map((m: any) => m.id)
        return NextResponse.json({ ok: true, latencyMs, modelAvailable: models.includes(model), message: models.includes(model) ? `API key valid · ${model} is available` : `API key valid · ${model} not found — check model ID` })
      }
      if (!endpoints[provider]) return NextResponse.json({ ok: false, error: 'Custom provider requires a base URL' })
      const r = await fetch(endpoints[provider], { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(K8S_TIMEOUT_MS) })
      const latencyMs = Date.now() - t0
      if (r.status === 401) return NextResponse.json({ ok: false, error: 'Invalid API key — unauthorized', latencyMs })
      if (!r.ok) return NextResponse.json({ ok: false, error: `${provider} returned HTTP ${r.status}`, latencyMs })
      const models: string[] = ((await r.json()).data ?? []).map((m: any) => m.id)
      return NextResponse.json({ ok: true, latencyMs, modelAvailable: models.includes(model), message: models.includes(model) ? `API key valid · ${model} is available` : `API key valid · ${model} not found — check model ID` })
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message ?? 'Unreachable' })
    }
  }

  // ── Alert Email (SMTP connection probe) ──────────────────────────────────
  if (action === 'email') {
    const email: string = body.email ?? ''
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ ok: false, error: 'Enter a valid email address first' })
    }
    const runtimeCfg = readConfig()
    // Prefer values sent directly from the form (works before Save); fall back to saved config, then env
    const smtpHost = (body.smtpHost as string | undefined)
      ?? (runtimeCfg.smtp_host !== undefined ? runtimeCfg.smtp_host : process.env.SMTP_HOST)
      ?? ''
    const smtpPort = (typeof body.smtpPort === 'number' ? body.smtpPort : undefined)
      ?? runtimeCfg.smtp_port
      ?? parseInt(process.env.SMTP_PORT ?? '587', 10)
    if (!smtpHost) {
      return NextResponse.json({
        ok: false,
        error: 'SMTP not configured — add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS to .env.local',
      })
    }
    // TCP banner probe — no email sent, just verifies server is reachable
    const banner = await new Promise<{ ok: boolean; text: string }>((resolve) => {
      const t0  = Date.now()
      const sock = net.createConnection({ host: smtpHost, port: smtpPort })
      const timer = setTimeout(() => { sock.destroy(); resolve({ ok: false, text: 'Connection timed out' }) }, 6000)
      sock.once('data', (d) => {
        clearTimeout(timer)
        sock.destroy()
        const banner = d.toString().trim().split('\n')[0]
        resolve({ ok: banner.startsWith('220'), text: banner })
      })
      sock.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: e.message }) })
    })
    if (!banner.ok) return NextResponse.json({ ok: false, error: `SMTP unreachable: ${banner.text}` })
    recordTestResult('email', true, `TCP probe OK · ${smtpHost}:${smtpPort}`)
    return NextResponse.json({
      ok: true,
      latencyMs: 0,
      message: `SMTP reachable · ${smtpHost}:${smtpPort} · ${banner.text.slice(0, 60)}`,
    })
  }

  // ── PagerDuty ─────────────────────────────────────────────
  if (action === 'pagerduty') {
    const routingKey: string = body.routingKey ?? ''
    if (!routingKey || routingKey.startsWith('****')) {
      return NextResponse.json({ ok: false, error: 'Enter the routing key first (not masked)' })
    }
    if (routingKey.length !== 32) {
      return NextResponse.json({ ok: false, error: `Routing key should be 32 chars (got ${routingKey.length})` })
    }
    const dedupKey = `vynops-test-${Date.now()}`
    try {
      const t0 = Date.now()
      // Trigger a test info event
      const triggerRes = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key:  routingKey,
          event_action: 'trigger',
          dedup_key:    dedupKey,
          payload: {
            summary:  'VynOps — settings connection test (auto-resolved)',
            severity: 'info',
            source:   'VynOps Settings',
          },
        }),
        signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      })
      if (!triggerRes.ok) {
        const d = await triggerRes.json().catch(() => ({}))
        return NextResponse.json({ ok: false, error: d.message ?? `PagerDuty returned HTTP ${triggerRes.status}` })
      }
      // Immediately resolve so no noise in PD
      await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routing_key: routingKey, event_action: 'resolve', dedup_key: dedupKey }),
        signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      })
      recordTestResult('pagerduty', true, `Event sent & resolved · ${Date.now()}ms`)
      const latencyMs = Date.now() - t0
      return NextResponse.json({ ok: true, latencyMs, message: 'Test event sent & auto-resolved in PagerDuty' })
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message ?? 'Unreachable' })
    }
  }

  // ── Generic Webhook ───────────────────────────────────────────
  if (action === 'webhook') {
    const url: string = body.url ?? ''
    if (!url) return NextResponse.json({ ok: false, error: 'No webhook URL provided' })
    try {
      new URL(url) // validate URL structure
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid URL format' })
    }
    try {
      const t0 = Date.now()
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VynOps-Event': 'test' },
        body: JSON.stringify({
          event:     'vynops.test',
          source:    'VynOps Settings',
          timestamp: new Date().toISOString(),
          payload: {
            message:  'This is a test notification from VynOps',
            severity: 'info',
          },
        }),
        signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
      })
      const latencyMs = Date.now() - t0
      if (r.status >= 200 && r.status < 300) {
        recordTestResult('webhook', true, `HTTP ${r.status} · ${latencyMs}ms`)
        return NextResponse.json({ ok: true, latencyMs, message: `Webhook accepted · HTTP ${r.status}` })
      }
      return NextResponse.json({ ok: false, error: `Endpoint returned HTTP ${r.status}`, latencyMs })
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message ?? 'Unreachable' })
    }
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 })
}
